import { createHash } from 'node:crypto';
import { ChatContractError, validateChatTaskResult, validateTaskCompletionPolicy, validateChatId } from './contracts.js';
import { hashChatPayload } from './repository.js';
import { messageTextContent } from '../config/sessions-import.js';

const fail = (code, message) => { throw new ChatContractError(code, message); };
const checked = result => { if (!result.ok) fail(result.error.code, result.error.message); return result.value; };
const id = value => checked(validateChatId(value));
const encode = value => { hashChatPayload(value); return JSON.stringify(value); };
const states = ['active', 'inline_hold', 'inline_returned', 'accepted', 'delivered', 'local_only', 'disposed'];
const terminalStates = new Set(['delivered', 'local_only', 'disposed']);
const stable = (prefix, value) => prefix + '-' + createHash('sha256').update(encode(value)).digest('hex').slice(0, 48);
function subscription(row) {
  return row ? { runId: row.run_id, subscriptionId: row.subscription_id, policy: JSON.parse(row.policy_json),
    recipientChatId: row.recipient_chat_id, cancellationEpoch: row.cancellation_epoch, state: row.state,
    holdExecutionId: row.hold_execution_id, holdToolCallId: row.hold_tool_call_id, cohortId: row.cohort_id,
    disposition: row.disposition, updatedAt: row.updated_at } : null;
}

