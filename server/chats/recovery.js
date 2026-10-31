import { createHash, randomUUID } from 'node:crypto';
import * as journal from '../sub-agents/journal.js';
import { makeEvent } from '../sub-agents/events.js';
import { isTerminal } from '../sub-agents/derive.js';
import { ChatContractError } from './contracts.js';
import { restoreArchivedJournal } from './archive.js';
import { hashChatPayload } from './repository.js';

const stable = value => createHash('sha256').update(value).digest('hex').slice(0, 48);

/** Finish imported filesystem work before any journal graph is loaded. */
export async function restorePendingChatJournals(repository) {
  const db = repository.getDatabase(), ownerId = 'archive-' + randomUUID();
  let restored = 0;
  while (true) {
    const rows = db.prepare("SELECT outbox_id FROM chat_outbox WHERE kind='archive.journal.restore' AND state!='applied' ORDER BY created_at,outbox_id LIMIT 1000").all();
    if (!rows.length) return restored;
    for (const row of rows) {
      const pending = repository.getOutbox(row.outbox_id);
      // This entry point runs behind the runtime's startup/import recovery gate.
      if (pending.state === 'applying') db.prepare("UPDATE chat_outbox SET state='pending',owner_id=NULL,expires_at=NULL WHERE outbox_id=?").run(row.outbox_id);
      const claim = repository.claimOutbox(row.outbox_id, ownerId);
      if (!claim) throw new ChatContractError('recovery_required', 'An imported family journal is still owned by another recovery');
      try { await restoreArchivedJournal(claim.payload); }
      catch (error) {
        repository.finishOutbox(claim.outboxId, claim, { code: 'recovery_required', message: 'The imported family journal could not be reconciled', retryable: true });
        throw new ChatContractError('recovery_required', error instanceof Error ? error.message : 'The imported family journal could not be reconciled');
      }
      repository.finishOutbox(claim.outboxId, claim); restored++;
    }
  }
}

/** Repair both directions of an independently copied SQLite/JSONL boundary. */
export async function reconcileChatJournalStorage(repository, { chatIds } = {}) {
  const db = repository.getDatabase(), selected = chatIds ? new Set(chatIds) : null;
  const owners = selected ? new Set(db.prepare('SELECT chat_id,journal_owner_id FROM chat_relations').all().filter(row => selected.has(row.chat_id)).map(row => row.journal_owner_id)) : null;
  const timelines = new Map();
  for (const row of db.prepare("SELECT outbox_id,chat_id,kind,state,payload_json FROM chat_outbox WHERE kind IN ('agent.journal.request','agent.journal.cancel','agent.result.ack') ORDER BY created_at,outbox_id").all()) {
    if (selected && !selected.has(row.chat_id)) continue;
    const payload = JSON.parse(row.payload_json), event = payload.event;
    if (!payload.journalOwnerId || !event) throw new ChatContractError('recovery_required', 'A saved journal operation has no durable event');
    if (!timelines.has(payload.journalOwnerId)) timelines.set(payload.journalOwnerId, new Map((await journal.readEvents(payload.journalOwnerId)).filter(saved => saved.idempotencyKey).map(saved => [saved.idempotencyKey, saved])));
    const timeline = timelines.get(payload.journalOwnerId), previous = timeline.get(row.outbox_id);
    // Restore a missing durable event even if its old acknowledgement was copied.
    if (previous) {
      const { seq, ts, idempotencyKey, ...saved } = previous;
      if (hashChatPayload(saved) !== hashChatPayload({ v: 1, ...event })) throw new ChatContractError('recovery_required', 'A saved journal operation conflicts with the restored family timeline');
    } else timeline.set(row.outbox_id, await journal.appendEvent(payload.journalOwnerId, event, { idempotencyKey: row.outbox_id }));
    repository.atomic(() => {
      if (row.state !== 'applied') db.prepare("UPDATE chat_outbox SET state='applied',owner_id=NULL,expires_at=NULL,error_json=NULL WHERE outbox_id=?").run(row.outbox_id);
      if (row.kind === 'agent.result.ack') db.prepare("UPDATE chat_task_subscriptions SET state='delivered',disposition=?,updated_at=? WHERE run_id=? AND state IN ('accepted','inline_returned')")
        .run(event.disposition ?? 'accepted', Date.now(), event.runId);
    });
  }
  for (const row of db.prepare('SELECT payload_json FROM chat_task_results ORDER BY settled_at,run_id').all()) {
    const result = JSON.parse(row.payload_json);
    if (selected && !selected.has(result.childChatId)) continue;
    const state = await journal.loadState(result.journalOwnerId), run = state.runs.get(result.runId);
    if (!run || isTerminal(run)) continue;
    const key = 'restored-result-' + stable(result.runId);
    const event = result.status === 'completed' ? makeEvent('attempt.ended', {
      runId: result.runId, attemptId: result.attemptId ?? 'recovered-' + stable(result.runId), outcome: 'pass', summary: result.summary,
      ...(result.executionId ? { executionId: result.executionId } : {}), evidence: { recovered: true, source: 'immutable-task-result' },
    }) : result.status === 'cancelled' ? makeEvent('run.cancelled', { runId: result.runId, reason: 'user' })
      : makeEvent('run.abandoned', { runId: result.runId, reason: 'restored_terminal_result', evidence: { recovered: true, summary: result.summary } });
    await journal.appendEvent(result.journalOwnerId, event, { idempotencyKey: key });
  }
  for (const owner of await journal.listEntries()) {
    if (owners && !owners.has(owner)) continue;
    const state = await journal.loadState(owner);
    for (const run of state.runs.values()) {
      if (!run.childChatId || isTerminal(run)) continue;
      const command = run.commandId ? repository.getCommand(run.commandId) : null;
      if (command && db.prepare('SELECT 1 FROM chats WHERE id=?').get(run.childChatId)) continue;
      await journal.appendEvent(owner, makeEvent('attempt.ended', { runId: run.runId,
        attemptId: run.attempts.find(attempt => !attempt.ended)?.attemptId ?? 'missing-' + stable(run.runId), outcome: 'crashed',
        summary: 'The restored task is missing canonical conversation records. Restore the matching backup before continuing.',
        evidence: { recoveryRequired: true, source: 'journal-ahead-of-sqlite' } }), { idempotencyKey: 'missing-canonical-' + stable(run.runId) });
    }
  }
}

