import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getMinnowHome } from '../../config/home.js';
import { appendChunk, markComplete, markError, markStreaming, noteGenerationCandidateChosen } from '../store.js';
import { generationTimeoutMessage } from '../timeouts.js';
import { admitAgentCli } from './admission.js';
import { buildAgentCliToolCatalog, createAgentCliBridge } from './bridge.js';
import { createJsonlDecoder } from './jsonl.js';
import { buildAgentCliPrompt } from './prompt.js';
import { createAgentCliTranslator, mapAgentCliUsage } from './translate.js';
import { classifyAgentCliFailure, safeAgentCliDiagnostic } from './errors.js';
import { prepareAgentCliInvocation } from './invocation.js';
import { spawnAgentCli } from './spawn.js';
import { beginAgentCliOutput, appendAgentCliOutput, endAgentCliOutput, updateAgentCliSessionOutput } from './output.js';
import { agentCliToolWaitMs } from './tool-wait.js';
import { registerCliDisposal, reserveCliProcess, retainCliSession, noteCliCapability, createCliSessionPool, lockCliChat } from './lifecycle.js';
import { cliHash, cliCacheDir, readCliCheckpoint, queueCliCheckpoint, checkpointMatches, removeCliCache } from './checkpoints.js';
import { canonicalCliMessages, cliContinuation, cliRebuildReason, withCliTurnContext } from './conversation.js';
import { agentCliIdentity, snapshotClaudeSession, verifyClaudeSnapshot, verifyClaudeContinuation, removeOwnedClaudeTranscript } from './claude-state.js';
import { openCursorAcp } from './cursor-acp.js';

const closing = new Set();
const sessions = createCliSessionPool('stream-json', closing, closeSession);
const HANDOFF_QUIET_MS = 200;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
let prepareInvocation = prepareAgentCliInvocation;
let spawn = spawnAgentCli;
export function agentCliSessionIsMocked() { return prepareInvocation !== prepareAgentCliInvocation || spawn !== spawnAgentCli; }

export function __setAgentCliSessionMocksForTests(mocks = {}) {
  prepareInvocation = mocks.prepareInvocation ?? prepareAgentCliInvocation;
  spawn = mocks.spawn ?? spawnAgentCli;
}
export async function __resetAgentCliSessionMocksForTests() {
  prepareInvocation = prepareAgentCliInvocation;
  spawn = spawnAgentCli;
  await Promise.all([...sessions.values()].map(closeSession));
}

function sessionKey(state, candidate) { return `${candidate.providerId}\0${state.chatId || randomUUID()}`; }
function append(state, payload) { appendChunk(state, Buffer.from(`data: ${JSON.stringify(payload)}\n\n`, 'utf8')); }
function signature(body, identity) {
  return cliHash({ identity, systems: canonicalCliMessages(body.messages).filter(row => ['system', 'developer'].includes(row.role)), model: body.model, tools: body.tools, tool_choice: body.tool_choice,
    reasoning_effort: body.reasoning_effort, response_format: body.response_format,
    max_budget_usd: body.max_budget_usd });
}
function roundUsage(round, fallback, kind) {
  if (kind !== 'claude' || !round.rawUsage.length) return fallback;
  const total = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let cached = 0;
  let uncached = 0, created = 0;
  const available = new Set();
  let measured = false;
  for (const raw of round.rawUsage) {
    const usage = mapAgentCliUsage(raw, kind);
    if (!usage) continue;
    measured = true;
    total.prompt_tokens += usage.prompt_tokens;
    total.completion_tokens += usage.completion_tokens;
    total.total_tokens += usage.total_tokens;
    cached += usage.prompt_tokens_details?.cached_tokens ?? 0;
    uncached += usage.prompt_tokens_details?.uncached_tokens ?? 0;
    created += usage.prompt_tokens_details?.cache_creation_tokens ?? 0;
    for (const name of Object.keys(usage.prompt_tokens_details ?? {})) available.add(name);
  }
  if (!measured) return fallback;
  total.prompt_tokens_details = { ...(available.has('cached_tokens') ? { cached_tokens: cached } : {}),
    ...(available.has('uncached_tokens') ? { uncached_tokens: uncached } : {}),
    ...(available.has('cache_creation_tokens') ? { cache_creation_tokens: created } : {}) };
  return total;
}
function mergeUsage(target, source) {
  for (const [key, value] of Object.entries(source ?? {})) {
    if (typeof value === 'number' && Number.isFinite(value)) target[key] = Math.max(target[key] ?? 0, value);
  }
}
function canResume(session, body) {
  if (session.closed) return false;
  const before = session.messages;
  const after = canonicalCliMessages(body.messages);
  if (!session.waiting) return session.invocation.keepStdinOpen && Boolean(cliContinuation(before, after));
  if (!Array.isArray(after) || after.length < before.length + 2) return false;
  if (JSON.stringify(after.slice(0, before.length)) !== JSON.stringify(before)) return false;
  const appended = after.slice(before.length);
  const assistant = appended[0];
  if (assistant?.role !== 'assistant' || !Array.isArray(assistant.tool_calls)
    || (assistant.content ?? '') !== (session.handoffContent ?? '')
    || assistant.tool_calls.length !== session.calls.length
    || !session.calls.every((call, index) => {
      const next = assistant.tool_calls[index];
      return next?.id === call.id && next?.function?.name === call.function.name
        && next?.function?.arguments === call.function.arguments;
    })) return false;
  if (appended.length !== session.calls.length + 1 || appended.slice(1).some(row => row.role !== 'tool')) return false;
  const results = new Map(appended.filter(row => row.role === 'tool').map(row => [row.tool_call_id, row.content]));
  return session.calls.every(call => typeof results.get(call.id) === 'string');
}

