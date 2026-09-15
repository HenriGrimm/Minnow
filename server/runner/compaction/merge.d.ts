import type { CompactionState } from './index.js';

export declare const STATE_CAPS: Readonly<{
  scopeChanges: number;
  notes: number;
  files: number;
  commits: number;
  subAgents: number;
  turns: number;
  problems: number;
  todos: number;
}>;
export declare function emptyCompactionState(): CompactionState;
export declare function cloneCompactionState(raw: unknown): CompactionState;
export declare function pushCapped<T>(list: T[], item: T, cap: number): void;
export declare function addUniqueText(list: string[], text: string, cap: number): void;
export declare function noteFile(
  state: CompactionState,
  path: string,
  op: string,
  extra?: { additions?: number; deletions?: number; row?: number | null },
): void;
export declare function noteProblem(
  state: CompactionState,
  key: string,
  next: { text: string; row: number | null; error: boolean },
): void;
