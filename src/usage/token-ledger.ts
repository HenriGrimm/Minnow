/**
 * Per-chat token ledger: append entries, roll up totals, cap history length.
 */

import { randomUUID } from '../lib/random-id.ts';
import type { Chat } from '../types';
import type { Stats, Usage } from '../types';
import {
  TOKEN_LEDGER_ENTRY_CAP,
  type ChatTokenLedger,
  type TokenLedgerBySource,
  type TokenLedgerEntry,
  type TokenLedgerSource,
  type TokenLedgerTotals,
  type TokenLedgerWriteSource,
} from './types.ts';
import { hasMeasurableUsage, usageTokenCounts } from './pricing.ts';

export const EMPTY_LEDGER_TOTALS: TokenLedgerTotals = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  costUsd: 0,
  completionCount: 0,
};

/** Fresh ledger for a chat with no recorded completions. */
export function emptyLedger(): ChatTokenLedger {
  return {
    entries: [],
    totals: { ...EMPTY_LEDGER_TOTALS },
    bySource: {},
  };
}

/** Stable rollup key for a completion source. */
export function sourceKey(source: TokenLedgerSource): string {
  switch (source.kind) {
    case 'main': {
      const mode = source.modeId.trim() || 'unknown';
      const agent = source.workAgentId?.trim();
      return agent ? `main:${mode}:${agent}` : `main:${mode}`;
    }
    case 'sub-agent':
      return `sub-agent:${source.subAgentType.trim() || 'unknown'}`;
    case 'title':
      return 'title';
    case 'utility':
      return `utility:${source.task.trim() || 'unknown'}`;
    case 'reef-widget':
      return 'reef-widget';
    case 'orchestrate-board':
      return 'orchestrate-board';
    case 'work-agent':
      return `work-agent:${source.workAgentId.trim() || 'unknown'}`;
    default:
      return 'unknown';
  }
}

/** Human-readable label for settings tables. */
export function formatSourceLabel(source: TokenLedgerSource): string {
  switch (source.kind) {
    case 'main': {
      const mode = source.modeId.trim() || 'main';
      const agent = source.workAgentId?.trim();
      return agent ? `Main (${mode}) · ${agent}` : `Main (${mode})`;
    }
    case 'sub-agent':
      return `Sub-agent (${source.subAgentType})`;
    case 'title':
      return 'Chat title';
    case 'utility':
      return source.task === 'followup-task' ? 'Follow-up task' : 'Utility task';
    case 'reef-widget':
      return 'Legacy widget (Reef)';
    case 'orchestrate-board':
      return 'Orchestrate board';
    case 'work-agent':
      return `Work agent (${source.workAgentId})`;
    default:
      return 'Unknown';
  }
}

/** Format USD for display (4 decimals or "< $0.01"). */
export function formatUsd(amount: number | null | undefined): string {
  if (amount == null || !Number.isFinite(amount)) return '$0.00';
  if (amount > 0 && amount < 0.01) return '< $0.01';
  return `$${amount.toFixed(4)}`;
}

function addTotals(base: TokenLedgerTotals, usage: Usage, costUsd: number | null): TokenLedgerTotals {
  const counts = usageTokenCounts(usage);
  return {
    promptTokens: base.promptTokens + counts.promptTokens,
    completionTokens: base.completionTokens + counts.completionTokens,
    totalTokens: base.totalTokens + counts.totalTokens,
    costUsd: base.costUsd + (costUsd ?? 0),
    completionCount: base.completionCount + 1,
  };
}

/** Merge usage into running totals (immutable). */
export function mergeTotals(
  base: TokenLedgerTotals,
  usage: Usage,
  costUsd: number | null,
): TokenLedgerTotals {
  return addTotals(base, usage, costUsd);
}

