import type { ChatRepository, OutboxRecord } from './repository.js';
export function createChatOutbox(options: {
  repository: ChatRepository;
  handlers: Readonly<Record<string, (entry: OutboxRecord) => void | Promise<void>>>;
  ownerId?: string;
  leaseMs?: number;
}): { drain(options?: { limit?: number }): Promise<{ applied: number; failed: number; skipped: number }> };
