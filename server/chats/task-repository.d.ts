import type { ChatTaskResult, TaskCompletionPolicy } from './contracts';
import type { ChatRepository, CommandRecord } from './repository';
export type TaskSubscriptionState = 'active' | 'inline_hold' | 'inline_returned' | 'accepted' | 'delivered' | 'local_only' | 'disposed';
export interface TaskSubscription {
  runId: string; subscriptionId: string; policy: TaskCompletionPolicy; recipientChatId: string | null;
  cancellationEpoch: number; state: TaskSubscriptionState; holdExecutionId: string | null;
  holdToolCallId: string | null; cohortId: string | null; disposition: string | null; updatedAt: number;
}
export interface CompletionCohort {
  cohortId: string; recipientChatId: string; cancellationEpoch: number; state: 'open' | 'sealed' | 'admitted' | 'disposed';
  commandId: string | null; disposition: string | null; createdAt: number; runIds: string[]; groupKey: string | null;
}
export interface ChatTaskRepository {
  getResult(runId: string): ChatTaskResult | null;
  saveResult(result: ChatTaskResult, options: { commandId: string }): ChatTaskResult;
  listResults(options?: { journalOwnerId?: string; limit?: number }): ChatTaskResult[];
  getSubscription(runId: string): TaskSubscription | null;
  ensureSubscription(input: { runId: string; policy: TaskCompletionPolicy; inlineWait?: { chatId: string; executionId: string; toolCallId: string } }): TaskSubscription;
  listSubscriptions(options?: { recipientChatId?: string; states?: TaskSubscriptionState[]; limit?: number }): TaskSubscription[];
  setSubscription(runId: string, patch: { state: TaskSubscriptionState; disposition?: string }): TaskSubscription;
  getCohort(cohortId: string): CompletionCohort | null;
  coalesce(input: { recipientChatId: string; cancellationEpoch: number; runIds: string[]; groupKey?: string }): CompletionCohort | null;
  listCohorts(options?: { recipientChatId?: string; states?: CompletionCohort['state'][]; limit?: number }): CompletionCohort[];
  seal(cohortId: string): CompletionCohort;
  settleCohort(cohortId: string, patch: { state: 'admitted' | 'disposed'; commandId?: string; disposition?: string }): CompletionCohort;
  descendantChatIds(chatId: string): string[];
  commandForRun(runId: string): CommandRecord | null;
  canonicalToolResult(input: { chatId: string; executionId: string; toolCallId: string; runId: string }): Record<string, any> | null;
}
export function createChatTaskRepository(options: { repository: ChatRepository; now?: () => number }): ChatTaskRepository;
