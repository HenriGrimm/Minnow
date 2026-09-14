import type { CompactionState } from './index.js';

export declare const MAX_SUMMARY_BUDGET_TOKENS = 6000;
export declare const SUMMARY_WINDOW_SHARE = 0.12;
export declare const MIN_SUMMARY_BUDGET_TOKENS = 400;
/** `min(6k, 12% of window)`, floored at {@link MIN_SUMMARY_BUDGET_TOKENS}. */
export declare function defaultSummaryBudgetTokens(windowTokens: number | null | undefined): number;
/** Deterministic summary text: same state and budget → same bytes. */
export declare function formatCompactionSummary(state: CompactionState, options: { budgetTokens: number }): string;
