import type { ChatRepository, ExecutionRecord, ExecutionFence } from './repository';
import type { ChatRequestService } from './requests';
import type { TranscriptStore } from '../runner/transcript-store';
import type { ChatExecutionState } from './contracts';
export function createChatQuestionRecovery(options: { repository: ChatRepository; requests: ChatRequestService;
  verifyQuiescence(execution: ExecutionRecord, lease: ExecutionFence | null): unknown | Promise<unknown>;
  validateBoundary?(execution: ExecutionRecord): boolean | Promise<boolean>; onChange?(chatId: string): void }): {
  canResume(execution: ExecutionRecord | null): boolean;
  beforeExecutionRecovery(input?: { reason?: 'startup' | 'restore' | 'import'; chatIds?: string[] }): Promise<{ heldExecutionIds: Set<string> }>;
  hydrate(input: { execution: ExecutionRecord; fence: ExecutionFence; transcript: TranscriptStore; signal: AbortSignal;
    assertAllowed(): Promise<void>; status(value: ChatExecutionState): void }): Promise<void>;
};
