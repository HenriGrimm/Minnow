import { createHash } from 'node:crypto';
import { recordTokenUsage } from '../usage/ledger.js';
import { computeCostUsd, hasMeasurableUsage, resolveModelPricing } from '../runner/usage-pricing.js';
import { finalizeResponseMeta } from '../runner/response-meta.js';
import { ChatContractError, validateModelSelection } from './contracts.js';
import { hashChatPayload } from './repository.js';

function fail(code, message) { throw new ChatContractError(code, message); }
function finite(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }

/** One canonical receipt and child ledger entry for each actual model completion. */
export function createChatUsage({ repository, readProviderPricing = async providerId =>
  (await import('../providers/store.js')).getProvider(providerId).then(provider => provider.pricing ?? null), now = Date.now } = {}) {
  if (!repository || typeof repository.getDatabase !== 'function') throw new TypeError('Chat usage requires its canonical repository');
  const db = repository.getDatabase();
  return {
    nextRoundIndex(executionId) {
      return (db.prepare('SELECT MAX(round_index) AS round_index FROM chat_usage_receipts WHERE execution_id=?').get(executionId)?.round_index ?? -1) + 1;
    },
    async recordRound({ executionId, roundIndex, fence, turn, modelSelection }) {
      if (!Number.isSafeInteger(roundIndex) || roundIndex < 0) fail('invalid_request', 'Invalid completion index');
      const execution = repository.getExecution(executionId);
      if (!execution || fence?.executionId !== executionId) fail('ownership_conflict', 'Usage must belong to its current execution');
      repository.assertFence(execution.chatId, fence);
      const usage = turn?.streamMeta?.usage;
      if (!usage || !hasMeasurableUsage(usage)) return null;
      for (const name of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
        if (usage[name] !== undefined && !finite(usage[name])) fail('invalid_request', 'Invalid provider usage');
      }
      const checked = validateModelSelection(modelSelection ?? { providerId: turn.providerId, modelId: turn.modelId });
      if (!checked.ok) fail('invalid_request', 'Usage requires its actual provider and model');
      const selected = checked.value;
      const meta = finalizeResponseMeta(turn.streamMeta, finite(turn.t0) ? turn.t0 : 0,
        finite(turn.tFirst) ? turn.tFirst : finite(turn.tEnd) ? turn.tEnd : 0, finite(turn.tEnd) ? turn.tEnd : 0);
      const reportedCostUsd = turn.streamMeta.minnow_cli?.cost_usd;
      const intent = { executionId, roundIndex, providerId: selected.providerId, modelId: selected.modelId,
        usage, stats: meta.stats ?? {}, ...(finite(reportedCostUsd) ? { reportedCostUsd } : {}) };
      const inputHash = hashChatPayload(intent);
      function previous() {
        const prior = db.prepare('SELECT payload_hash,payload_json FROM chat_usage_receipts WHERE execution_id=? AND round_index=?').get(executionId, roundIndex);
        if (!prior) return null;
        if (prior.payload_hash !== inputHash) fail('idempotency_conflict', 'A completion usage receipt is immutable');
        return { ...JSON.parse(prior.payload_json), replayed: true };
      }
      const replay = previous(); if (replay) return replay;
      let pricing = null;
      try { pricing = await readProviderPricing(selected.providerId); } catch { /* Provider-reported tokens remain authoritative without pricing. */ }
      const costUsd = finite(reportedCostUsd) ? reportedCostUsd : computeCostUsd(usage, resolveModelPricing(pricing, selected.modelId));
      return repository.atomic(() => {
        repository.assertFence(execution.chatId, fence);
        const replay = previous(); if (replay) return replay;
        const row = db.prepare('SELECT meta_json,mode_id FROM chats WHERE id=?').get(execution.chatId);
        if (!row) fail('chat_not_found', 'Usage conversation no longer exists');
        const chat = JSON.parse(row.meta_json || '{}');
        const id = 'usage-' + createHash('sha256').update(executionId + ':' + roundIndex).digest('hex');
        const entry = recordTokenUsage(chat, { id, at: now(),
          source: execution.runId ? { kind: 'sub-agent', subAgentType: chat.agentTypeId ?? 'agent', runId: execution.runId }
            : { kind: 'main', modeId: row.mode_id, workAgentId: chat.workAgentId ?? null },
          providerId: selected.providerId, modelId: selected.modelId, usage, costUsd, stats: meta.stats });
        const receipt = { executionId, roundIndex, chatId: execution.chatId, entry };
        db.prepare('INSERT INTO chat_usage_receipts(execution_id,round_index,chat_id,payload_hash,payload_json,created_at) VALUES(?,?,?,?,?,?)')
          .run(executionId, roundIndex, execution.chatId, inputHash, JSON.stringify(receipt), now());
        chat.lastStats = meta.stats ?? null;
        db.prepare('UPDATE chats SET meta_json=? WHERE id=?').run(JSON.stringify(chat), execution.chatId);
        // Share revision stamping with the canonical owner without rewriting any transcript.
        repository.updateExecutionActivity(executionId, selected.providerId === 'minnow-router' ? {} :
          { resolvedModel: { providerId: selected.providerId, modelId: selected.modelId } }, { fence });
        return { ...receipt, replayed: false };
      });
    },
  };
}
