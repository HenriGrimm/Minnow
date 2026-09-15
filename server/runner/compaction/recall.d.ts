export declare const RECALL_HISTORY_TOOL_NAME = 'recall_history';
export declare const RECALL_HITS_PER_PAGE = 5;
export declare const RECALL_ROWS_PER_PAGE = 20;
export declare const RECALL_HISTORY_TOOL_DEFINITION: Readonly<{
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}>;
/**
 * `recall_history` over unprojected rows: `query` → BM25 hits grouped by turn
 * (5 per page); `rows` → a verbatim slice (tool bodies previewed unless
 * `include_tool_results`).
 */
export declare function runRecallHistory(
  entries: ReadonlyArray<{ id: number; row: unknown }>,
  rawArgs: unknown,
  options?: {
    /** Ids ranked by another index (SQLite FTS), best first; fused with the local BM25 ranking. */
    ranking?: ReadonlyArray<number> | null;
  },
): string;
/** Search words of a recall query, tokenized as the local ranker does. */
export declare function recallQueryTerms(query: unknown): string[];
/** Reciprocal-rank fusion of ranked id lists (best first). */
export declare function fuseRecallRankings(
  rankings: ReadonlyArray<ReadonlyArray<number>>,
): Array<{ id: number; score: number }>;
