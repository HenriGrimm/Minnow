import type { ChatRepository } from './repository.js';
import type { ChatServiceEvent } from './service.js';
import type { ChatHostEvent } from './execution-host.js';
export interface ChatPresentation {
  frame(chatId: string, options?: { history?: boolean; metadata?: boolean }): any;
  changed(chatId: string, withHistory?: boolean): void;
  externalRequestChanged(input: { chatId: string; projectId: string }): void;
  onEvent(event: ChatHostEvent): void;
  onServiceEvent(event: ChatServiceEvent): void;
  subscribe(input: { projectId: string; chatId?: string; send: (event: any) => void }): () => void;
  dispose(): void;
}
export function createChatPresentation(options: { repository: ChatRepository; now?: () => number; flushMs?: number }): ChatPresentation;
