import { assertCaller, assertExecutionCaller } from './caller.js';
import { ChatContractError, validateChatCommand, validateChatId } from './contracts.js';
import { hashChatPayload } from './repository.js';

const TERMINAL = new Set(['completed', 'failed', 'stopped', 'recovery_required']);
const ACTIVE = new Set(['running', 'waiting', 'waiting_for_model', 'loading_model', 'waiting_for_agents', 'waiting_for_input', 'waiting_for_approval']);
const noop = () => {};

function fail(code, message) { throw new ChatContractError(code, message); }
function checked(result) {
  if (!result.ok) throw new ChatContractError(result.error.code, result.error.message, result.error);
  return result.value;
}
function limit(value, name) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1000000) throw new TypeError('Invalid conversation causality limit: ' + name);
  return value;
}

/** Durable budgets count accepted peer commands, including subsequently cancelled ones. */
export function createChatCausality({ repository, maxPeerCommands = 128, maxHops = 8, maxPendingPeerInputs = 32, isCallerActive } = {}) {
  if (!repository || typeof repository.getDatabase !== 'function') throw new TypeError('Conversation causality requires the canonical repository');
  if (isCallerActive !== undefined && typeof isCallerActive !== 'function') throw new TypeError('Invalid live conversation caller validator');
  const db = repository.getDatabase();
  const limits = Object.freeze({ maxPeerCommands: limit(maxPeerCommands, 'maxPeerCommands'),
    maxHops: limit(maxHops, 'maxHops'), maxPendingPeerInputs: limit(maxPendingPeerInputs, 'maxPendingPeerInputs') });
  db.exec("CREATE INDEX IF NOT EXISTS idx_chat_commands_causal_peer ON chat_commands(json_extract(captured_json, '$.causalRootId')) WHERE json_extract(captured_json, '$.agentCoordination') = 1");
  const peerCount = db.prepare("SELECT count(*) AS count FROM chat_commands WHERE json_extract(captured_json, '$.agentCoordination') = 1 AND json_extract(captured_json, '$.causalRootId') = ?");
  const inboxCount = db.prepare("SELECT count(*) AS count FROM chat_commands WHERE chat_id = ? AND state IN ('accepted','queued','waiting_for_host') AND json_extract(captured_json, '$.agentCoordination') = 1");
  const latestSteer = db.prepare("SELECT c.command_id, c.captured_json, json_extract(c.effective_json, '$.provenance.actor') AS actor FROM chat_commands c JOIN chat_message_identities m ON m.chat_id = c.chat_id AND m.message_id = c.message_id WHERE c.execution_id = ? AND c.state = 'settled' AND json_extract(c.effective_json, '$.kind') = 'steer' AND json_extract(c.effective_json, '$.provenance.actor') IN ('human','agent') AND json_extract(c.result_json, '$.disposition') = 'steered' AND json_extract(c.result_json, '$.executionId') = ? ORDER BY m.seq DESC LIMIT 1");
  const waits = new Map();

  function active(caller) {
    assertExecutionCaller(caller);
    if (isCallerActive && isCallerActive(caller) !== true) fail('caller_not_active', 'The coordinating execution is no longer active');
    const execution = repository.getExecution(caller.executionId);
    if (!execution) {
      if (!isCallerActive) fail('caller_not_active', 'An external execution requires current server ownership proof');
      return null;
    }
    const lease = repository.getLease(caller.chatId);
    if (execution.chatId !== caller.chatId || !ACTIVE.has(execution.status) || !lease || lease.executionId !== execution.executionId ||
      execution.captured.cancellationEpoch !== undefined && execution.captured.cancellationEpoch !== repository.getCancellationEpoch(caller.chatId)) {
      fail('caller_not_active', 'The coordinating execution is no longer active');
    }
    repository.assertFence(caller.chatId, lease);
    return execution;
  }

  function source(caller) {
    const execution = active(caller);
    const steer = latestSteer.get(caller.executionId, caller.executionId);
    if (steer?.actor === 'human') return Object.freeze({ causalRootId: steer.command_id, causalDepth: 0 });
    const captured = steer ? JSON.parse(steer.captured_json) : execution?.captured ?? {};
    const causalRootId = captured.causalRootId ?? (steer ? undefined : execution?.commandId ?? caller.executionId);
    const causalDepth = captured.causalDepth ?? 0;
    if (!validateChatId(causalRootId).ok || !Number.isSafeInteger(causalDepth) || causalDepth < 0) {
      fail('recovery_required', 'The execution has invalid stored conversation causality');
    }
    return Object.freeze({ causalRootId, causalDepth });
  }

  function inherit(caller) {
    const origin = source(caller);
    if (origin.causalDepth >= limits.maxHops) fail('causal_limit', 'This conversation chain reached its maximum hop count');
    return Object.freeze({ causalRootId: origin.causalRootId, causalDepth: origin.causalDepth + 1 });
  }

  function admit({ caller, command: input }) {
    assertCaller(caller);
    if (!db.inTransaction) throw new TypeError('Conversation causality admission must share the command admission transaction');
    const command = checked(validateChatCommand(input));
    if (!['send', 'steer'].includes(command.kind) || command.provenance.actor !== caller.actor || caller.actor === 'system') {
      fail('invalid_request', 'Conversation causality applies to authenticated human or agent messages');
    }
    if (caller.actor === 'human') return Object.freeze({ causalRootId: command.commandId, causalDepth: 0 });
    if (command.provenance.sourceChatId !== caller.chatId || command.provenance.sourceTurnId !== caller.executionId) {
      fail('caller_denied', 'Peer message authorship must match its trusted execution');
    }
    const origin = inherit(caller);
    const prior = repository.getCommand(command.commandId);
    if (prior) {
      if (hashChatPayload(prior.command) !== hashChatPayload(command)) fail('idempotency_conflict', 'The peer command identity was reused');
      if (prior.captured.agentCoordination !== true || prior.captured.causalRootId !== origin.causalRootId || prior.captured.causalDepth !== origin.causalDepth) {
        fail('idempotency_conflict', 'The peer command already has different captured causality');
      }
      return Object.freeze({ ...origin, agentCoordination: true });
    }
    if (peerCount.get(origin.causalRootId).count >= limits.maxPeerCommands) fail('causal_limit', 'This human request reached its peer message budget');
    if (inboxCount.get(command.chatId).count >= limits.maxPendingPeerInputs) fail('causal_limit', 'The target conversation has too many pending peer inputs');
    return Object.freeze({ ...origin, agentCoordination: true });
  }

  function releaseEdge(edge) {
    if (edge.released) return;
    edge.released = true;
    edge.signal?.removeEventListener('abort', edge.release);
    const outgoing = waits.get(edge.sourceId);
    const siblings = outgoing?.get(edge.targetId);
    siblings?.delete(edge);
    if (siblings?.size === 0) outgoing.delete(edge.targetId);
    if (outgoing?.size === 0) waits.delete(edge.sourceId);
  }
  function prune() {
    for (const outgoing of [...waits.values()]) for (const edges of [...outgoing.values()]) for (const edge of [...edges]) {
      let valid = false;
      try { active(edge.caller); valid = true; } catch { /* Stopped/released owners no longer contribute a wait edge. */ }
      const target = repository.getExecution(edge.targetId);
      if (!valid || !target || TERMINAL.has(target.status)) releaseEdge(edge);
    }
  }
  function reaches(start, goal) {
    const pending = [start], visited = new Set();
    while (pending.length) {
      const current = pending.pop();
      if (current === goal) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      for (const next of waits.get(current)?.keys() ?? []) pending.push(next);
    }
    return false;
  }
  function beforeWait({ caller, chatId, executionId, signal }) {
    signal?.throwIfAborted(); active(caller); checked(validateChatId(chatId));
    if (executionId !== undefined) checked(validateChatId(executionId));
    const target = executionId === undefined ? repository.getLatestExecution(chatId) : repository.getExecution(executionId);
    if (!target || target.chatId !== chatId) fail('request_not_found', 'The wait target does not belong to this conversation');
    if (target.executionId === caller.executionId) fail('wait_cycle', 'An execution cannot wait on itself');
    if (TERMINAL.has(target.status)) return noop;
    prune();
    if (reaches(target.executionId, caller.executionId)) fail('wait_cycle', 'This wait would create a conversation execution cycle');
    const edge = { sourceId: caller.executionId, targetId: target.executionId, caller, signal, released: false };
    edge.release = () => releaseEdge(edge);
    if (!waits.has(edge.sourceId)) waits.set(edge.sourceId, new Map());
    const outgoing = waits.get(edge.sourceId);
    if (!outgoing.has(edge.targetId)) outgoing.set(edge.targetId, new Set());
    outgoing.get(edge.targetId).add(edge);
    signal?.addEventListener('abort', edge.release, { once: true });
    if (signal?.aborted) edge.release();
    return edge.release;
  }
  function dispose() {
    for (const outgoing of [...waits.values()]) for (const edges of [...outgoing.values()]) for (const edge of [...edges]) releaseEdge(edge);
  }
  return Object.freeze({ limits, source, inherit, admit, beforeWait, dispose });
}
