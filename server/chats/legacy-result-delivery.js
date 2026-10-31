import { createHash } from 'node:crypto';
import * as diskJournal from '../sub-agents/journal.js';
import { isTerminal, lastEndedAttempt } from '../sub-agents/derive.js';
import { messageTextContent } from '../config/sessions-import.js';
import { createChatCaller } from './caller.js';
import { ChatContractError, validateChatId } from './contracts.js';

const keyFor = (parentChatId, runId) => 'legacy-result-' + createHash('sha256').update(JSON.stringify([parentChatId, runId])).digest('hex').slice(0, 48);
const provenanceId = (kind, parentChatId, value) => validateChatId(value).ok ? value
  : 'legacy-' + kind + '-' + createHash('sha256').update(JSON.stringify([parentChatId, value])).digest('hex').slice(0, 48);
function resultText(run) {
  const last = lastEndedAttempt(run);
  const body = { runId: run.runId.slice(0, 256), type: run.type.slice(0, 256),
    ...(run.runId.length > 256 ? { runIdTruncated: true } : {}), ...(run.type.length > 256 ? { typeTruncated: true } : {}),
    status: run.phase === 'passed' ? 'completed' : run.phase === 'cancelled' ? 'cancelled' : 'failed',
    summary: String(last?.summary || run.abandonedReason || (run.phase === 'cancelled' ? 'Task cancelled.' : 'Task finished.')) };
  const prefix = '[Sub-agent finished] One legacy sub-agent run completed. Its original journal retains the full result.\n\n';
  while (JSON.stringify(body).length + prefix.length > 115000 && body.summary.length) { body.summary = body.summary.slice(0, Math.floor(body.summary.length / 2)); body.summaryTruncated = true; }
  if (JSON.stringify(body).length + prefix.length > 115000) throw new ChatContractError('recovery_required', 'Legacy terminal evidence exceeds its bounded projection');
  return prefix + JSON.stringify(body);
}

/** A legacy receipt is sufficient only when its result actually survived in canonical history. */
function hasSavedLegacyResult(repository, chat, runId) {
  if (!Array.isArray(chat.subAgentDeliveryReceipts) || !chat.subAgentDeliveryReceipts.includes(runId)) return false;
  const rows = repository.getDatabase().prepare("SELECT payload_json FROM messages WHERE chat_id=? AND role='user' AND hidden=1 AND instr(payload_json,?)>0 ORDER BY seq DESC LIMIT 32").all(chat.id, runId);
  return rows.some(row => {
    const text = messageTextContent(JSON.parse(row.payload_json));
    if (!text.startsWith('[Sub-agent finished]')) return false;
    return text.slice(text.indexOf('\n\n') + 2).split('\n\n---\n\n').some(block => {
      try { const result = JSON.parse(block); return result.runId === runId && ['completed', 'failed', 'cancelled'].includes(result.status); } catch { return false; }
    });
  });
}

