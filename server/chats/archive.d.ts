import type Database from 'better-sqlite3';
export const CHAT_ARCHIVE_VERSION: 1;
export const CHAT_ARCHIVE_TABLES: readonly string[];
export interface ChatArchive {
  version: 1; kind: 'minnow.conversation-archive'; clientProtocol: 1; sqliteVersion: 1; sessionVersion: 6;
  createdAt: number; digest: string; tables: Record<string, Record<string, string | number | null>[]>;
  journals: Array<{ journalOwnerId: string; events: Array<Record<string, any>> }>;
}
export interface ChatArchiveImportReceipt {
  version: 1; digest: string; chatIds: string[]; sourceRevision: number; revision: number;
  journalChunks: number; held: true; replayed: boolean;
}
export function hashChatArchive(value: unknown): string;
export function exportChatArchive(db: Database, options?: { now?: () => number }): ChatArchive;
export function validateChatArchive(db: Database, input: unknown): ChatArchive;
export function importChatArchive(db: Database, input: unknown, options?: { now?: () => number }): ChatArchiveImportReceipt;
export function restoreArchivedJournal(input: ChatArchive['journals'][number]): Promise<void>;
