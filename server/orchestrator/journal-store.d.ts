import type { BoardState, Evidence, Snapshot } from './core/types';

export const BOARDS_NAMESPACE: 'boards';

/** Path-safe segment for a namespace or entry id. Throws on `..` / odd characters. */
export function safeSegment(value: string, kind?: string): string;

/**
 * Directory for one journaled entry: `~/.minnow/<namespace>/<id>/`.
 */
export function entryDir(namespace: string, id: string, idKind?: string): string;
export function journalFile(namespace: string, id: string, idKind?: string): string;
export function snapshotFile(namespace: string, id: string, idKind?: string): string;

export interface JournalStoreOptions {
  namespace: string;
  /** Noun in `invalid <idKind> id` errors. Boards pass `'board'`. */
  idKind?: string;
  fold: (events: Record<string, unknown>[]) => unknown;
  foldFrom?: (snapshot: unknown, events: Record<string, unknown>[]) => unknown;
  isSnapshotUsable?: (snapshot: unknown, events: Record<string, unknown>[]) => boolean;
  makeSnapshot?: (id: string, state: unknown, through: number) => unknown;
  shouldSnapshot?: (seq: number) => boolean;
  validate?: (event: unknown) => { ok: true } | { ok: false; error: string };
  queryAbandonments?: (events: Record<string, unknown>[]) => unknown[];
}

export interface JournalStore {
  readonly namespace: string;
  entryDir(id: string): string;
  journalPath(id: string): string;
  snapshotPath(id: string): string;
  readEvents(id: string): Promise<Record<string, unknown>[]>;
  readHighestSeq(id: string): Promise<number>;
  appendEvent(
    id: string,
    event: Record<string, unknown>,
    options?: { now?: () => number; idempotencyKey?: string },
  ): Promise<Record<string, unknown>>;
  appendEvents(
    id: string,
    events: Record<string, unknown>[],
    options?: { now?: () => number },
  ): Promise<Record<string, unknown>[]>;
  writeSnapshot(id: string, snapshot: unknown): Promise<void>;
  readSnapshot(id: string): Promise<unknown | null>;
  refreshSnapshot(id: string): Promise<void>;
  loadState(id: string): Promise<unknown>;
  loadAbandonments(id: string): Promise<unknown[]>;
  createEntry(id: string): Promise<void>;
  entryExists(id: string): Promise<boolean>;
  deleteEntry(id: string): Promise<boolean>;
  listEntries(): Promise<string[]>;
  resetCache(): void;
}

export function createJournalStore(options: JournalStoreOptions): JournalStore;

export type { BoardState, Evidence, Snapshot };