async function createSession({ key, state, runtime, candidate, body, settings, controller, identity, fingerprint, method }) {
  await Promise.all([...closing].filter(row => row.key === key).map(row => row.closePromise));
  const kind = settings.kind === 'cursor-agent' ? 'cursor' : settings.kind;
  const session = { key, messages: canonicalCliMessages(body.messages), signature: fingerprint, identity, calls: [], waiting: false,
    kind,
    closed: false, active: null, outputBytes: 0, release: null, tempDir: null, bridge: null,
    invocation: null, processRun: null, timer: null, decoder: null, exit: null, capture: null, originalTools: body.tools ?? [],
    chatId: state.chatId, providerId: candidate.providerId, modelId: candidate.modelId,
    workspace: identity.workspace, contextWindowTokens: settings.contextWindowTokens,
    nativeId: randomUUID(), lastCost: 0, method: method || 'new', clean: false, seenMessages: new Set(), seenResults: new Set(),
    secretValues: Object.values(runtime.secrets ?? {}).filter(value => typeof value === 'string') };
  try {
    session.release = await admitAgentCli(candidate.providerId, settings.maxConcurrent, controller.signal);
    if (controller.signal.aborted) throw new Error('Agent CLI request cancelled.');
    const replay = buildAgentCliPrompt(body, kind);
    session.cacheDir = cliCacheDir(candidate.providerId, state.chatId);
    const persistent = Boolean(state.chatId) && ['claude', 'cursor'].includes(kind) && process.env.MINNOW_AGENT_CLI_REPLAY !== '1';
    const acp = kind === 'cursor' && persistent && !agentCliSessionIsMocked();
    let saved = persistent ? await readCliCheckpoint(candidate.providerId, state.chatId) : null;
    if (saved && checkpointMatches(saved, fingerprint, session.messages)
      && (kind === 'claude' ? saved.adapter === 'claude-stream-json-v1' && await verifyClaudeSnapshot(saved) : saved.adapter === 'cursor-acp-v1')) {
      // Claude reports cumulative spend for this process, even on disk resume.
      // Restored conversation spend must not be subtracted from a fresh run.
      session.resume = saved; session.nativeId = saved.nativeId; session.method = 'resumed';
      if (kind === 'claude' && saved.nativeBytes) session.nativeVerifiedPrefix = { bytes: saved.nativeBytes, digest: saved.nativeDigest };
      for (const id of (saved.seenMessages ?? []).slice(-256)) session.seenMessages.add(id);
      for (const id of (saved.seenResults ?? []).slice(-32)) session.seenResults.add(id);
    } else if (saved) { session.method = 'rebuilt'; session.reason = 'Saved conversation did not match current history or configuration.'; }
    else if (session.messages.some(row => row.role === 'assistant' || row.role === 'tool')) {
      session.method = 'rebuilt'; session.reason = 'Saved native conversation unavailable.';
    }
    if (persistent && !session.resume) await removeCliCache(session.cacheDir);
    if (persistent) {
      session.tempDir = join(session.cacheDir, 'work');
      await mkdir(session.tempDir, { recursive: true, mode: 0o700 });
    } else {
      const root = join(getMinnowHome(), 'tmp', 'agent-cli');
      await mkdir(root, { recursive: true, mode: 0o700 });
      session.tempDir = await mkdtemp(join(root, 'session-'));
    }
    session.persistent = persistent;
    session.bridge = await createAgentCliBridge({
      tools: buildAgentCliToolCatalog(body), tempDir: session.tempDir,
      onCall: call => {
        const round = session.active;
        if (!round || round.finished || round.controller.signal.aborted) return;
        const index = round.calls.push(call) - 1;
        round.choose();
        if (round.body.stream !== false) append(round.state, { choices: [{ index: 0, delta: { tool_calls: [{ index, ...call }] } }] });
        clearTimeout(round.handoffTimer);
        round.handoffTimer = setTimeout(() => round.finish('handoff'), HANDOFF_QUIET_MS);
      },
    });
    session.secretValues.push(session.bridge.config.env.MINNOW_CLI_BRIDGE_TOKEN);
    const newMessages = session.resume ? session.messages.slice(saved.acceptedCount) : session.messages;
    const newPrompt = session.resume ? buildAgentCliPrompt({ ...body, messages: newMessages }, kind) : replay;
    session.invocation = await prepareInvocation({
      kind: settings.kind, profile: settings, body: { ...body, agentCliImages: newPrompt.images },
      tempDir: session.tempDir,
      prompt: session.resume ? newPrompt.prompt : replay.prompt,
      systemPrompt: replay.systemPrompt,
      ...(persistent && kind === 'claude' ? { sessionId: session.nativeId } : {}),
      acp,
      ...(session.resume && kind === 'claude' ? { resumeId: join(session.cacheDir, `${session.nativeId}.jsonl`) } : {}),
      bridgeConfig: session.bridge.config, secrets: runtime.secrets,
    });
    session.transport = session.invocation.transport ?? 'stream-json';
    session.secretValues.push(...(session.invocation.redactionSecrets ?? []));
    if (session.transport === 'acp') {
      try {
        session.processRun = await openCursorAcp(session.invocation, { tools: buildAgentCliToolCatalog(body), saved: session.resume,
          signal: controller.signal, onNativeData: chunk => appendAgentCliOutput(session.capture, chunk) });
        session.nativeId = session.processRun.nativeId;
        session.method = session.processRun.method === 'new' && session.method === 'rebuilt' ? 'rebuilt' : session.processRun.method;
        if (session.method !== 'resumed') session.resume = null;
      } catch (error) {
        if (error.cliTerminationUnconfirmed) { session.processRun = error.cliProcessRun; throw error; }
        if (controller.signal.aborted) throw error;
        // No prompt has been sent. The isolated print adapter remains the
        // compatibility path when ACP's preflight contract is unavailable.
        session.persistent = false; session.resume = null; session.method = 'rebuilt';
        session.reason = `Cursor ACP unavailable: ${safeAgentCliDiagnostic(error.message, session.secretValues)} Using isolated replay.`;
        await session.invocation.cleanup?.();
        session.invocation = await prepareInvocation({ kind: settings.kind, profile: settings, body,
          tempDir: session.tempDir, prompt: replay.prompt, systemPrompt: replay.systemPrompt,
          bridgeConfig: session.bridge.config, secrets: runtime.secrets });
        session.transport = 'replay';
      }
    }
    for (const [name, value] of Object.entries(session.invocation.env ?? {})) {
      if (/(?:token|api_?key|password|authorization)/i.test(name) && typeof value === 'string') session.secretValues.push(value);
    }
    noteCliCapability(session.providerId, { transport: session.transport, restartResumeSupported: session.persistent, fallbackReason: session.reason });
    session.decoder = createJsonlDecoder({ onEvent: event => {
      const round = session.active;
      if (!round || round.finished) return;
      if (event.type === 'system' && event.subtype === 'init' && /^[a-f0-9-]{36}$/i.test(event.session_id ?? '')) session.nativeId = event.session_id;
      if (event.type === 'system' && event.subtype === 'compact_boundary') {
        round.failure = new Error('Context length exceeded: native compaction is disabled. Minnow must compact its recorded context and retry.');
        void closeSession(session); return;
      }
      const part = event.type === 'stream_event' ? event.event : null;
      if (kind === 'claude') {
        if (event.type === 'result' && event.uuid) {
          if (session.seenResults.has(event.uuid)) return;
          session.seenResults.add(event.uuid);
          while (session.seenResults.size > 1024) session.seenResults.delete(session.seenResults.values().next().value);
        }
        if (part?.type === 'message_start') {
          round.ignoreNativeMessage = Boolean(part.message?.id && session.seenMessages.has(part.message.id));
          if (round.ignoreNativeMessage) return;
          round.nativeMessageId = part.message?.id;
          if (part.message?.id) session.seenMessages.add(part.message.id);
          while (session.seenMessages.size > 4096) session.seenMessages.delete(session.seenMessages.values().next().value);
          round.rawUsage.push({ ...part.message?.usage });
        }
        if (part && round.ignoreNativeMessage) return;
        if (event.type === 'assistant' && event.message?.id && event.message.id !== round.nativeMessageId && session.seenMessages.has(event.message.id)) return;
        if (event.type === 'assistant' && event.message?.id) round.completedNativeMessageId = event.message.id;
        if (part?.type === 'message_delta' && round.rawUsage.length) mergeUsage(round.rawUsage.at(-1), part.usage);
        if (event.type === 'assistant' && event.message?.usage && round.rawUsage.length) mergeUsage(round.rawUsage.at(-1), event.message.usage);
      }
      // Claude's terminal usage totals the entire CLI run; count streaming
      // requests by round. Codex and Cursor report their run once at the end.
      round.translator.consume(kind === 'claude' && event.type === 'result' ? { ...event, usage: undefined } : event);
      if (event.type === 'result' && session.invocation.keepStdinOpen) void round.finish('result');
    } });
    sessions.set(key, session);
    return session;
  } catch (error) {
    await closeSession(session);
    throw error;
  }
}

