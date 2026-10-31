import type { ChatRepository, ExecutionRecord, ExecutionLease } from './repository';
import type { ChatCommandService } from './service';
import type { ChatRequestService } from './requests';
import type { ChatTaskDelivery } from './task-delivery';
export interface ChatRecoveryInput { reason?: 'startup' | 'import' | 'restore'; chatIds?: string[] }
export interface ChatRecovery {
  run(input?: ChatRecoveryInput): Promise<{ reason: 'startup' | 'import' | 'restore'; recoveredExecutionIds: string[]; heldExecutionIds: string[] }>;
}
export function restorePendingChatJournals(repository: ChatRepository): Promise<number>;
export function reconcileChatJournalStorage(repository: ChatRepository, options?: { chatIds?: string[] }): Promise<void>;
export function createChatRecovery(options: {
  repository: ChatRepository; service: ChatCommandService; requests: ChatRequestService; taskDelivery: ChatTaskDelivery;
  getTaskAdapter?: () => { recover?(): unknown } | undefined;
  verifyQuiescence(execution: ExecutionRecord, lease?: ExecutionLease): unknown;
  beforeExecutionRecovery?(input: ChatRecoveryInput): { heldExecutionIds?: Iterable<string> } | Promise<{ heldExecutionIds?: Iterable<string> } | undefined> | undefined;
  now?: () => number;
}): ChatRecovery;