/** One ordering for boot, database snapshot recovery, staged restore and explicit import. */
export function createChatRecovery({ repository, service, requests, taskDelivery, getTaskAdapter, verifyQuiescence,
  beforeExecutionRecovery, now = Date.now } = {}) {
  if (!repository || !service || !requests || !taskDelivery || typeof verifyQuiescence !== 'function') throw new TypeError('Chat recovery requires its canonical runtime and quiescence verifier');
  let running;
  return {
    run(input = {}) {
      // Different import scopes must each finish; sharing the first promise
      // could return before a later import's staged journals were restored.
      const previous = running;
      const operation = (async () => {
        if (previous) await previous.catch(() => {});
        const { reason = 'startup', chatIds } = input;
        if (!['startup', 'import', 'restore'].includes(reason) || chatIds !== undefined && !Array.isArray(chatIds)) throw new ChatContractError('invalid_request', 'Invalid conversation recovery scope');
        await restorePendingChatJournals(repository);
        await reconcileChatJournalStorage(repository, { chatIds });
        requests.expireUnownedLegacyApprovals();
        const preparation = await beforeExecutionRecovery?.({ reason, chatIds });
        const held = new Set(preparation?.heldExecutionIds ?? []), selected = chatIds ? new Set(chatIds) : null;
        const recovered = await service.recoverExecutions((execution, lease) => selected && !selected.has(execution.chatId) || held.has(execution.executionId)
          ? null : verifyQuiescence(execution, lease));
        for (const execution of recovered) for (const request of repository.listRequests(execution.chatId, 'pending')) {
          if (request.executionId === execution.executionId && !requests.hasLiveWaiter?.(request.requestId)) {
            repository.settleRequest(request.requestId, { state: 'expired', settledAt: now() });
          }
        }
        const db = repository.getDatabase();
        // Old terminal executions cannot consume a later durable answer. Safe
        // reattached questions are held above and retain their exact execution.
        for (const row of db.prepare("SELECT q.request_id,q.chat_id FROM chat_requests q JOIN chat_executions e ON e.execution_id=q.execution_id WHERE q.state='pending' AND e.status IN ('completed','failed','stopped','recovery_required')").all()) {
          if (selected && !selected.has(row.chat_id) || requests.hasLiveWaiter?.(row.request_id)) continue;
          repository.settleRequest(row.request_id, { state: 'expired', settledAt: now() });
        }
        if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='chat_workspace_allocations'").get()) {
          for (const row of db.prepare("SELECT allocation_id,payload_json FROM chat_workspace_allocations WHERE setup_state='allocating'").all()) {
            const record = JSON.parse(row.payload_json);
            if (selected && !selected.has(record.childChatId)) continue;
            const next = { ...record, setupState: 'recovery_required', ownerId: null, revision: record.revision + 1,
              error: 'Checkout setup was interrupted. Verify the retained files before retrying.', updatedAt: now() };
            db.prepare('UPDATE chat_workspace_allocations SET setup_state=?,revision=?,payload_json=?,updated_at=? WHERE allocation_id=?')
              .run(next.setupState, next.revision, JSON.stringify(next), next.updatedAt, row.allocation_id);
          }
        }
        await taskDelivery.recover();
        await getTaskAdapter?.()?.recover?.();
        return { reason, recoveredExecutionIds: recovered.map(execution => execution.executionId), heldExecutionIds: [...held] };
      })();
      running = operation;
      void operation.finally(() => { if (running === operation) running = undefined; }).catch(() => {});
      return running;
    },
  };
}
