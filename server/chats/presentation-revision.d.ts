import type { Database } from 'better-sqlite3';
export function hasChatPresentationChanges(before: Record<string, unknown>, after: Record<string, unknown>): boolean;
export function readChatPresentationRevision(db: Database, chatId: string): number | null;
export function readChatPresentationRevisions(db: Database, chatIds: Iterable<string>): Record<string, number>;
export function advanceChatPresentationRevision(db: Database, chatId: string): number | null;