/** Ensure chat has a ledger object after session load. */
export function ensureTokenLedger(chat: Chat): ChatTokenLedger {
  if (!chat.tokenLedger || typeof chat.tokenLedger !== 'object') {
    chat.tokenLedger = emptyLedger();
    return chat.tokenLedger;
  }
  const ledger = chat.tokenLedger;
  if (!Array.isArray(ledger.entries)) ledger.entries = [];
  if (!ledger.totals || typeof ledger.totals !== 'object') {
    ledger.totals = { ...EMPTY_LEDGER_TOTALS };
  }
  if (!ledger.bySource || typeof ledger.bySource !== 'object') {
    ledger.bySource = {};
  }
  return ledger;
}

/** Reset ledger when chat history is cleared. */
export function resetTokenLedger(chat: Chat): void {
  chat.tokenLedger = emptyLedger();
}

export interface RecordTokenUsageInput {
  id?: string;
  at?: number;
  source: TokenLedgerWriteSource;
  providerId: string;
  modelId: string;
  usage: Usage;
  stats?: Stats;
  costUsd: number | null;
}

/** Retired MIN-473 kind; JS callers can still pass it even though WriteSource excludes it. */
function isRetiredUsageKind(kind: string): boolean {
  return kind === 'reef-widget';
}

/**
 * Append one completion to the chat ledger and update rollups.
 * Skips when usage has no measurable tokens.
 */
export function recordTokenUsage(chat: Chat, input: RecordTokenUsageInput): TokenLedgerEntry | null {
  if (!hasMeasurableUsage(input.usage)) return null;
  // Reef widgets are gone; never grow historical reef-widget ledger rows.
  if (isRetiredUsageKind(input.source.kind)) return null;

  const ledger = ensureTokenLedger(chat);
  const key = sourceKey(input.source);
  const entry: TokenLedgerEntry = {
    id: input.id ?? randomUUID(),
    at: input.at ?? Date.now(),
    source: input.source,
    providerId: input.providerId,
    modelId: input.modelId,
    usage: { ...input.usage },
    ...(input.stats && Object.keys(input.stats).length > 0 ? { stats: { ...input.stats } } : {}),
    costUsd: input.costUsd,
  };

  ledger.entries.push(entry);
  if (ledger.entries.length > TOKEN_LEDGER_ENTRY_CAP) {
    ledger.entries.splice(0, ledger.entries.length - TOKEN_LEDGER_ENTRY_CAP);
  }

  ledger.totals = mergeTotals(ledger.totals, input.usage, input.costUsd);
  const prevSource = ledger.bySource[key] ?? { ...EMPTY_LEDGER_TOTALS };
  ledger.bySource[key] = mergeTotals(prevSource, input.usage, input.costUsd);

  return entry;
}

/** Sum ledger totals across multiple chats (session rollup). */
export function sumSessionLedgerTotals(chats: Chat[]): TokenLedgerTotals {
  let acc = { ...EMPTY_LEDGER_TOTALS };
  for (const chat of chats) {
    const ledger = chat.tokenLedger;
    if (!ledger?.totals) continue;
    const t = ledger.totals;
    acc = {
      promptTokens: acc.promptTokens + (t.promptTokens ?? 0),
      completionTokens: acc.completionTokens + (t.completionTokens ?? 0),
      totalTokens: acc.totalTokens + (t.totalTokens ?? 0),
      costUsd: acc.costUsd + (t.costUsd ?? 0),
      completionCount: acc.completionCount + (t.completionCount ?? 0),
    };
  }
  return acc;
}

/** Merge all bySource maps across chats for session-level breakdown. */
export function mergeSessionBySource(chats: Chat[]): TokenLedgerBySource {
  const out: TokenLedgerBySource = {};
  for (const chat of chats) {
    const bySource = chat.tokenLedger?.bySource;
    if (!bySource) continue;
    for (const [key, totals] of Object.entries(bySource)) {
      const prev = out[key] ?? { ...EMPTY_LEDGER_TOTALS };
      out[key] = {
        promptTokens: prev.promptTokens + totals.promptTokens,
        completionTokens: prev.completionTokens + totals.completionTokens,
        totalTokens: prev.totalTokens + totals.totalTokens,
        costUsd: prev.costUsd + totals.costUsd,
        completionCount: prev.completionCount + totals.completionCount,
      };
    }
  }
  return out;
}