/** Durable task results and subscriptions are independent of a chat's latest turn or lifetime. */
export function createChatTaskRepository({ repository, now = Date.now } = {}) {
  if (!repository?.getDatabase) throw new TypeError('Task storage requires the canonical chat repository connection');
  const db = repository.getDatabase();
  function getSubscription(runId) { return subscription(db.prepare('SELECT * FROM chat_task_subscriptions WHERE run_id=?').get(id(runId))); }
  function getResult(runId) {
    const row = db.prepare('SELECT payload_json FROM chat_task_results WHERE run_id=?').get(id(runId));
    return row ? JSON.parse(row.payload_json) : null;
  }
  function cohort(row) {
    if (!row) return null;
    const payload = JSON.parse(row.payload_json);
    return { cohortId: row.cohort_id, recipientChatId: row.recipient_chat_id, cancellationEpoch: row.cancellation_epoch,
      state: row.state, commandId: row.command_id, disposition: row.disposition, createdAt: row.created_at,
      groupKey: payload.groupKey ?? null,
      runIds: payload.runIds ?? db.prepare('SELECT run_id FROM chat_task_subscriptions WHERE cohort_id=? ORDER BY run_id').all(row.cohort_id).map(item => item.run_id) };
  }
  const getCohort = cohortId => cohort(db.prepare('SELECT * FROM chat_completion_cohorts WHERE cohort_id=?').get(id(cohortId)));
  const store = {
    getResult, getSubscription, getCohort,
    saveResult(input, { commandId } = {}) {
      const result = checked(validateChatTaskResult(input)); id(commandId);
      return repository.atomic(() => {
        const hash = hashChatPayload(result);
        const previous = db.prepare('SELECT * FROM chat_task_results WHERE run_id=?').get(result.runId);
        if (previous) {
          if (previous.payload_hash !== hash || previous.command_id !== commandId) fail('idempotency_conflict', 'A terminal task result is immutable');
          return JSON.parse(previous.payload_json);
        }
        db.prepare('INSERT INTO chat_task_results(run_id,chat_id,journal_owner_id,command_id,payload_hash,payload_json,settled_at) VALUES(?,?,?,?,?,?,?)')
          .run(result.runId, result.childChatId, result.journalOwnerId, commandId, hash, encode(result), result.settledAt);
        return result;
      });
    },
    listResults({ journalOwnerId, limit = 1000 } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) fail('invalid_request', 'Invalid task result limit');
      return db.prepare('SELECT payload_json FROM chat_task_results WHERE (? IS NULL OR journal_owner_id=?) ORDER BY settled_at,run_id LIMIT ?')
        .all(journalOwnerId ?? null, journalOwnerId ?? null, limit).map(row => JSON.parse(row.payload_json));
    },
    ensureSubscription({ runId, policy: input, inlineWait } = {}) {
      id(runId); const policy = checked(validateTaskCompletionPolicy(input));
      const hold = inlineWait === undefined ? null : {
        chatId: id(inlineWait.chatId), executionId: id(inlineWait.executionId), toolCallId: id(inlineWait.toolCallId),
      };
      if (hold && (policy.kind !== 'wake_delegator' || hold.chatId !== policy.recipientChatId)) fail('invalid_request', 'Inline wait belongs to the captured recipient');
      return repository.atomic(() => {
        const prior = getSubscription(runId);
        if (prior) {
          if (hashChatPayload(prior.policy) !== hashChatPayload(policy) || (hold &&
            (prior.holdExecutionId !== hold.executionId || prior.holdToolCallId !== hold.toolCallId))) fail('idempotency_conflict', 'Task subscription identity was reused');
          return prior;
        }
        db.prepare('INSERT INTO chat_task_subscriptions(run_id,subscription_id,completion_kind,recipient_chat_id,cancellation_epoch,policy_json,state,hold_execution_id,hold_tool_call_id,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
          .run(runId, policy.kind === 'wake_delegator' ? policy.subscriptionId : stable('local', runId), policy.kind,
            policy.kind === 'wake_delegator' ? policy.recipientChatId : null, policy.kind === 'wake_delegator' ? policy.cancellationEpoch : 0,
            encode(policy), policy.kind === 'local_only' ? 'local_only' : hold ? 'inline_hold' : 'active', hold?.executionId ?? null, hold?.toolCallId ?? null, now());
        return getSubscription(runId);
      });
    },
    listSubscriptions({ recipientChatId, states: wanted = states, limit = 1000 } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000 || !Array.isArray(wanted) || wanted.some(value => !states.includes(value))) fail('invalid_request', 'Invalid subscription query');
      if (!wanted.length) return [];
      return db.prepare('SELECT * FROM chat_task_subscriptions WHERE (? IS NULL OR recipient_chat_id=?) AND state IN (' + wanted.map(() => '?').join(',') + ') ORDER BY updated_at,run_id LIMIT ?')
        .all(recipientChatId ?? null, recipientChatId ?? null, ...wanted, limit).map(subscription);
    },
    setSubscription(runId, { state, disposition } = {}) {
      if (!states.includes(state)) fail('invalid_request', 'Invalid subscription state');
      return repository.atomic(() => {
        const current = getSubscription(runId); if (!current) fail('request_not_found', 'Task subscription does not exist');
        if (terminalStates.has(current.state)) {
          if (current.state !== state || (disposition !== undefined && current.disposition !== disposition)) fail('idempotency_conflict', 'Resolved task subscriptions are immutable');
          return current;
        }
        db.prepare('UPDATE chat_task_subscriptions SET state=?,disposition=?,updated_at=? WHERE run_id=?')
          .run(state, disposition ?? current.disposition, now(), runId);
        return getSubscription(runId);
      });
    },
    coalesce({ recipientChatId, cancellationEpoch, runIds, groupKey }) {
      id(recipientChatId);
      if (groupKey !== undefined) id(groupKey);
      if (!Number.isSafeInteger(cancellationEpoch) || cancellationEpoch < 0 || !Array.isArray(runIds) || !runIds.length) fail('invalid_request', 'Invalid completion cohort');
      return repository.atomic(() => {
        let current = cohort(db.prepare("SELECT * FROM chat_completion_cohorts WHERE recipient_chat_id=? AND cancellation_epoch=? AND state='open'").get(recipientChatId, cancellationEpoch));
        if (current && current.groupKey !== (groupKey ?? null)) return null;
        let count = current?.runIds.length ?? 0;
        for (const runId of runIds) {
          if (count >= 64) break;
          const sub = getSubscription(runId);
          if (!sub || sub.state !== 'active' || sub.cohortId || sub.recipientChatId !== recipientChatId || sub.cancellationEpoch !== cancellationEpoch || !getResult(runId)) continue;
          if (!current) {
            const cohortId = stable('completion', [recipientChatId, cancellationEpoch, runId]);
            db.prepare('INSERT INTO chat_completion_cohorts(cohort_id,recipient_chat_id,cancellation_epoch,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)')
              .run(cohortId, recipientChatId, cancellationEpoch, encode({ groupKey: groupKey ?? null }), now(), now());
            current = getCohort(cohortId);
          }
          db.prepare('UPDATE chat_task_subscriptions SET cohort_id=?,updated_at=? WHERE run_id=?').run(current.cohortId, now(), runId);
          count++;
        }
        return current ? getCohort(current.cohortId) : null;
      });
    },
    listCohorts({ recipientChatId, states: wanted = ['open', 'sealed'], limit = 1000 } = {}) {
      if (!Array.isArray(wanted) || wanted.some(value => !['open', 'sealed', 'admitted', 'disposed'].includes(value)) || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) fail('invalid_request', 'Invalid cohort query');
      if (!wanted.length) return [];
      return db.prepare('SELECT * FROM chat_completion_cohorts WHERE (? IS NULL OR recipient_chat_id=?) AND state IN (' + wanted.map(() => '?').join(',') + ') ORDER BY created_at,cohort_id LIMIT ?')
        .all(recipientChatId ?? null, recipientChatId ?? null, ...wanted, limit).map(cohort);
    },
    seal(cohortId) {
      return repository.atomic(() => {
        const current = getCohort(cohortId); if (!current) fail('request_not_found', 'Completion cohort does not exist');
        if (current.state === 'open') db.prepare("UPDATE chat_completion_cohorts SET state='sealed',payload_json=?,updated_at=? WHERE cohort_id=?")
          .run(encode({ runIds: current.runIds, groupKey: current.groupKey }), now(), cohortId);
        return getCohort(cohortId);
      });
    },
    settleCohort(cohortId, { state, commandId, disposition }) {
      if (!['admitted', 'disposed'].includes(state)) fail('invalid_request', 'Invalid cohort resolution');
      return repository.atomic(() => {
        const current = getCohort(cohortId); if (!current) fail('request_not_found', 'Completion cohort does not exist');
        if (['admitted', 'disposed'].includes(current.state)) {
          if (current.state !== state || (commandId !== undefined && current.commandId !== commandId)) fail('idempotency_conflict', 'Completion cohort is immutable');
          return current;
        }
        db.prepare('UPDATE chat_completion_cohorts SET state=?,payload_json=?,command_id=?,disposition=?,updated_at=? WHERE cohort_id=?')
          .run(state, encode({ runIds: current.runIds, groupKey: current.groupKey }), commandId ?? null, disposition ?? state, now(), cohortId);
        for (const runId of current.runIds) {
          if (state === 'disposed' && terminalStates.has(getSubscription(runId)?.state)) continue;
          store.setSubscription(runId, { state: state === 'admitted' ? 'accepted' : 'disposed', disposition: disposition ?? state });
        }
        return getCohort(cohortId);
      });
    },
    descendantChatIds(chatId) {
      id(chatId);
      return db.prepare('WITH RECURSIVE family(id) AS (SELECT ? UNION SELECT r.chat_id FROM chat_relations r JOIN family f ON r.parent_chat_id=f.id) SELECT id FROM family').all(chatId).map(row => row.id);
    },
    commandForRun(runId) {
      const row = db.prepare('SELECT command_id FROM chat_commands WHERE run_id=? ORDER BY position LIMIT 1').get(id(runId));
      return row ? repository.getCommand(row.command_id) : null;
    },
    canonicalToolResult({ chatId, executionId, toolCallId, runId }) {
      id(chatId); id(executionId); id(toolCallId); id(runId);
      const prefix = repository.getExecution(executionId)
        ? 'm-' + createHash('sha256').update(executionId).digest('hex').slice(0, 32) + '-%' : '%';
      const rows = db.prepare("SELECT m.payload_json FROM messages m LEFT JOIN chat_message_identities i ON i.chat_id=m.chat_id AND i.seq=m.seq WHERE m.chat_id=? AND m.role='tool' AND m.tool_call_id=? AND (?='%' OR i.message_id LIKE ?) ORDER BY m.seq DESC LIMIT 8")
        .all(chatId, toolCallId, prefix, prefix);
      return rows.map(row => JSON.parse(row.payload_json)).find(row => {
        try {
          const proof = JSON.parse(messageTextContent(row));
          return proof && !Array.isArray(proof) && proof.runId === runId
            && ['completed', 'failed', 'cancelled', 'interrupted'].includes(proof.status)
            && (typeof proof.summary === 'string' && proof.summary.trim()
              || typeof proof.outcome?.summary === 'string' && proof.outcome.summary.trim());
        } catch { return false; }
      }) ?? null;
    },
  };
  return store;
}
