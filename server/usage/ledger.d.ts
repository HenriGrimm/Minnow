import type { Chat, Stats, Usage } from '../../src/types';
import type { ChatTokenLedger, TokenLedgerBySource, TokenLedgerEntry, TokenLedgerSource, TokenLedgerTotals, TokenLedgerWriteSource } from '../../src/usage/types';
export const TOKEN_LEDGER_ENTRY_CAP: 200;
export const EMPTY_LEDGER_TOTALS: TokenLedgerTotals;
export function emptyLedger(): ChatTokenLedger;
export function sourceKey(source: TokenLedgerSource): string;
export function formatSourceLabel(source: TokenLedgerSource): string;
export function formatUsd(amount: number | null | undefined): string;
export function mergeTotals(base: TokenLedgerTotals, usage: Usage, costUsd: number | null): TokenLedgerTotals;
export function ensureTokenLedger(chat: Pick<Chat, 'tokenLedger'>): ChatTokenLedger;
export function resetTokenLedger(chat: Pick<Chat, 'tokenLedger'>): void;
export interface RecordTokenUsageInput {
  id?: string; at?: number; source: TokenLedgerWriteSource; providerId: string; modelId: string;
  usage: Usage; stats?: Stats; costUsd: number | null;
}
export function recordTokenUsage(chat: Pick<Chat, 'tokenLedger'>, input: RecordTokenUsageInput): TokenLedgerEntry | null;
export function sumSessionLedgerTotals(chats: Array<Pick<Chat, 'tokenLedger'>>): TokenLedgerTotals;
export function mergeSessionBySource(chats: Array<Pick<Chat, 'tokenLedger'>>): TokenLedgerBySource;
