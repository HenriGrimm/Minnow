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
  closeCodexSession, syncCodexCredentials, retainCodexSession, dirtyCodexSession, checkpointCodexSession,
  quarantineCodexSession, codexNativeRecoveryError } from './manager.js';
import { updateAgentCliSessionOutput } from '../agent-cli/output.js';
import { withCliTurnContext } from '../agent-cli/conversation.js';
import { CODEX_READ_BATCH, expandCodexReadBatch } from './read-batch.js';
import { isParallelSafeTool } from '../../runner/parallel-tool-policy.js';
import { appendDiagnosticEntry } from '../../diagnostics/ring-log.js';
import { assertMinnowToolMode, isMinnowCodexItem } from '../../models/agent-cli-native.js';
import { assertCodexNativeExecution, isCodexCodingItem, nativeMeta, queueNativeRecord, nativeApproval, pauseNativeTurn } from './native.js';
import { getNativeExecutionContext } from '../native-execution-context.js';

const append = (state, row) => appendChunk(state, Buffer.from(`data: ${JSON.stringify(row)}\n\n`));
const MAX_HANDOFF_CALLS = 8;
const HANDOFF_QUIET_MS = 200;
const HANDOFF_MAX_MS = 1000;
function failure(session, error) {
  if (session.nativePolicy) void quarantineCodexSession(session).catch(() => {});
  session.round?.finish('error', error); void closeCodexSession(session).catch(() => {});
}
function onEvent(session, event) {
  const p = event.params ?? {};
  if (p.threadId !== session.threadId || session.closed) return;
  if (event.method === 'turn/started' && session.starting) { session.turnId = p.turn.id; session.starting = false; }
  if (p.turnId && p.turnId !== session.turnId) return;
  if (event.method === 'turn/completed' && p.turn.id !== session.turnId) return;
  if (event.method === 'turn/completed' && session.nativePause) {
    session.nativePause.resolve(p.turn); return;
  }
  if (event.method === 'thread/tokenUsage/updated') {
    session.usage = p.tokenUsage.total;
    session.lastRequestUsage = allocateCodexUsage(p.tokenUsage.last);
    session.context = { used: p.tokenUsage.last?.totalTokens, input: p.tokenUsage.last?.inputTokens,
      limit: p.tokenUsage.modelContextWindow };
    return;
  }
  if (event.method === 'item/started' && p.item.type === 'contextCompaction') {
    failure(session, new Error('Context length exceeded: Codex requested native compaction. Minnow must compact its recorded context and retry.'));
    return;
  }
  if (session.nativePolicy && ['item/started', 'item/completed'].includes(event.method) && isCodexCodingItem(p.item)) {
    if (!session.round || session.round.finished && !session.nativePause) { void quarantineCodexSession(session).catch(() => {}); failure(session, codexNativeRecoveryError()); return; }
    if (session.nativeSeen?.has(p.turnId + '\0' + p.item.id + '\0' + event.method)) {
      try { void queueNativeRecord(session, event).catch(error => failure(session, error)); }
      catch (error) { failure(session, error); }
      return;
    }
    if (event.method === 'item/completed' && p.item.type === 'commandExecution' && p.item.exitCode == null && !session.nativePause) {
      failure(session, new Error('Native background commands are not supported. Stop and reconcile this command.')); return;
    }
    session.nativeActive ??= new Set();
    if (event.method === 'item/started') session.nativeActive.add(p.item.id);
    else session.nativeActive.delete(p.item.id);
    try { void queueNativeRecord(session, event).catch(error => failure(session, error)); }
    catch (error) { failure(session, error); }
    session.round.activity(); return;
  }
  if (session.nativePolicy && event.method === 'item/commandExecution/outputDelta') { session.round?.activity(); return; }
  if (['item/started', 'item/completed'].includes(event.method)
    && !isMinnowCodexItem(p.item)) {
    // Notifications observe, not admit: the action may already have run.
    void quarantineCodexSession(session).catch(() => {});
    failure(session, codexNativeRecoveryError()); return;
  }
  const round = session.round;
  const itemId = p.itemId ?? p.item?.id;
  if (itemId && (['agentMessage', 'reasoning'].includes(p.item?.type) || p.itemId)) {
    session.itemOrigins ??= new Map();
    const owner = session.itemOrigins.get(itemId);
    if (owner && owner.generationId !== round?.generationId && event.method === 'item/completed') {
      // A native item may settle after its Minnow tool handoff. Its text belongs
      // to the earlier round; never replay that snapshot into this generation.
      if (!owner.diagnosed && p.item.type === 'agentMessage' && typeof p.item.text === 'string' && p.item.text !== owner.text) {
        owner.diagnosed = true;
        session.rebuild = true;
        void dirtyCodexSession(session).catch(() => {});
        void appendDiagnosticEntry({ source: 'server', kind: 'codex-snapshot-divergence',
          message: 'Late Codex prose snapshot; native session will rebuild at the next handoff.',
          extra: { chatId: session.chatId, generationId: owner.generationId, previousLength: owner.text.length, snapshotLength: p.item.text.length } });
      }
      return;
    }
    if (round) {
      const entry = owner ?? { generationId: round.generationId, text: '' };
      if (event.method === 'item/agentMessage/delta') entry.text += p.delta ?? '';
      if (event.method === 'item/completed' && p.item.type === 'agentMessage' && typeof p.item.text === 'string'
        && !entry.text.startsWith(p.item.text)) entry.text = p.item.text;
      session.itemOrigins.set(itemId, entry);
    }
  }
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
  if (session.nativePolicy && request.method !== 'item/tool/call') {
    if (!['item/fileChange/requestApproval', 'item/commandExecution/requestApproval'].includes(request.method)) {
      void session.rpc.respond(request.id, null, { code: -32601, message: 'Unsupported native request.' }).catch(() => {});
      failure(session, new Error('Codex requested an unsupported native capability.')); return;
    }
    return nativeApproval(session, request).then(decision => session.rpc.respond(request.id, { decision }))
      .catch(error => { failure(session, error); });
  }
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
  const group = { tool: p.tool, nativeCallId: p.callId, arguments: JSON.stringify(p.arguments), requestIds: new Set([request.id]),
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

/** Authority comes only from the server WeakMap, never arguments or request JSON. */
export async function pumpCodexAppServer(input) {
  const { state, candidate } = input;
  const nativeExecution = getNativeExecutionContext(state);
  if (!nativeExecution) return pumpCodexAppServerRound({ ...input, nativeExecution: undefined });
  try {
    const nativePolicy = assertCodexNativeExecution(nativeExecution, state, candidate);
    return await pumpCodexAppServerRound({ ...input, nativeExecution, nativePolicy, canFailover: false });
  } catch (error) {
    const message = safeAgentCliDiagnostic(error.message, Object.values(input.runtime.secrets ?? {}));
    if (state.status !== 'cancelled') markError(state, message);
    return { outcome: 'fatal', message, hostSuspect: false };
  }
}

/** One native turn can span multiple ordinary Minnow generation/tool rounds. */
async function pumpCodexAppServerRound({ state, runtime, candidate, index, idleMs, maxMs, canFailover, nativeExecution, nativePolicy }) {
  const startedAt = performance.now();
  const controller = new AbortController();
  state.upstreamController = controller;
  let session, round, release, unlock, maxTimer, timeoutKind, stopping;
  const key = codexSessionKey(state, candidate);
  const abort = () => {
    const current = session;
    if (current) void (current.nativePolicy ? quarantineCodexSession(current) : dirtyCodexSession(current)).catch(() => {});
    if (current?.turnId && current.rpc) {
      stopping = current.rpc.request('turn/interrupt', { threadId: current.threadId, turnId: current.turnId }, { timeoutMs: 1000 })
        .catch(() => {}).finally(() => closeCodexSession(current).catch(() => {}));
    } else stopping = closeCodexSession(current).catch(() => {});
    queueMicrotask(() => round?.finish('error', new Error(timeoutKind
      ? generationTimeoutMessage({ idleMs, maxMs }, timeoutKind) : 'Codex request cancelled.')));
  };
  controller.signal.addEventListener('abort', abort, { once: true });
  const nativeAbort = () => controller.abort(nativeExecution.signal.reason);
  nativeExecution?.signal.addEventListener('abort', nativeAbort, { once: true });
  if (maxMs > 0) maxTimer = setTimeout(() => { timeoutKind = 'max'; controller.abort(); }, maxMs);
  try {
    if (!nativePolicy) assertMinnowToolMode(runtime.profile.agentCli);
    unlock = lockCodexChat(key);
    const body = JSON.parse(state.requestBody.toString('utf8'));
    if (state.providerId !== candidate.providerId || body.model !== candidate.modelId) delete body.minnow_cli_fast_mode;
    body.model = candidate.modelId;
    const workspace = nativePolicy?.workspace ?? getEffectiveWorkspaceRoot();
    session = getCodexSession(key);
    release = await admitAgentCli(candidate.providerId, runtime.profile.agentCli.maxConcurrent, controller.signal);
    // Login can change while queued; bind to the credentials actually admitted.
    const identity = await codexIdentity(runtime, workspace);
    if (nativePolicy) identity.nativePolicy = nativePolicy;
    const prepared = prepareConversation(body, identity);
    const admittedAt = performance.now();
    let resume = session && !session.rebuild && continuation(session, prepared);
    if (session && !resume) {
      if (session.nativePolicy) { await quarantineCodexSession(session); throw codexNativeRecoveryError(); }
      await closeCodexSession(session); session = null;
    }
    if (!session) {
      try { session = await createCodexSession({ key, state, runtime, candidate, identity, prepared,
        signal: controller.signal, onEvent, onRequest, nativeExecution, nativePolicy }); }
      catch (error) {
        if (!error.cliResumeRejected || controller.signal.aborted) throw error;
        // Resume preflight runs no inference. Rebuild once from canonical
        // history when the native store was missing or modified.
        session = await createCodexSession({ key, state, runtime, candidate, identity, prepared,
          signal: controller.signal, onEvent, onRequest, nativeExecution, nativePolicy });
        session.method = 'rebuilt'; session.reason = 'Saved native history failed verification.';
      }
    } else {
      if (nativePolicy) {
        session.nativeExecution.signal.removeEventListener('abort', session.nativeAbort);
        session.nativeExecution = nativeExecution;
        nativeExecution.signal.addEventListener('abort', session.nativeAbort, { once: true });
      }
      await syncCodexCredentials(session, runtime);
    }
    if (session.restoredInput) { resume = { input: session.restoredInput }; session.restoredInput = null; }
    else if (nativePolicy && session.waiting && !resume) resume = continuation(session, prepared);
    else if (resume && !session.saved) session.method = 'reused';
    if (controller.signal.aborted) throw new Error('Codex request cancelled.');
    clearTimeout(session.timer); session.active = true;
    session.generationId = state.id;
    updateAgentCliSessionOutput(session.capture, { sessionState: 'active', continuation: session.method });
    const initializedAt = performance.now();
    const baseline = { ...session.allocated };
    const metrics = { queue_ms: admittedAt - startedAt, initialization_ms: initializedAt - admittedAt, warm: session.method === 'reused' };
    let resolveRound, publishNativeCompletion;
    const done = new Promise(resolve => { resolveRound = resolve; });
    round = {
      generationId: state.id, calls: [], content: '', reasoning: '', emitted: false, finished: false, idleTimer: null, batchTimer: null, batchStartedAt: null, handoffReady: false, bytes: 0,
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
        if (nativePolicy) {
          try {
            if (!error && !controller.signal.aborted && reason === 'tool_calls') {
              await pauseNativeTurn(session);
              session.nativePaused = true;
            }
            if (session.nativeActive?.size) throw codexNativeRecoveryError();
            await session.nativeRecords;
            nativeExecution.signal.throwIfAborted();
            await nativeExecution.assertCurrent(nativeMeta(session));
          } catch (nativeError) { error = nativeError; }
          if (error || controller.signal.aborted) await quarantineCodexSession(session).catch(() => {});
        }
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
        const allocatedUsage = allocateCodexUsage(session.usage, baseline);
        const metadata = { usage: allocatedUsage ? { ...allocatedUsage, last_request_usage: session.lastRequestUsage ?? null } : undefined, minnow_cli: { timings: metrics, continuation: session.method, transport: 'app-server',
          requested_tool_mode: nativePolicy ? 'native' : 'minnow', effective_tool_mode: nativePolicy ? 'native' : 'minnow',
          ...(nativePolicy ? { native_policy_version: 1, native_cli_version: '0.166.0', native_mode: nativePolicy.mode,
            capability_exclusions: ['network', 'native-ask', 'agents', 'browser', 'plugins', 'hooks', 'images', 'image-result-continuations', 'background-command-continuations'] } : {}),
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
        session.accepted = [...prepared.canonical, { role: 'assistant', content: this.content.trim(),
          ...(this.calls.length ? { tool_calls: this.calls } : {}) }];
        session.waiting = reason === 'tool_calls'; session.handed = this.calls;
        if ((!session.waiting || nativePolicy) && !session.closed && !session.rebuild) {
          const checkpointAt = performance.now();
          try { await checkpointCodexSession(session); }
          catch (error) {
            session.clean = false;
            if (nativePolicy || error.cliNativeRecoveryRequired) {
              if (nativePolicy) await quarantineCodexSession(session).catch(() => {});
              markError(state, error.message);
              await closeCodexSession(session).catch(() => {});
              resolveRound({ outcome: 'fatal', message: error.message, hostSuspect: false });
              return;
            }
            updateAgentCliSessionOutput(session.capture, { reason: 'Native session snapshot unavailable; restart will rebuild.' });
          }
          finally {
            metrics.checkpoint_ms = performance.now() - checkpointAt;
            Object.assign(metrics, session.checkpointTimings);
          }
        }
        if (controller.signal.aborted || session.closed) {
          if (nativePolicy) {
            resolveRound({ outcome: 'fatal', message: 'Native session closed before verified settlement.', hostSuspect: false }); return;
          }
          if (!controller.signal.aborted && state.status !== 'cancelled') { completeGeneration(); markComplete(state); }
          resolveRound({ outcome: 'complete' }); return;
        }
        // Anonymous requests cannot resume this handoff on their next generation.
        if (nativePolicy) {
          const verified = session.nativeVerifiedTurn;
          session.onFailure = null;
          await closeCodexSession(session);
          if (!verified || session.rpc.child.exitCode == null && session.rpc.child.signalCode == null) {
            resolveRound({ outcome: 'fatal', message: 'Native process quiescence could not be confirmed.', hostSuspect: false }); return;
          }
          publishNativeCompletion = () => { completeGeneration(); markComplete(state); };
          resolveRound({ outcome: 'complete', nativeQuiescence: { verified: true,
            source: session.waiting ? 'dynamic-tool-pause' : 'turn-completed', generationId: state.id,
            threadId: verified.threadId, turnId: verified.turnId } }); return;
        }
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
      if (typeof delta.content_snapshot === 'string') {
        round.content = delta.content_snapshot;
        round.choose();
        if (body.stream !== false) append(state, { minnow_text_snapshot: { version: 1, content: round.content } });
        return;
      }
      round.content += delta.content ?? ''; round.reasoning += delta.reasoning ?? '';
      if (reasoningFormat) { delta.reasoning_format = reasoningFormat; round.reasoningFormat = reasoningFormat; }
      round.choose();
      if (body.stream !== false) append(state, { choices: [{ index: 0, delta }] });
      metrics.forwarding_max_ms = Math.max(metrics.forwarding_max_ms ?? 0, performance.now() - forwardingAt);
    }, { onDivergence(details) {
      if (details.channel === 'content' && details.kind === 'stale') session.rebuild = true;
      void appendDiagnosticEntry({ source: 'server', kind: 'codex-snapshot-divergence',
        message: `Codex ${details.channel} snapshot ${details.kind}`, extra: { chatId: state.chatId, generationId: state.id, ...details } });
    } });
    session.round = round; session.onFailure = error => round.finish('error', error);
    const runRegion = async () => {
      await dirtyCodexSession(session);
      markStreaming(state); round.activity();
      if (resume?.results && nativePolicy && session.nativePaused) {
        const groups = new Set(session.handed.map(call => session.pending.get(call.id).group));
        const items = [];
        for (const group of groups) {
          if (group.calls.some(call => resume.results.get(call.id)?.some(item => item.type !== 'inputText'))) {
            throw new Error('Image-bearing native/Minnow result continuations are not verified; use a Minnow-only conversation.');
          }
          const output = group.calls.map(call => ({ name: call.function.name,
            contentItems: resume.results.get(call.id) }));
          items.push({ type: 'function_call_output', call_id: group.nativeCallId, output: JSON.stringify(output) });
        }
        await nativeExecution.assertCurrent(nativeMeta(session));
        await session.rpc.request('thread/inject_items', { threadId: session.threadId, items }, { signal: controller.signal });
        session.pending.clear(); session.handed = []; session.waiting = false; session.nativePaused = false;
        // Interrupted calls have a cancelled protocol result. Inject the REAL
        // Minnow result once into preserved history; never reissue its action.
        resume = { input: [{ type: 'text', text: 'Continue using the actual Minnow tool results injected above. Those tools have already executed; do not repeat their effects.' }] };
      }
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
        session.itemOrigins = new Map();
        session.context = undefined;
        session.lastRequestUsage = undefined;
        const seed = resume ? { items: [], input: resume.input } : seedConversation(prepared);
        if (body.minnow_cli_turn_context) {
          if (seed.input[0]?.type !== 'text') seed.input.unshift({ type: 'text', text: '' });
          seed.input[0] = { ...seed.input[0], text: withCliTurnContext(seed.input[0].text, body.minnow_cli_turn_context) };
        }
        if (seed.items.length) await session.rpc.request('thread/inject_items', { threadId: session.threadId, items: seed.items }, { signal: controller.signal });
        session.starting = true;
        const effort = body.reasoning_effort === 'off' ? 'none' : body.reasoning_effort;
        const outputSchema = body.response_format?.json_schema?.schema ?? (body.response_format?.type === 'json_object' ? { type: 'object', additionalProperties: true } : undefined);
        session.inferenceStarted = true;
        if (nativePolicy) { state.failoverDisabled = true; await nativeExecution.assertCurrent(nativeMeta(session)); }
        const started = await session.rpc.request('turn/start', { threadId: session.threadId, input: seed.input,
          serviceTier: body.minnow_cli_fast_mode === true ? 'priority' : null,
          ...(effort ? { effort } : {}), ...(outputSchema ? { outputSchema } : {}) }, { signal: controller.signal });
        session.turnId = started.turn.id; session.starting = false;
      }
      const result = await done;
      if (nativePolicy && result.outcome === 'fatal') throw Object.assign(new Error(result.message), { cliNativeRecoveryRequired: true });
      return result;
    };
    if (!nativePolicy) return await runRegion();
    // Thread creation/resume performs no inference. The host baseline and
    // shared mutation barrier start here, before injection or turn/start.
    session.turnId = null;
    let invoked = false;
    const result = await nativeExecution.runTurn(nativeMeta(session), async () => {
      if (invoked) throw new Error('Native running region cannot repeat.');
      invoked = true;
      await nativeExecution.assertCurrent(nativeMeta(session));
      try { return await runRegion(); }
      catch (error) {
        // Do not release the host's mutation boundary while a failed native
        // process can still act. Unconfirmed shutdown remains uncertainty.
        await quarantineCodexSession(session).catch(() => {});
        await closeCodexSession(session);
        throw error;
      }
    });
    if (!invoked || !result?.nativeQuiescence?.verified) throw codexNativeRecoveryError();
    publishNativeCompletion?.();
    return result;
  } catch (error) {
    if (nativePolicy && session) await quarantineCodexSession(session).catch(() => {});
    await closeCodexSession(session).catch(() => {});
    if (state.status === 'cancelled') return { outcome: 'complete' };
    const message = safeAgentCliDiagnostic(timeoutKind ? generationTimeoutMessage({ idleMs, maxMs }, timeoutKind) : error.message,
      session?.redactionSecrets ?? Object.values(runtime.secrets ?? {}));
    if (!error.cliPolicyRejected && !round?.emitted && canFailover && !session?.inferenceStarted) return { outcome: 'retry', message, retrySameCandidate: false, hostSuspect: false };
    markError(state, message); return { outcome: 'fatal', message, hostSuspect: false };
  } finally {
    clearTimeout(maxTimer); controller.signal.removeEventListener('abort', abort);
    nativeExecution?.signal.removeEventListener('abort', nativeAbort);
    await stopping;
    if (session && !session.closed && !session.nativeRecoveryRequired) await session.syncAuth?.().catch(() => {});
    release?.(); unlock?.();
    if (state.upstreamController === controller) state.upstreamController = null;
  }
}
