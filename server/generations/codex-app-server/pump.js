import { randomUUID } from 'node:crypto';
import { getEffectiveWorkspaceRoot } from '../../runtime/path-access.js';
import { admitAgentCli } from '../agent-cli/admission.js';
import { agentCliToolWaitMs } from '../agent-cli/tool-wait.js';
import { safeAgentCliDiagnostic } from '../agent-cli/errors.js';
import { appendChunk, markComplete, markError, markStreaming, noteGenerationCandidateChosen } from '../store.js';
import { generationTimeoutMessage } from '../timeouts.js';
import { prepareConversation, continuation, seedConversation } from './conversation.js';
import { createCodexTranslator, allocateCodexUsage } from './translate.js';
import { codexIdentity, codexSessionKey, lockCodexChat, getCodexSession, createCodexSession,
  closeCodexSession, syncCodexCredentials, retainCodexSession } from './manager.js';

const append = (state, row) => appendChunk(state, Buffer.from(`data: ${JSON.stringify(row)}\n\n`));
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
  if (session.seen.size >= 1024 || session.pending.size >= 64 || Buffer.byteLength(JSON.stringify(p.arguments)) > 1024 * 1024) {
    failure(session, new Error('Codex tool queue exceeded its limit.')); return;
  }
  const call = { id: `call_${randomUUID().replaceAll('-', '')}`, type: 'function',
    function: { name: session.tools.get(p.tool).originalName, arguments: JSON.stringify(p.arguments) } };
  const entry = { call, tool: p.tool, arguments: call.function.arguments, requestIds: new Set([request.id]), receivedAt: performance.now() };
  session.seen.set(nativeKey, entry); session.pending.set(call.id, entry);
  const round = session.round;
  if (round && !round.finished && round.calls.length < 8) round.tool(call);
  else session.buffered.push(call);
}