/** Trusted journal-to-command compatibility bridge. It never consumes renderer-provided result text. */
export function createLegacyResultDelivery({ repository, context, service, journal = diskJournal, isReady = () => true,
  isBusy = () => false, onChange } = {}) {
  if (!repository || !context || !service) throw new TypeError('Legacy result delivery requires the canonical runtime');
  let closed = false;
  const pending = new Set();
  async function apply(parentChatId, meta) {
    let parent;
    try { parent = repository.getChat(parentChatId); } catch (error) { if (error?.code === 'chat_not_found') return null; throw error; }
    if (parent.chatCommandVersion !== 1) return null;
    const acceptedRunIds = [];
    // Managed nudges have no defined canonical command semantics. Suppress the legacy SSE path.
    if (meta.kind !== 'completion' || closed || !isReady()) return { acceptedRunIds };
    const state = await journal.loadState(parentChatId);
    if (state.parentChatId !== parentChatId) throw new ChatContractError('recovery_required', 'Legacy journal owner does not match its parent');
    for (const runId of new Set(meta.runIds)) {
      const run = state.runs.get(runId);
      if (!run || run.childChatId || run.parentChatId !== parentChatId || !isTerminal(run)) continue;
      parent = repository.getChat(parentChatId);
      if (hasSavedLegacyResult(repository, parent, runId)) { acceptedRunIds.push(runId); continue; }
      const deliveryId = keyFor(parentChatId, runId), message = resultText(run);
      // Freeze the first observed cancellation boundary before policy/model resolution can yield.
      const intent = repository.atomic(() => {
        const saved = repository.getOutbox(deliveryId);
        if (saved) {
          if (saved.kind !== 'legacy.result.intent' || saved.chatId !== parentChatId || saved.payload.runId !== runId || saved.payload.message !== message) throw new ChatContractError('idempotency_conflict', 'Legacy terminal result changed after delivery preparation');
          return saved.payload;
        }
        const current = repository.getChat(parentChatId);
        const stoppedSinceSpawn = repository.getDatabase().prepare("SELECT 1 FROM chat_commands WHERE chat_id=? AND json_extract(payload_json,'$.kind')='stop' AND json_extract(captured_json,'$.stopPinned')=1 AND created_at>=? LIMIT 1").get(parentChatId, run.requestedAt ?? 0);
        const payload = { runId, deliveryId, message, cancellationEpoch: repository.getCancellationEpoch(parentChatId),
          retainOnly: current.subAgentAutoResumeBlocked === true || Boolean(current.archiveImport)
            || run.phase === 'cancelled' || Boolean(stoppedSinceSpawn) };
        repository.putOutbox({ outboxId: deliveryId, chatId: parentChatId, kind: 'legacy.result.intent', payload });
        const claim = repository.claimOutbox(deliveryId, 'legacy-result-intent');
        if (!claim) throw new ChatContractError('ownership_conflict', 'Legacy result preparation is owned elsewhere');
        repository.finishOutbox(deliveryId, claim);
        return payload;
      });
      if (closed || !isReady()) break;
      const target = await context.resolveTarget(parentChatId);
      if (closed || !isReady()) break;
      const caller = createChatCaller({ actor: 'system', ingress: 'server', chatId: 'legacy-result-delivery', scope: target.scope, policy: target.policy });
      // Existing receipts are replayable while busy; new admission rechecks quiescence atomically.
      if (isBusy(parentChatId) && !repository.getDatabase().prepare('SELECT 1 FROM chat_commands WHERE chat_id=? AND request_key=? LIMIT 1').get(parentChatId, deliveryId)) continue;
      try {
        const receipt = await service.admitLegacyCompletion(caller, { chatId: parentChatId, message: intent.message,
          clientRequestId: deliveryId, retainOnly: intent.retainOnly,
          delivery: { runId: provenanceId('run', parentChatId, runId), deliveryId, cancellationEpoch: intent.cancellationEpoch,
            causalRootId: provenanceId('turn', parentChatId, run.parentTurnId || runId) } },
        { canAdmit: () => !closed && isReady() });
        if (!receipt.messageId || !repository.readMessageByIdentity(parentChatId, receipt.messageId)) throw new ChatContractError('recovery_required', 'Legacy completion receipt has no canonical input');
        acceptedRunIds.push(runId);
        try { onChange?.(parentChatId); } catch { /* Presentation cannot reject durable acceptance. */ }
      } catch (error) {
        if (closed || !isReady()) break;
        if (error?.code === 'ownership_conflict' || error?.code === 'queue_full') continue;
        throw error;
      }
    }
    return { acceptedRunIds };
  }
  return {
    deliver(parentChatId, meta) {
      const work = apply(parentChatId, meta); pending.add(work);
      void work.finally(() => pending.delete(work)).catch(() => {});
      return work;
    },
    async dispose() { closed = true; while (pending.size) await Promise.allSettled([...pending]); },
  };
}
