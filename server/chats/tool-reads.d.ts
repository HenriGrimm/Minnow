import type { ChatRepository } from './repository';
export const CHAT_READ_MAX_BYTES: number;
export function createChatToolReads(repository: ChatRepository): {
  execution(chatId: string, executionId?: string): Record<string, any> | null;
  candidates(afterPosition: number, limit: number, includeChildren: boolean, workspaceKeys: string[]): Array<{ position: number; id: string }>;
  activity(chatId: string, executionId?: string): Record<string, any>;
  messages(chatId: string, afterSequence: number, limit: number): Record<string, any>;
  finalText(executionId: string): string;
};
