import type { AgentsState } from './types';

export { AGENTS_NAMESPACE } from './derive';

export function agentsDir(parentChatId: string): string;
export function journalPath(parentChatId: string): string;

export function readEvents(parentChatId: string): Promise<Record<string, unknown>[]>;
export function readHighestSeq(parentChatId: string): Promise<number>;
export function appendEvent(
  parentChatId: string,
  event: Record<string, unknown>,
  options?: { now?: () => number; idempotencyKey?: string },
): Promise<Record<string, unknown>>;
export function appendEvents(
  parentChatId: string,
  events: Record<string, unknown>[],
  options?: { now?: () => number },
): Promise<Record<string, unknown>[]>;
export function loadState(parentChatId: string): Promise<AgentsState>;
export function createEntry(parentChatId: string): Promise<void>;
export function entryExists(parentChatId: string): Promise<boolean>;
export function deleteEntry(parentChatId: string): Promise<boolean>;
export function listEntries(): Promise<string[]>;
export function resetJournalCache(): void;
