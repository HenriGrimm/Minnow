import type { Database } from 'better-sqlite3';
import type { AgentConversationMeta } from './contracts.js';
export function initChatConversationSchema(db: Database): void;
export function isManagedConversation(db: Database, chatId: string): boolean;
export function readAgentConversationProjection(db: Database, chatId: string): AgentConversationMeta | undefined;
export function isDeletedConversation(db: Database, chatId: string): boolean;
export function isDeletedManagedConversation(db: Database, chatId: string): boolean;
