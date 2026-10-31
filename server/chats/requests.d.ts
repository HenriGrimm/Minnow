import type { ChatRequest } from './contracts';
import type { ChatRepository, ExecutionFence } from './repository';
import type { ChatCaller } from './caller';

export interface ChatRequestService {
  openLegacy(input: { caller: ChatCaller; toolCallId: string; kind?: 'approval'; title: string; presentation: Record<string, unknown>; expiresAt?: number }): ChatRequest;
  open(input: { chatId: string; executionId: string; toolCallId: string; kind: 'question' | 'approval'; title: string; presentation: Record<string, unknown>; expiresAt?: number; fence: ExecutionFence }): ChatRequest;
  wait(requestId: string, options?: { signal?: AbortSignal }): Promise<unknown>;
  respond(requestId: string, input: { answerCommandId: string; answer: unknown; context?: unknown }): Promise<{ request: ChatRequest; answer: unknown; replayed: boolean }>;
  expireExecution(executionId: string, chatId: string, state?: 'expired' | 'cancelled'): ChatRequest[];
  hasLiveWaiter(requestId: string): boolean;
  expireUnownedLegacyApprovals(): ChatRequest[];
}
export function createChatRequestService(options: {
  repository: ChatRepository;
  authorizeResponse?: (request: ChatRequest, context: unknown) => boolean | Promise<boolean>;
  assertLegacyOwner?: (caller: ChatCaller) => boolean;
  now?: () => number;
  pollMs?: number;
  onChange?: (request: ChatRequest) => void;
}): ChatRequestService;