async function closeSession(session, { forget = false } = {}) {
  if (!session) return;
  if (session.closePromise) return session.closePromise;
  session.closed = true;
  closing.add(session);
  clearTimeout(session.timer);
  if (sessions.get(session.key) === session) sessions.delete(session.key);
  session.closePromise = (async () => {
    await session.processRun?.stop().catch(() => {});
    const child = session.processRun?.child;
    if (child?.pid && child.exitCode == null && child.signalCode == null) {
      // Preserve both the private files and process reservation until exit is
      // confirmed. A replacement must never race a still-running native CLI.
      session.terminationUnconfirmed = true; session.clean = false; session.cleanRecord = null;
      if (session.persistent) await queueCliCheckpoint(session, { providerId: session.providerId, chatId: session.chatId,
        fingerprint: session.signature, nativeId: session.nativeId, clean: false }).catch(() => {});
      if (session.active) session.active.failure = new Error('CLI process did not exit after termination.');
      session.active?.finish('exit');
      await session.bridge?.close().catch(() => {});
      session.release?.(); session.release = null;
      updateAgentCliSessionOutput(session.capture, { sessionState: 'closed', reason: 'CLI process termination could not be confirmed.' });
      void session.processRun.done.then(() => {
        if (!session.terminationUnconfirmed) return;
        session.terminationUnconfirmed = false; session.closePromise = null;
        void closeSession(session, { forget }).catch(() => {});
      }).catch(() => {});
      return;
    }
    session.active?.finish('exit');
    endAgentCliOutput(session.capture, session.exit?.code);
    await session.bridge?.close().catch(() => {});
    await session.invocation?.cleanup?.().catch(() => {});
    await session.checkpointWrite?.catch(() => {});
    if (session.clean && session.cleanRecord && session.kind === 'claude' && !forget) {
      const nativeDigest = await snapshotClaudeSession(session, { allowClosed: true }).catch(() => null);
      await queueCliCheckpoint(session, { ...session.cleanRecord, nativeDigest,
        nativeBytes: session.nativeVerifiedPrefix?.bytes, clean: Boolean(nativeDigest) });
    }
    if (session.persistent && session.kind === 'claude') await removeOwnedClaudeTranscript(session).catch(() => {});
    if (forget && session.cacheDir) {
      await removeCliCache(session.cacheDir);
    }
    if (session.tempDir) await rm(session.tempDir, { recursive: true, force: true }).catch(() => {});
    session.release?.();
    if (!session.processRun?.child?.pid || session.processRun.child.exitCode != null || session.processRun.child.signalCode != null) closing.delete(session);
  })();
  return session.closePromise;
}

