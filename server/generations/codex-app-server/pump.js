import { randomUUID } from 'node:crypto';
import { getEffectiveWorkspaceRoot } from '../../runtime/path-access.js';
import { admitAgentCli } from '../agent-cli/admission.js';
import { agentCliToolWaitMs } from '../agent-cli/tool-wait.js';
import { classifyAgentCliFailure, safeAgentCliDiagnostic } from '../agent-cli/errors.js';
import { appendChunk, markComplete, markError, markStreaming, noteGenerationCandidateChosen } from '../store.js';
import { generationTimeoutMessage } from '../timeouts.js';
import { prepareConversation, continuation, seedConversation } from './conversation.js';
import { createCodexTranslator, allocateCodexUsage } from './translate.js';
import { codexIdentity, codexSessionKey, lockCodexChat, getCodexSession, createCodexSession,
  closeCodexSession, syncCodexCredentials, retainCodexSession, dirtyCodexSession, checkpointCodexSession } from './manager.js';
import { updateAgentCliSessionOutput } from '../agent-cli/output.js';
import { withCliTurnContext } from '../agent-cli/conversation.js';
import { CODEX_READ_BATCH, expandCodexReadBatch } from './read-batch.js';
import { isParallelSafeTool } from '../../runner/parallel-tool-policy.js';

const append = (state, row) => appendChunk(state, Buffer.from(`data: ${JSON.stringify(row)}\n\n`));
const MAX_HANDOFF_CALLS = 8;
const HANDOFF_QUIET_MS = 200;
const HANDOFF_MAX_MS = 1000;
function failure(session, error) { session.round?.finish('error', error); void closeCodexSession(session).catch(() => {}); }
function onEvent(session, event) {
  const p = event.params ?? {};
  if (p.threadId !== session.threadId || session.closed) return;
  if (event.method === 'turn/started' && session.starting) { session.turnId = p.turn.id; session.starting = false; }
  if (p.turnId && p.turnId !== session.turnId) return;
  if (event.method === 'turn/completed' && p.turn.id !== session.turnId) return;
  if (event.method === 'thread/tokenUsage/updated') {
    session.usage = p.tokenUsage.total;
    session.context = { used: p.tokenUsage.last?.totalTokens, input: p.tokenUsage.last?.inputTokens,
      limit: p.tokenUsage.modelContextWindow };
    return;
  }
  if (event.method === 'item/started' && p.item.type === 'contextCompaction') {
    failure(session, new Error('Context length exceeded: Codex requested native compaction. Minnow must compact its recorded context and retry.'));
    return;
  }
  if (['item/started', 'item/completed'].includes(event.method)
    && !['userMessage', 'agentMessage', 'reasoning', 'dynamicToolCall', 'functionCallOutput'].includes(p.item?.type)) {
    failure(session, new Error(`Codex attempted an unsupported native item (${p.item?.type}).`)); return;
  }
  const round = session.round;
  if (!round || round.finished) {
    if (['item/agentMessage/delta', 'turn/completed'].includes(event.method)) failure(session, new Error('Codex produced output while awaiting Minnow tool results.'));
    return;
  }
  try {
    if (event.method.startsWith('item/') || event.method === 'turn/started') round.activity();
    round.translate(event);
    if (event.method === 'turn/completed') {
      if (p.turn.status === 'completed') round.finish('stop');
      else round.finish('error', new Error(p.turn.error?.message ?? `Codex turn ${p.turn.status}.`));
    }
    if (event.method === 'error' && !p.willRetry) round.finish('error', new Error(p.error?.message ?? 'Codex model error.'));
  } catch (error) { failure(session, error); }
}
function onRequest(session, request) {
  const p = request.params ?? {};
  if (session.closed) return;
  if (request.method !== 'item/tool/call' || p.threadId !== session.threadId || p.turnId !== session.turnId
    || !session.tools.has(p.tool) || p.namespace != null || typeof p.callId !== 'string'
    || !p.arguments || typeof p.arguments !== 'object' || Array.isArray(p.arguments)) {
    void session.rpc.respond(request.id, null, { code: -32601, message: 'Only exposed Minnow tools are allowed.' }).catch(() => {});
    failure(session, new Error('Codex requested an unexposed tool or native permission.')); return;
  }
  const nativeKey = `${p.turnId}\0${p.callId}`;
  const existing = session.seen.get(nativeKey);
  if (existing) {
    if (existing.tool !== p.tool || existing.arguments !== JSON.stringify(p.arguments)) {
      failure(session, new Error('Codex reused a tool call ID with different arguments.')); return;
    }
    existing.requestIds.add(request.id);
    if (existing.response) void session.rpc.respond(request.id, existing.response).catch(error => failure(session, error));
    return;
  }
  if (session.seen.size >= 1024 || Buffer.byteLength(JSON.stringify(p.arguments)) > 1024 * 1024) {
    failure(session, new Error('Codex tool queue exceeded its limit.')); return;
  }
  const group = { tool: p.tool, arguments: JSON.stringify(p.arguments), requestIds: new Set([request.id]),
    calls: [], results: new Map(), receivedAt: performance.now() };
  session.seen.set(nativeKey, group);
  let functions;
  try { functions = p.tool === CODEX_READ_BATCH ? expandCodexReadBatch(p.arguments, session.tools)
    : [{ name: session.tools.get(p.tool).originalName, arguments: JSON.stringify(p.arguments) }]; }
  catch (error) {
    // Invalid model arguments are a tool failure, not a broken transport. No
    // member has been dispatched; let Codex correct the batch or call separately.
    group.response = { success: false, contentItems: [{ type: 'inputText',
      text: `Error: ${error.message} No calls were executed. Use only the read-only tool names in mn_read_batch's schema, or call the supplied Minnow tools separately.` }] };
    session.round?.activity();
    void session.rpc.respond(request.id, group.response).catch(error => failure(session, error));
    return;
  }
  if (session.pending.size + functions.length > 64) {
    failure(session, new Error('Codex tool queue exceeded its limit.')); return;
  }
  for (const fn of functions) {
    const call = { id: `call_${randomUUID().replaceAll('-', '')}`, type: 'function', function: fn };
    group.calls.push(call);
    session.pending.set(call.id, { call, group, receivedAt: group.receivedAt });
    const round = session.round;
    if (round && !round.finished && round.calls.length < MAX_HANDOFF_CALLS) round.tool(call);
    else session.buffered.push(call);
  }
}

