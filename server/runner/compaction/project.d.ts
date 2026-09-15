import type { ApiMessage } from '../../../src/types.js';

export declare function stripCompactionSummary(text: string): string;
export declare function unmergeSummaryRow<T>(row: T): T;
/** Apply a checkpoint to unprojected rows: `[system][summary][verbatim tail]`. */
export declare function projectMessages(
  rows: ReadonlyArray<ApiMessage>,
  ids: ReadonlyArray<number | null>,
  checkpoint: { foldThroughRow?: number | null; elideThroughRow?: number | null; summary?: string } | null | undefined,
): {
  messages: ApiMessage[];
  ids: Array<number | null>;
  synthetic: Set<ApiMessage>;
  foldedRows: number;
  elidedRows: number;
};
