export declare const COMPACTION_HEADER_PREFIX = '## Prior context (';
export declare const COMPACTION_MERGE_MARK = '[End of prior context]';
export declare function rowText(msg: unknown): string;
/** A user row carrying a compaction summary, alone or merged into a request. */
export declare function hasCompactionSummary(msg: unknown): boolean;
/** A user row that is only a summary. */
export declare function isSummaryOnlyRow(msg: unknown): boolean;
/** A user row someone typed (or a request merged under a summary). */
export declare function isRealUserRow(msg: unknown): boolean;
export declare function roundEndAt(rows: ReadonlyArray<unknown>, start: number, end?: number): number;
export interface SegmentedTurn {
  start: number;
  end: number;
  /** Index of the turn's real user row, or -1 for a headless turn. */
  userIndex: number;
  rounds: Array<{ start: number; end: number }>;
}
export declare function segmentTurns(rows: ReadonlyArray<unknown>, from?: number, to?: number): SegmentedTurn[];
export declare function indexToolCalls(
  rows: ReadonlyArray<unknown>,
): Map<string, { name: string; args: Record<string, unknown> }>;
export declare function parseToolArgs(raw: unknown): Record<string, unknown>;
export declare function oneLine(text: string, max: number): string;
export declare function capText(text: string, max: number): string;