function startProcess(session) {
  session.capture = beginAgentCliOutput(session.chatId, session.providerId, session.modelId, session.secretValues);
  updateAgentCliSessionOutput(session.capture, { sessionState: 'active', transport: session.transport, restartResumeSupported: session.persistent,
    continuation: session.method, reason: session.reason });
  session.processRun ??= spawn(session.invocation);
  if (session.kind === 'claude') {
    try { session.lastNativeInput = JSON.parse(session.invocation.stdin).message.content; } catch { /* Test adapters may use a plain prompt. */ }
  }
  session.started = true;
  session.processRun.child.stdout.on('data', chunk => {
    if (session.transport !== 'acp') appendAgentCliOutput(session.capture, chunk);
    const round = session.active;
    try {
      if (round && !round.finished) {
        session.outputBytes += chunk.length;
        if (session.outputBytes > MAX_OUTPUT_BYTES) throw new Error('Agent CLI output exceeded 16 MB.');
        round.rearmIdle();
      }
      session.decoder.write(chunk);
    } catch (error) {
      if (round && !round.finished) round.failure = error;
      void closeSession(session);
    }
  });
  session.processRun.child.stderr?.on('data', chunk => appendAgentCliOutput(session.capture, chunk, 'stderr'));
  session.processRun.done.then(exit => {
    session.exit = exit;
    if (session.terminationUnconfirmed) { session.terminationUnconfirmed = false; session.closePromise = null; }
    endAgentCliOutput(session.capture, exit.code);
    try { session.decoder.end(); } catch (error) { if (session.active) session.active.failure = error; }
    session.active?.finish('exit');
    if (!session.active) void closeSession(session);
  }, error => {
    if (session.active) { session.active.failure = error; session.active.finish('exit'); }
    else void closeSession(session);
  });
}