/** One native turn can span multiple ordinary Minnow generation/tool rounds. */
export async function pumpCodexAppServer({ state, runtime, candidate, index, idleMs, maxMs, canFailover }) {
  const startedAt = performance.now();
  const controller = new AbortController();
  state.upstreamController = controller;
  let session, round, release, releaseAuth, unlock, maxTimer, timeoutKind, stopping;
  const key = codexSessionKey(state, candidate);
  const abort = () => {
    const current = session;
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
    let identity = await codexIdentity(runtime, workspace);
    session = getCodexSession(key);
    release = await admitAgentCli(candidate.providerId, runtime.profile.agentCli.maxConcurrent, controller.signal);
    releaseAuth = await admitAgentCli(`codex-auth:${identity.authLock}`, 1, controller.signal);
    // Login can change while queued; bind to the credentials actually admitted.
    identity = await codexIdentity(runtime, workspace);
    const prepared = prepareConversation(body, identity);
    const admittedAt = performance.now();
    let resume = session && continuation(session, prepared);
    if (session && !resume) { await closeCodexSession(session); session = null; }
    if (!session) session = await createCodexSession({ key, state, runtime, candidate, identity, prepared,
      signal: controller.signal, onEvent, onRequest });
    else await syncCodexCredentials(session, runtime);
    if (controller.signal.aborted) throw new Error('Codex request cancelled.');
    clearTimeout(session.timer); session.active = true;
    const initializedAt = performance.now();
    const baseline = { ...session.allocated };
    const metrics = { queue_ms: admittedAt - startedAt, initialization_ms: initializedAt - admittedAt, warm: !!resume };
    let resolveRound;
    const done = new Promise(resolve => { resolveRound = resolve; });
    round = {
      calls: [], content: '', reasoning: '', emitted: false, finished: false, idleTimer: null, batchTimer: null, bytes: 0,
      choose() { if (!this.emitted) { this.emitted = true; noteGenerationCandidateChosen(state, { ...candidate, index }); } },
      activity() {
        clearTimeout(this.idleTimer);
        if (idleMs > 0 && !this.calls.length) this.idleTimer = setTimeout(() => { timeoutKind = 'idle'; controller.abort(); }, idleMs);
      },
      tool(call) {
        metrics.tool_handoff_ms ??= performance.now() - initializedAt;
        clearTimeout(this.idleTimer); this.calls.push(call); this.choose();
        if (body.stream !== false) append(state, { choices: [{ index: 0, delta: { tool_calls: [{ index: this.calls.length - 1, ...call }] } }] });
        clearTimeout(this.batchTimer);
        this.batchTimer = setTimeout(() => this.finish('tool_calls'), 200);
      },
      finish(reason, error) {
        if (this.finished) return;
        this.finished = true; clearTimeout(this.idleTimer); clearTimeout(this.batchTimer);
        if (reason === 'stop' && !this.calls.length && !resume?.results && (body.tool_choice === 'required' || body.tool_choice?.function?.name)) {
          error = new Error('Codex completed without calling the required tool.');
        }
        session.round = null; session.onFailure = null;
        if (controller.signal.aborted || error) {
          const message = safeAgentCliDiagnostic(error?.message ?? 'Codex request cancelled.', session.redactionSecrets ?? Object.values(runtime.secrets ?? {}));
          if (state.status === 'cancelled') resolveRound({ outcome: 'complete' });
          else { markError(state, message); resolveRound({ outcome: 'fatal', message, hostSuspect: false }); }
          if (!controller.signal.aborted) void closeCodexSession(session).catch(() => {});
          return;
        }
        this.choose();
        const metadata = { usage: allocateCodexUsage(session.usage, baseline), minnow_cli: { timings: metrics,
          ...(session.context ? { context: session.context } : {}) } };
        session.allocated = { ...session.usage };
        if (body.stream !== false) {
          append(state, { choices: [{ index: 0, delta: {}, finish_reason: reason }], ...metadata });
          appendChunk(state, Buffer.from('data: [DONE]\n\n'));
        } else appendChunk(state, Buffer.from(JSON.stringify({ id: state.id, object: 'chat.completion', model: candidate.modelId,
          choices: [{ index: 0, message: { role: 'assistant', content: this.content || null,
            ...(this.reasoning ? { reasoning: this.reasoning } : {}), ...(this.calls.length ? { tool_calls: this.calls } : {}) }, finish_reason: reason }], ...metadata })));
        session.accepted = [...prepared.messages, { role: 'assistant', content: this.content,
          ...(this.calls.length ? { tool_calls: this.calls } : {}) }];
        session.waiting = reason === 'tool_calls'; session.handed = this.calls;
        markComplete(state);
        if (session.waiting) retainCodexSession(session, agentCliToolWaitMs(this.calls));
        else if (state.chatId) retainCodexSession(session);
        else void closeCodexSession(session).catch(() => {});
        resolveRound({ outcome: 'complete' });
      },
    };
    round.translate = createCodexTranslator(delta => {
      if (round.finished || controller.signal.aborted) return;
      if (metrics.first_delta_ms == null) metrics.first_delta_ms = performance.now() - initializedAt;
      const forwardingAt = performance.now();
      round.bytes += Buffer.byteLength(JSON.stringify(delta));
      if (round.bytes > 16 * 1024 * 1024) throw new Error('Codex output exceeded 16 MB.');
      round.content += delta.content ?? ''; round.reasoning += delta.reasoning ?? '';
      round.choose();
      if (body.stream !== false) append(state, { choices: [{ index: 0, delta }] });
      metrics.forwarding_max_ms = Math.max(metrics.forwarding_max_ms ?? 0, performance.now() - forwardingAt);
    });
    session.round = round; session.onFailure = error => round.finish('error', error);
    markStreaming(state); round.activity();
    if (resume?.results) {
      session.waiting = false;
      for (const call of session.handed) {
        const entry = session.pending.get(call.id);
        if (!entry) throw new Error('Codex tool handoff was lost; execution results are retained in Minnow.');
        entry.response = { contentItems: [{ type: 'inputText', text: resume.results.get(call.id) }], success: true };
        session.pending.delete(call.id);
        metrics.tool_wait_ms = Math.max(metrics.tool_wait_ms ?? 0, performance.now() - entry.receivedAt);
        const returnStartedAt = performance.now();
        for (const id of entry.requestIds) await session.rpc.respond(id, entry.response);
        metrics.tool_return_ms = Math.max(metrics.tool_return_ms ?? 0, performance.now() - returnStartedAt);
      }
      session.handed = [];
      for (const call of session.buffered.splice(0, 8)) round.tool(call);
    } else {
      session.context = undefined;
      const seed = resume ? { items: [], input: resume.input } : seedConversation(prepared);
      if (seed.items.length) await session.rpc.request('thread/inject_items', { threadId: session.threadId, items: seed.items }, { signal: controller.signal });
      session.starting = true;
      const effort = { off: 'low', none: 'low', minimal: 'minimal', max: 'xhigh' }[body.reasoning_effort] ?? body.reasoning_effort;
      const outputSchema = body.response_format?.json_schema?.schema ?? (body.response_format?.type === 'json_object' ? { type: 'object', additionalProperties: true } : undefined);
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
    if (!round?.emitted && canFailover && !session?.turnId) return { outcome: 'retry', message, retrySameCandidate: false, hostSuspect: false };
    markError(state, message); return { outcome: 'fatal', message, hostSuspect: false };
  } finally {
    clearTimeout(maxTimer); controller.signal.removeEventListener('abort', abort);
    await stopping;
    if (session && !session.closed) await session.syncAuth?.().catch(() => {});
    releaseAuth?.(); release?.(); unlock?.();
    if (state.upstreamController === controller) state.upstreamController = null;
  }
}
