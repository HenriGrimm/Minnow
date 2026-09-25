import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
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
import { beginAgentCliOutput, appendAgentCliOutput, endAgentCliOutput } from './output.js';

const sessions = new Map();
const HANDOFF_QUIET_MS = 200;
const WAIT_FOR_TOOLS_MS = 5 * 60_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
let prepareInvocation = prepareAgentCliInvocation;
let spawn = spawnAgentCli;

export function __setAgentCliSessionMocksForTests(mocks = {}) {
  prepareInvocation = mocks.prepareInvocation ?? prepareAgentCliInvocation;
  spawn = mocks.spawn ?? spawnAgentCli;
}
export async function __resetAgentCliSessionMocksForTests() {
  prepareInvocation = prepareAgentCliInvocation;
  spawn = spawnAgentCli;
  await Promise.all([...sessions.values()].map(closeSession));
}

function sessionKey(state, candidate) { return `${candidate.providerId}\0${state.chatId}`; }
function append(state, payload) { appendChunk(state, Buffer.from(`data: ${JSON.stringify(payload)}\n\n`, 'utf8')); }
function signature(body) {
  return JSON.stringify({ model: body.model, tools: body.tools, tool_choice: body.tool_choice,
    reasoning_effort: body.reasoning_effort, response_format: body.response_format,
    max_budget_usd: body.max_budget_usd });
}
function roundUsage(round, fallback, kind) {
  if (kind !== 'claude' || !round.rawUsage.length) return fallback;
  const total = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let cached = 0;
  for (const raw of round.rawUsage) {
    const usage = mapAgentCliUsage(raw, kind);
    total.prompt_tokens += usage.prompt_tokens;
    total.completion_tokens += usage.completion_tokens;
    total.total_tokens += usage.total_tokens;
    cached += usage.prompt_tokens_details?.cached_tokens ?? 0;
  }
  if (cached) total.prompt_tokens_details = { cached_tokens: cached };
  return total;
}
function mergeUsage(target, source) {
  for (const [key, value] of Object.entries(source ?? {})) {
    if (typeof value === 'number' && Number.isFinite(value)) target[key] = Math.max(target[key] ?? 0, value);
  }
}
function canResume(session, body) {
  if (!session.waiting || session.closed || session.signature !== signature(body)) return false;
  const before = session.messages;
  const after = body.messages;
  if (!Array.isArray(after) || after.length < before.length + 2) return false;
  if (JSON.stringify(after.slice(0, before.length)) !== JSON.stringify(before)) return false;
  const appended = after.slice(before.length);
  const assistant = appended[0];
  if (assistant?.role !== 'assistant' || !Array.isArray(assistant.tool_calls)
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

async function createSession({ key, state, runtime, candidate, body, settings, controller }) {
  const kind = settings.kind === 'cursor-agent' ? 'cursor' : settings.kind;
  const session = { key, messages: body.messages, signature: signature(body), calls: [], waiting: false,
    kind,
    closed: false, active: null, outputBytes: 0, release: null, tempDir: null, bridge: null,
    invocation: null, processRun: null, timer: null, decoder: null, exit: null, capture: null,
    chatId: state.chatId, providerId: candidate.providerId, modelId: candidate.modelId,
    secretValues: Object.values(runtime.secrets ?? {}).filter(value => typeof value === 'string') };
  try {
    session.release = await admitAgentCli(candidate.providerId, settings.maxConcurrent, controller.signal);
    if (controller.signal.aborted) throw new Error('Agent CLI request cancelled.');
    const replay = buildAgentCliPrompt(body, kind);
    const root = join(getMinnowHome(), 'tmp', 'agent-cli');
    await mkdir(root, { recursive: true, mode: 0o700 });
    session.tempDir = await mkdtemp(join(root, 'session-'));
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
    session.invocation = await prepareInvocation({
      kind: settings.kind, profile: settings, body: { ...body, agentCliImages: replay.images },
      tempDir: session.tempDir, prompt: replay.prompt, systemPrompt: replay.systemPrompt,
      bridgeConfig: session.bridge.config, secrets: runtime.secrets,
    });
    for (const [name, value] of Object.entries(session.invocation.env ?? {})) {
      if (/(?:token|api_?key|password|authorization)/i.test(name) && typeof value === 'string') session.secretValues.push(value);
    }
    session.decoder = createJsonlDecoder({ onEvent: event => {
      const round = session.active;
      if (!round) return;
      const part = event.type === 'stream_event' ? event.event : null;
      if (kind === 'claude') {
        if (part?.type === 'message_start') round.rawUsage.push({ ...part.message?.usage });
        if (part?.type === 'message_delta' && round.rawUsage.length) mergeUsage(round.rawUsage.at(-1), part.usage);
        if (event.type === 'assistant' && event.message?.usage && round.rawUsage.length) mergeUsage(round.rawUsage.at(-1), event.message.usage);
      }
      // Claude's terminal usage totals the entire CLI run; count streaming
      // requests by round. Codex and Cursor report their run once at the end.
      round.translator.consume(kind === 'claude' && event.type === 'result' ? { ...event, usage: undefined } : event);
    } });
    sessions.set(key, session);
    return session;
  } catch (error) {
    await closeSession(session);
    throw error;
  }
}

async function closeSession(session) {
  if (session.closePromise) return session.closePromise;
  session.closed = true;
  clearTimeout(session.timer);
  if (sessions.get(session.key) === session) sessions.delete(session.key);
  session.closePromise = (async () => {
    await session.processRun?.stop().catch(() => {});
    endAgentCliOutput(session.capture, session.exit?.code);
    await session.bridge?.close().catch(() => {});
    await session.invocation?.cleanup?.().catch(() => {});
    if (session.tempDir) await rm(session.tempDir, { recursive: true, force: true }).catch(() => {});
    session.release?.();
  })();
  return session.closePromise;
}

function startProcess(session) {
  session.capture = beginAgentCliOutput(session.chatId, session.providerId, session.modelId, session.secretValues);
  session.processRun = spawn(session.invocation);
  session.processRun.child.stdout.on('data', chunk => {
    appendAgentCliOutput(session.capture, chunk);
    const round = session.active;
    if (!round || round.finished) return;
    try {
      session.outputBytes += chunk.length;
      if (session.outputBytes > MAX_OUTPUT_BYTES) throw new Error('Agent CLI output exceeded 16 MB.');
      round.rearmIdle();
      session.decoder.write(chunk);
    } catch (error) {
      round.failure = error;
      void closeSession(session);
    }
  });
  session.processRun.child.stderr?.on('data', chunk => appendAgentCliOutput(session.capture, chunk, 'stderr'));
  session.processRun.done.then(exit => {
    session.exit = exit;
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
  try {
    const body = JSON.parse(state.requestBody.toString('utf8'));
    body.model = candidate.modelId;
    if (body.n != null && body.n !== 1) throw new Error('Agent CLI supports one response per request.');
    const key = sessionKey(state, candidate);
    session = sessions.get(key);
    if (session?.active) throw new Error('Agent CLI session is already running for this chat.');
    if (session && !canResume(session, body)) { await closeSession(session); session = null; }
    if (!session) session = await createSession({ key, state, runtime, candidate, body, settings, controller });
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
      finish(kind) {
        if (this.finished) return;
        this.finished = true;
        clearTimeout(this.idleTimer); clearTimeout(this.maxTimer); clearTimeout(this.handoffTimer);
        const snapshot = this.translator.snapshot();
        const usage = roundUsage(this, snapshot.usage, session.kind);
        const metadata = { ...(usage ? { usage } : {}),
          ...(snapshot.cost != null ? { minnow_cli: { cost_usd: snapshot.cost } } : {}) };
        let outcome;
        if (state.status === 'cancelled') outcome = { outcome: 'complete' };
        else {
          const error = this.timeoutKind ? new Error(generationTimeoutMessage({ idleMs, maxMs }, this.timeoutKind))
            : controller.signal.aborted ? new Error('Agent CLI request cancelled.') : this.failure;
          const classified = kind === 'exit' && this.calls.length === 0 && !error
            ? classifyAgentCliFailure({ terminal: snapshot.terminal, exitCode: session.exit?.code,
              stderr: safeAgentCliDiagnostic(session.exit?.stderr ?? '', session.secretValues) }) : null;
          const interruptedHandoff = kind === 'exit' && this.calls.length > 0
            ? 'Agent CLI exited before Minnow could return the tool result.' : null;
          const requiredMissing = kind === 'exit' && this.calls.length === 0
            && (body.tool_choice === 'required' || body.tool_choice?.function?.name)
            ? 'Agent CLI completed without calling the required tool.' : null;
          const message = error?.message ?? classified?.message ?? interruptedHandoff ?? requiredMissing;
          if (message) {
            const safe = safeAgentCliDiagnostic(message, session.secretValues);
            if (!this.emitted && canFailover) outcome = { outcome: 'retry', message: safe, retrySameCandidate: false, hostSuspect: false };
            else { markError(state, safe); outcome = { outcome: 'fatal', message: safe, hostSuspect: false }; }
          } else {
            this.choose();
            const reason = kind === 'handoff' ? 'tool_calls' : snapshot.terminal?.finishReason ?? 'stop';
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
            outcome = { outcome: 'complete' };
          }
        }
        session.active = null;
        if (kind === 'handoff' && outcome.outcome === 'complete' && state.status === 'complete') {
          session.waiting = true;
          session.messages = body.messages;
          session.calls = this.calls;
          session.timer = setTimeout(() => void closeSession(session), WAIT_FOR_TOOLS_MS);
          session.release?.();
          session.release = null;
        } else void closeSession(session);
        resolveRound(outcome);
      },
    };
    round.translator = createAgentCliTranslator(session.kind, delta => {
      if (round.finished || controller.signal.aborted || round.calls.length) return;
      if (delta.forbiddenTool) { round.failure = new Error(`Agent CLI attempted a native tool (${delta.forbiddenTool}).`); void closeSession(session); return; }
      if (delta.content) round.content += delta.content;
      if (delta.reasoning) round.reasoning += delta.reasoning;
      if (body.stream !== false) {
        round.choose();
        append(state, delta.activity ? { choices: [{ index: 0, delta: {} }], minnow_agent_cli: delta.activity }
          : { choices: [{ index: 0, delta }] });
      }
    });
    session.active = round;
    session.waiting = false;
    controller.signal.addEventListener('abort', () => {
      void closeSession(session);
      // store.cancel() marks the generation cancelled immediately after abort().
      queueMicrotask(() => round.finish('exit'));
    }, { once: true });
    if (maxMs > 0) round.maxTimer = setTimeout(() => { round.timeoutKind = 'max'; controller.abort(); }, maxMs);
    round.rearmIdle();
    markStreaming(state);
    if (!session.processRun) startProcess(session);
    else {
      const appended = body.messages.slice(session.messages.length);
      const results = new Map(appended.filter(row => row.role === 'tool').map(row => [row.tool_call_id, row.content]));
      session.bridge.resetBatch();
      for (const call of session.calls) {
        if (!session.bridge.resolveCall(call.id, results.get(call.id))) throw new Error('Agent CLI tool handoff was lost.');
      }
    }
    return await complete;
  } catch (error) {
    if (session && (!session.active || session.active === round)) await closeSession(session);
    if (round?.finished) return { outcome: 'complete' };
    if (state.status === 'cancelled') return { outcome: 'complete' };
    const message = safeAgentCliDiagnostic(error.message, session?.secretValues ?? Object.values(runtime.secrets ?? {}));
    if (!round?.emitted && canFailover) return { outcome: 'retry', message, retrySameCandidate: false, hostSuspect: false };
    markError(state, message);
    return { outcome: 'fatal', message, hostSuspect: false };
  } finally {
    if (session && !session.waiting) await closeSession(session);
    if (state.upstreamController === controller) state.upstreamController = null;
  }
}