/** One native turn can span multiple ordinary Minnow generation/tool rounds. */
export async function pumpCodexAppServer({ state, runtime, candidate, index, idleMs, maxMs, canFailover }) {
  const startedAt = performance.now();
  const controller = new AbortController();
  state.upstreamController = controller;
  let session, round, release, unlock, maxTimer, timeoutKind, stopping;
  const key = codexSessionKey(state, candidate);
  const abort = () => {
    const current = session;
    if (current) void dirtyCodexSession(current).catch(() => {});
    if (current?.turnId && current.rpc) {
      stopping = current.rpc.request('turn/interrupt', { threadId: current.threadId, turnId: current.turnId }, { timeoutMs: 1000 })
        .catch(() => {}).finally(() => closeCodexSession(current).catch(() => {}));
    } else stopping = closeCodexSession(current).catch(() => {});
    queueMicrotask(() => round?.finish('error', new Error(timeoutKind
      ? generationTimeoutMessage({ idleMs, maxMs }, timeoutKind) : 'Codex request cancelled.')));
  };
  controller.signal.addEventListener('abort', abort, { once: true });
  if (maxMs > 0) maxTimer = setTimeout(() => { timeoutKind = 'max'; controller.abort(); }, maxMs);
  try {
    unlock = lockCodexChat(key);
    const body = JSON.parse(state.requestBody.toString('utf8')); body.model = candidate.modelId;
    const workspace = getEffectiveWorkspaceRoot();
    session = getCodexSession(key);
    release = await admitAgentCli(candidate.providerId, runtime.profile.agentCli.maxConcurrent, controller.signal);
    // Login can change while queued; bind to the credentials actually admitted.
    const identity = await codexIdentity(runtime, workspace);
    const prepared = prepareConversation(body, identity);
    const admittedAt = performance.now();
    let resume = session && continuation(session, prepared);
    if (session && !resume) { await closeCodexSession(session); session = null; }
    if (!session) {
      try { session = await createCodexSession({ key, state, runtime, candidate, identity, prepared,
        signal: controller.signal, onEvent, onRequest }); }
      catch (error) {
        if (!error.cliResumeRejected || controller.signal.aborted) throw error;
        // Resume preflight runs no inference. Rebuild once from canonical
        // history when the native store was missing or modified.
        session = await createCodexSession({ key, state, runtime, candidate, identity, prepared,
          signal: controller.signal, onEvent, onRequest });
        session.method = 'rebuilt'; session.reason = 'Saved native history failed verification.';
      }
    } else await syncCodexCredentials(session, runtime);
    if (session.restoredInput) { resume = { input: session.restoredInput }; session.restoredInput = null; }
    else if (resume) session.method = 'reused';
    if (controller.signal.aborted) throw new Error('Codex request cancelled.');
    clearTimeout(session.timer); session.active = true;
    updateAgentCliSessionOutput(session.capture, { sessionState: 'active', continuation: session.method });
    const initializedAt = performance.now();
    const baseline = { ...session.allocated };
    const metrics = { queue_ms: admittedAt - startedAt, initialization_ms: initializedAt - admittedAt, warm: session.method === 'reused' };
    let resolveRound;
    const done = new Promise(resolve => { resolveRound = resolve; });
    round = {
      calls: [], content: '', reasoning: '', emitted: false, finished: false, idleTimer: null, batchTimer: null, batchStartedAt: null, handoffReady: false, bytes: 0,
      choose() { if (!this.emitted) { this.emitted = true; noteGenerationCandidateChosen(state, { ...candidate, index }); } },
      activity() {
        clearTimeout(this.idleTimer);
        if (this.calls.length) this.scheduleHandoff();
        if (idleMs > 0 && !this.calls.length) this.idleTimer = setTimeout(() => { timeoutKind = 'idle'; controller.abort(); }, idleMs);
      },
      scheduleHandoff() {
        if (this.finished) return;
        clearTimeout(this.batchTimer);
        // Native code-mode can still be emitting a group after the first call.
        // Activity extends collection, but never beyond the bounded deadline.
        const remaining = HANDOFF_MAX_MS - (performance.now() - this.batchStartedAt);
        const delay = this.handoffReady || this.calls.length >= MAX_HANDOFF_CALLS ? 0 : Math.max(0, Math.min(HANDOFF_QUIET_MS, remaining));
        this.batchTimer = setTimeout(() => this.finish('tool_calls'), delay);
      },
      tool(call) {
        metrics.tool_handoff_ms ??= performance.now() - initializedAt;
        this.batchStartedAt ??= performance.now();
        // Complete read batches and sequential tools need no collection window.
        this.handoffReady ||= session.pending.get(call.id)?.group.tool === CODEX_READ_BATCH
          || !isParallelSafeTool(call.function.name);
        clearTimeout(this.idleTimer); this.calls.push(call); this.choose();
        if (body.stream !== false) append(state, { choices: [{ index: 0, delta: { tool_calls: [{ index: this.calls.length - 1, ...call }] } }] });
        this.scheduleHandoff();
      },
      async finish(reason, error) {
        if (this.finished) return;
        this.finished = true; clearTimeout(this.idleTimer); clearTimeout(this.batchTimer);
        if (this.calls.length) {
          metrics.tool_batch_count = this.calls.length;
          metrics.tool_batch_collect_ms = performance.now() - this.batchStartedAt;
        }
        if (reason === 'stop' && !this.calls.length && !resume?.results && (body.tool_choice === 'required' || body.tool_choice?.function?.name)) {
          error = new Error('Codex completed without calling the required tool.');
        }
        session.round = null; session.onFailure = null;
        if (controller.signal.aborted || error) {
          const message = safeAgentCliDiagnostic(error?.message ?? 'Codex request cancelled.', session.redactionSecrets ?? Object.values(runtime.secrets ?? {}));
          if (state.status === 'cancelled') resolveRound({ outcome: 'complete' });
          else {
            const classified = classifyAgentCliFailure({ error });
            markError(state, message, classified);
            resolveRound({ outcome: 'fatal', message, hostSuspect: false, quotaExceeded: classified.quotaExceeded, failure: classified.failure });
          }
          if (!controller.signal.aborted) void closeCodexSession(session).catch(() => {});
          return;
        }
        this.choose();
        const metadata = { usage: allocateCodexUsage(session.usage, baseline), minnow_cli: { timings: metrics, continuation: session.method, transport: 'app-server',
          ...(session.context ? { context: session.context } : {}) } };
        updateAgentCliSessionOutput(session.capture, { usage: metadata.usage });
        session.allocated = { ...session.usage };
        const completeGeneration = () => { if (body.stream !== false) {
          append(state, { choices: [{ index: 0, delta: {}, finish_reason: reason }], ...metadata });
          appendChunk(state, Buffer.from('data: [DONE]\n\n'));
        } else appendChunk(state, Buffer.from(JSON.stringify({ id: state.id, object: 'chat.completion', model: candidate.modelId,
          choices: [{ index: 0, message: { role: 'assistant', content: this.content || null,
            ...(this.reasoning ? { reasoning: this.reasoning, ...(this.reasoningFormat ? { reasoning_format: this.reasoningFormat } : {}) } : {}),
            ...(this.calls.length ? { tool_calls: this.calls } : {}) }, finish_reason: reason }], ...metadata }))); };
        session.accepted = [...prepared.messages, { role: 'assistant', content: this.content.trim(),
          ...(this.calls.length ? { tool_calls: this.calls } : {}) }];
        session.waiting = reason === 'tool_calls'; session.handed = this.calls;
        if (!session.waiting && !session.closed) {
          try { await checkpointCodexSession(session); }
          catch { session.clean = false; updateAgentCliSessionOutput(session.capture, { reason: 'Native session snapshot unavailable; restart will rebuild.' }); }
        }
        if (controller.signal.aborted || session.closed) {
          if (!controller.signal.aborted && state.status !== 'cancelled') { completeGeneration(); markComplete(state); }
          resolveRound({ outcome: 'complete' }); return;
        }
        // Anonymous requests cannot resume this handoff on their next generation.
        if (!state.chatId) await closeCodexSession(session).catch(() => {});
        else if (session.waiting) retainCodexSession(session, agentCliToolWaitMs(this.calls));
        else retainCodexSession(session);
        completeGeneration(); markComplete(state);
        resolveRound({ outcome: 'complete' });
      },
    };
    round.translate = createCodexTranslator((delta, reasoningFormat) => {
      if (round.finished || controller.signal.aborted) return;
      if (metrics.first_delta_ms == null) metrics.first_delta_ms = performance.now() - initializedAt;
      const forwardingAt = performance.now();
      round.bytes += Buffer.byteLength(JSON.stringify(delta));
      if (round.bytes > 16 * 1024 * 1024) throw new Error('Codex output exceeded 16 MB.');
      round.content += delta.content ?? ''; round.reasoning += delta.reasoning ?? '';
      if (reasoningFormat) { delta.reasoning_format = reasoningFormat; round.reasoningFormat = reasoningFormat; }
      round.choose();
      if (body.stream !== false) append(state, { choices: [{ index: 0, delta }] });
      metrics.forwarding_max_ms = Math.max(metrics.forwarding_max_ms ?? 0, performance.now() - forwardingAt);
    });
    session.round = round; session.onFailure = error => round.finish('error', error);
    await dirtyCodexSession(session);
    markStreaming(state); round.activity();
    if (resume?.results) {
      session.waiting = false;
      for (const call of session.handed) {
        const entry = session.pending.get(call.id);
        if (!entry) throw new Error('Codex tool handoff was lost; execution results are retained in Minnow.');
        const group = entry.group;
        group.results.set(call.id, resume.results.get(call.id));
        session.pending.delete(call.id);
        metrics.tool_wait_ms = Math.max(metrics.tool_wait_ms ?? 0, performance.now() - entry.receivedAt);
        if (group.results.size !== group.calls.length) continue;
        const contentItems = group.tool === CODEX_READ_BATCH
          ? group.calls.flatMap((member, index) => [{ type: 'inputText', text: JSON.stringify({ index,
            name: member.function.name, content: group.results.get(member.id).filter(item => item.type === 'inputText').map(item => item.text).join('\n') }) },
            ...group.results.get(member.id).filter(item => item.type !== 'inputText')])
          : group.results.get(call.id);
        group.response = { contentItems, success: true };
        const returnStartedAt = performance.now();
        for (const id of group.requestIds) await session.rpc.respond(id, group.response);
        metrics.tool_return_ms = Math.max(metrics.tool_return_ms ?? 0, performance.now() - returnStartedAt);
      }
      session.handed = [];
      for (const call of session.buffered.splice(0, MAX_HANDOFF_CALLS)) round.tool(call);
    } else {
      session.context = undefined;
      const seed = resume ? { items: [], input: resume.input } : seedConversation(prepared);
      if (body.minnow_cli_turn_context) {
        if (seed.input[0]?.type !== 'text') seed.input.unshift({ type: 'text', text: '' });
        seed.input[0] = { ...seed.input[0], text: withCliTurnContext(seed.input[0].text, body.minnow_cli_turn_context) };
      }
      if (seed.items.length) await session.rpc.request('thread/inject_items', { threadId: session.threadId, items: seed.items }, { signal: controller.signal });
      session.starting = true;
      const effort = { off: 'low', none: 'low', minimal: 'minimal', max: 'xhigh' }[body.reasoning_effort] ?? body.reasoning_effort;
      const outputSchema = body.response_format?.json_schema?.schema ?? (body.response_format?.type === 'json_object' ? { type: 'object', additionalProperties: true } : undefined);
      session.inferenceStarted = true;
      const started = await session.rpc.request('turn/start', { threadId: session.threadId, input: seed.input,
        ...(effort ? { effort } : {}), ...(outputSchema ? { outputSchema } : {}) }, { signal: controller.signal });
      session.turnId = started.turn.id; session.starting = false;
    }
    return await done;
  } catch (error) {
    await closeCodexSession(session).catch(() => {});
    if (state.status === 'cancelled') return { outcome: 'complete' };
    const message = safeAgentCliDiagnostic(timeoutKind ? generationTimeoutMessage({ idleMs, maxMs }, timeoutKind) : error.message,
      session?.redactionSecrets ?? Object.values(runtime.secrets ?? {}));
    if (!round?.emitted && canFailover && !session?.inferenceStarted) return { outcome: 'retry', message, retrySameCandidate: false, hostSuspect: false };
    markError(state, message); return { outcome: 'fatal', message, hostSuspect: false };
  } finally {
    clearTimeout(maxTimer); controller.signal.removeEventListener('abort', abort);
    await stopping;
    if (session && !session.closed) await session.syncAuth?.().catch(() => {});
    release?.(); unlock?.();
    if (state.upstreamController === controller) state.upstreamController = null;
  }
}
