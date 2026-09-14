/** One API/transcript row stored by {@link TranscriptStore}. */
export interface TranscriptMessage {
  role: string;
  content?: unknown;
}

/** Parent-chat fields the runner reads (thinking / reasoning). */
export interface TranscriptMeta {
  thinkingMode?: unknown;
  reasoningEffort?: unknown;
}

export interface TranscriptRecord {
  messages: TranscriptMessage[];
  /** Store id of each message when it differs from its index (filtered chat history). */
  rowIds?: number[];
  meta: TranscriptMeta;
}

/**
 * Injected session seam. Removes `src/state/sessions.ts` from the runner.
 * `load` is synchronous so the existing turn loop does not become async at read.
 */
export interface TranscriptStore {
  load(chatId: string): TranscriptRecord | null;
  /** Returns the stored row's id (-1 when the store keeps no row), or nothing for positional stores. */
  append(chatId: string, message: TranscriptMessage): number | void;
  setMeta(chatId: string, meta: TranscriptMeta): void;
}

/** Empty in-memory store for Node / tests — no session store required. */
export function createMemoryTranscriptStore(): TranscriptStore;
