import type { CompactionState } from './index.js';

export declare function isFailureOutput(content: string, options?: { flagged?: boolean; command?: boolean }): boolean;
/** Fold rows (oldest first) into a copy of `prev`. Pure and deterministic. */
export declare function ingestRows(
  prev: unknown,
  entries: ReadonlyArray<{ id: number | null; row: unknown }>,
  options?: { notes?: string | null },
): CompactionState;
