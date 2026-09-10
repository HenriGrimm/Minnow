/** Production Super Plan journals. Runs live at `~/.minnow/superplan/<runId>/journal.jsonl`. */
export const SUPERPLAN_NAMESPACE: 'superplan';

/** @param {string} runId */
export function runDir(runId: string): string;

/** @param {string} runId */
export function journalPath(runId: string): string;

export const readEvents: (id: string) => Promise<Record<string, unknown>[]>;
export const readHighestSeq: (id: string) => Promise<number>;
export const appendEvent: (
  id: string,
  event: Record<string, unknown>,
  opts?: { now?: () => number },
) => Promise<Record<string, unknown>>;
export const appendEvents: (
  id: string,
  events: Record<string, unknown>[],
  opts?: { now?: () => number },
) => Promise<Record<string, unknown>[]>;
export const loadState: (id: string) => Promise<unknown>;
export const createEntry: (id: string) => Promise<void>;
export const entryExists: (id: string) => Promise<boolean>;
export const deleteEntry: (id: string) => Promise<boolean>;
export const listEntries: () => Promise<string[]>;
export const resetJournalCache: () => void;
