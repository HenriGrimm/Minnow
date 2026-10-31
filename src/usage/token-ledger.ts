/** Renderer notifications around the shared token ledger arithmetic. */
import { randomUUID } from '../lib/random-id.ts';
import { notifyPluginContextChanged } from '../plugins/events';
import type { Chat } from '../types';
import { recordTokenUsage as appendTokenUsage, resetTokenLedger as resetLedger,
  type RecordTokenUsageInput } from '../../server/usage/ledger.js';

export {
  EMPTY_LEDGER_TOTALS, emptyLedger, sourceKey, formatSourceLabel, formatUsd,
  mergeTotals, ensureTokenLedger, sumSessionLedgerTotals, mergeSessionBySource,
} from '../../server/usage/ledger.js';
export type { RecordTokenUsageInput } from '../../server/usage/ledger.js';

export function resetTokenLedger(chat: Chat): void {
  resetLedger(chat);
  notifyPluginContextChanged();
}

export function recordTokenUsage(chat: Chat, input: RecordTokenUsageInput) {
  const entry = appendTokenUsage(chat, { ...input, id: input.id ?? randomUUID(), at: input.at ?? Date.now() });
  if (entry) notifyPluginContextChanged();
  return entry;
}