/** Keep one native CLI process across Minnow tool rounds. */
export async function pumpAgentCliSession({ state, runtime, candidate, index, idleMs, maxMs, canFailover }) {
  const settings = runtime.profile.agentCli ?? {};
  const controller = new AbortController();
  state.upstreamController = controller;
  let session;
  let round;
  let unlock;
  let maxTimer, maxExpired = false;
  if (maxMs > 0) maxTimer = setTimeout(() => { maxExpired = true; if (round) round.timeoutKind = 'max'; controller.abort(); }, maxMs);
  try {
    const body = JSON.parse(state.requestBody.toString('utf8'));
    body.model = candidate.modelId;
    if (body.n != null && body.n !== 1) throw new Error('Agent CLI supports one response per request.');
    const key = sessionKey(state, candidate);
    unlock = lockCliChat(key);
    const identity = agentCliSessionIsMocked() ? { workspace: '', settings, account: cliHash(runtime.secrets ?? {}), configRoot: process.env.CLAUDE_CONFIG_DIR }
      : await agentCliIdentity(settings, runtime.secrets);
    const fingerprint = signature(body, identity);
    session = sessions.get(key);
    if (session?.active) throw new Error('Agent CLI session is already running for this chat.');
    const waiting = session?.waiting;
    const budget = Number(settings.maxBudgetUsd) > 0 || Number(body.max_budget_usd) > 0;
    const nativeMatches = !session || waiting || (session.kind === 'claude' && session.clean
      ? await verifyClaudeContinuation(session)
      : session.kind !== 'cursor' || !session.clean || session.processRun.digest() === session.cleanRecord?.nativeDigest);
    let rebuildReason;
    if (session && (!nativeMatches || session.signature !== fingerprint || !canResume(session, body) || budget && !waiting)) {
      if (!nativeMatches) rebuildReason = 'Saved native history failed verification.';
      else if (session.signature !== fingerprint || !canResume(session, body)) rebuildReason = cliRebuildReason(session, body, identity);
      await closeSession(session); session = null;
    }
    if (!session) {
      const allocation = await admitAgentCli(`cli-allocation:${candidate.providerId}`, 1, controller.signal);
      try {
        await reserveCliProcess(sessions, closing, candidate.providerId, settings.maxConcurrent, closeSession);
        if ([...closing].some(row => row.key === key && row.terminationUnconfirmed)) throw new Error('Previous CLI process has not exited; retry after it closes.');
        session = await createSession({ key, state, runtime, candidate, body, settings, controller, identity, fingerprint });
        if (rebuildReason) { session.method = 'rebuilt'; session.reason = rebuildReason; }
      } finally { allocation(); }
    } else { session.method = 'reused'; updateAgentCliSessionOutput(session.capture, { sessionState: 'active', continuation: 'reused' }); }
    clearTimeout(session.timer);
    if (!session.release) session.release = await admitAgentCli(candidate.providerId, settings.maxConcurrent, controller.signal);
    let resolveRound;
    const complete = new Promise(resolve => { resolveRound = resolve; });
    round = {
      state, body, controller, calls: [], finished: false, failure: null, idleTimer: null,
      maxTimer: null, handoffTimer: null, timeoutKind: null, emitted: false, content: '', reasoning: '', rawUsage: [],
      choose() {
        if (this.emitted) return;
        this.emitted = true;
        noteGenerationCandidateChosen(state, { providerId: candidate.providerId, modelId: candidate.modelId, index });
      },
      rearmIdle() {
        clearTimeout(this.idleTimer);
        if (idleMs > 0) this.idleTimer = setTimeout(() => { this.timeoutKind = 'idle'; controller.abort(); }, idleMs);
      },
      async finish(kind) {
        if (this.finished) return;
        this.finished = true;
        clearTimeout(this.idleTimer); clearTimeout(this.maxTimer); clearTimeout(this.handoffTimer);
        const snapshot = this.translator.snapshot();
        const usage = roundUsage(this, snapshot.usage, session.kind);
        // A result can price several requests spanning earlier tool handoffs.
        // Do not attribute that whole turn's cost to this final generation.
        const reportedCost = snapshot.cost != null ? Math.max(0, snapshot.cost - session.lastCost) : undefined;
        const metadata = { ...(usage ? { usage } : {}),
          minnow_cli: { continuation: session.method, transport: session.transport,
            ...(reportedCost != null ? { [session.unallocatedCost ? 'native_turn_cost_usd' : 'cost_usd']: reportedCost } : {}) } };
        if (kind === 'handoff' && snapshot.cost == null) session.unallocatedCost = true;
        if (kind === 'result' && snapshot.cost != null) session.unallocatedCost = false;
        if (snapshot.cost != null) session.lastCost = snapshot.cost;
        updateAgentCliSessionOutput(session.capture, { usage, costUsd: metadata.minnow_cli.cost_usd, nativeTurnCostUsd: metadata.minnow_cli.native_turn_cost_usd });
        let outcome;
        let completeGeneration;
        if (state.status === 'cancelled') outcome = { outcome: 'complete' };
        else {
          const error = this.timeoutKind ? new Error(generationTimeoutMessage({ idleMs, maxMs }, this.timeoutKind))
            : controller.signal.aborted ? new Error('Agent CLI request cancelled.') : this.failure;
          const classified = ['exit', 'result'].includes(kind) && this.calls.length === 0 && !error
            ? classifyAgentCliFailure({ terminal: snapshot.terminal, exitCode: session.exit?.code,
              stderr: safeAgentCliDiagnostic(session.exit?.stderr ?? '', session.secretValues) }) : null;
          const interruptedHandoff = kind === 'exit' && this.calls.length > 0
            ? 'Agent CLI exited before Minnow could return the tool result.' : null;
          const requiredMissing = ['exit', 'result'].includes(kind) && this.calls.length === 0
            && (body.tool_choice === 'required' || body.tool_choice?.function?.name)
            ? 'Agent CLI completed without calling the required tool.' : null;
          const message = error?.message ?? classified?.message ?? interruptedHandoff ?? requiredMissing;
          if (message) {
            const safe = safeAgentCliDiagnostic(message, session.secretValues);
            if (!this.emitted && !session.inferenceStarted && canFailover) outcome = { outcome: 'retry', message: safe, retrySameCandidate: false, hostSuspect: false };
            else { markError(state, safe); outcome = { outcome: 'fatal', message: safe, hostSuspect: false }; }
          } else {
            this.choose();
            const reason = kind === 'handoff' ? 'tool_calls' : snapshot.terminal?.finishReason ?? 'stop';
            completeGeneration = () => {
            if (body.stream !== false) {
              append(state, { choices: [{ index: 0, delta: {}, finish_reason: reason }], ...metadata });
              appendChunk(state, Buffer.from('data: [DONE]\n\n'));
            } else {
              appendChunk(state, Buffer.from(JSON.stringify({ id: state.id, object: 'chat.completion', model: candidate.modelId,
                choices: [{ index: 0, message: { role: 'assistant', content: this.content || null,
                  ...(this.reasoning ? { reasoning: this.reasoning } : {}),
                  ...(this.calls.length ? { tool_calls: this.calls } : {}) }, finish_reason: reason }], ...metadata })));
            }
            markComplete(state);
            };
            outcome = { outcome: 'complete' };
          }
        }
        session.active = null;
        if (kind === 'handoff' && completeGeneration && !controller.signal.aborted) {
          session.waiting = true;
          session.messages = canonicalCliMessages(body.messages);
          session.calls = this.calls;
          session.handoffContent = this.content;
          updateAgentCliSessionOutput(session.capture, { sessionState: 'awaiting-tools' });
          retainCliSession(session, sessions, closeSession, agentCliToolWaitMs(this.calls));
          session.release?.();
          session.release = null;
        } else if (kind === 'result' && completeGeneration && !controller.signal.aborted && session.invocation.keepStdinOpen && state.chatId && !session.closed) {
          session.messages = [...canonicalCliMessages(body.messages), { role: 'assistant', content: this.content }];
          session.calls = []; session.waiting = false;
          try {
            session.completedText = this.content;
            session.completedNativeMessageId = this.nativeMessageId ?? this.completedNativeMessageId;
            const nativeDigest = session.kind === 'claude' ? await snapshotClaudeSession(session) : session.processRun.digest();
            if (session.closed || controller.signal.aborted) {
              if (!controller.signal.aborted && state.status !== 'cancelled') completeGeneration();
              resolveRound({ outcome: 'complete' }); return;
            }
            session.clean = Boolean(nativeDigest);
            session.cleanRecord = { providerId: session.providerId, chatId: session.chatId, workspace: session.workspace,
              adapter: session.kind === 'claude' ? 'claude-stream-json-v1' : 'cursor-acp-v1', fingerprint: session.signature, clean: session.clean,
              acceptedCount: session.messages.length, acceptedHash: cliHash(session.messages), nativeId: session.nativeId,
              nativeDigest, costBaseline: session.lastCost };
            session.cleanRecord.nativeBytes = session.nativeVerifiedPrefix?.bytes;
            session.cleanRecord.seenMessages = [...session.seenMessages].slice(-256);
            session.cleanRecord.seenResults = [...session.seenResults].slice(-32);
            await queueCliCheckpoint(session, session.cleanRecord);
          } catch { session.clean = false; session.reason = 'Native session snapshot unavailable; restart will rebuild.'; }
          session.release?.(); session.release = null;
          updateAgentCliSessionOutput(session.capture, { sessionState: 'idle', restartResumeSupported: session.clean, reason: session.reason });
          retainCliSession(session, sessions, closeSession);
        } else void closeSession(session);
        if (!controller.signal.aborted && state.status !== 'cancelled') completeGeneration?.();
        resolveRound(outcome);
      },
    };
    round.translator = createAgentCliTranslator(session.kind, delta => {
      if (round.finished || controller.signal.aborted) return;
      if (delta.forbiddenTool) { round.failure = new Error(`Agent CLI attempted a native tool (${delta.forbiddenTool}).`); void closeSession(session); return; }
      if (round.calls.length) return;
      if (delta.content) round.content += delta.content;
      if (delta.reasoning) round.reasoning += delta.reasoning;
      if (body.stream !== false) {
        round.choose();
        append(state, delta.activity ? { choices: [{ index: 0, delta: {} }], minnow_agent_cli: delta.activity }
          : { choices: [{ index: 0, delta }] });
      }
    });
    session.active = round;
    session.outputBytes = 0;
    session.waiting = false;
    controller.signal.addEventListener('abort', () => {
      session.clean = false; session.cleanRecord = null;
      if (session.persistent) void queueCliCheckpoint(session, { providerId: session.providerId, chatId: session.chatId,
        fingerprint: session.signature, nativeId: session.nativeId, clean: false }).catch(() => {});
      void closeSession(session);
      // store.cancel() marks the generation cancelled immediately after abort().
      queueMicrotask(() => round.finish('exit'));
    }, { once: true });
    round.maxTimer = maxTimer;
    round.rearmIdle();
    markStreaming(state);
    session.clean = false; session.cleanRecord = null;
    if (session.persistent) await queueCliCheckpoint(session, { providerId: session.providerId, chatId: session.chatId,
      workspace: session.workspace, fingerprint: session.signature, clean: false, nativeId: session.nativeId });
    if (!session.started) {
      session.inferenceStarted = true;
      startProcess(session);
      if (session.transport === 'acp') {
        const appended = session.resume ? canonicalCliMessages(body.messages).slice(session.resume.acceptedCount) : null;
        const replay = buildAgentCliPrompt(body, session.kind);
        const text = appended ? buildAgentCliPrompt({ ...body, messages: appended }, session.kind).prompt : `${replay.systemPrompt}\n\n${replay.prompt}`;
        await session.processRun.send(text, controller.signal);
      }
    }
    else if (waiting) {
      session.inferenceStarted = true;
      const appended = body.messages.slice(session.messages.length);
      const results = new Map(appended.filter(row => row.role === 'tool').map(row => [row.tool_call_id, row.content]));
      session.bridge.resetBatch();
      for (const call of session.calls) {
        if (!session.bridge.resolveCall(call.id, results.get(call.id))) throw new Error('Agent CLI tool handoff was lost.');
      }
    } else {
      session.inferenceStarted = true;
      const appended = canonicalCliMessages(body.messages).slice(session.messages.length);
      const replay = buildAgentCliPrompt({ ...body, messages: appended }, session.kind);
      const text = withCliTurnContext(appended.map(row => Array.isArray(row.content) ? row.content.filter(part => part.type === 'text').map(part => part.text).join('\n') : row.content).join('\n\n'), body.minnow_cli_turn_context);
      const content = replay.images?.length ? [{ type: 'text', text }, ...replay.images] : text;
      session.lastNativeInput = content;
      if (session.transport === 'acp') await session.processRun.send(content, controller.signal);
      else await new Promise((resolve, reject) => session.processRun.child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`, error => error ? reject(error) : resolve()));
    }
    return await complete;
  } catch (error) {
    if (session && (!session.active || session.active === round)) await closeSession(session);
    if (round?.finished) return { outcome: 'complete' };
    if (state.status === 'cancelled') return { outcome: 'complete' };
    const message = safeAgentCliDiagnostic(maxExpired ? generationTimeoutMessage({ idleMs, maxMs }, 'max') : error.message, session?.secretValues ?? Object.values(runtime.secrets ?? {}));
    if (!round?.emitted && !session?.inferenceStarted && canFailover) return { outcome: 'retry', message, retrySameCandidate: false, hostSuspect: false };
    markError(state, message);
    return { outcome: 'fatal', message, hostSuspect: false };
  } finally {
    clearTimeout(maxTimer);
    if (session && !session.waiting && (!session.invocation?.keepStdinOpen || session.closed || state.status !== 'complete')) await closeSession(session);
    unlock?.();
    if (state.upstreamController === controller) state.upstreamController = null;
  }
}

registerCliDisposal('stream-json', async (filter, options) => {
  await Promise.all([...sessions.values(), ...closing].filter(filter).map(session => closeSession(session, options)));
});
