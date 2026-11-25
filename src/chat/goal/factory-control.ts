import type { Chat } from '../../types';
import { notifyManagedChatMetadata } from '../managed-chat-view';
import { syncGoalActiveHint } from '../../ui/goal-active-hint';

/** A stale window may only act on the factory it actually displayed. */
export async function controlFactoryGoal(chat: Chat, action: 'clear' | 'resume'): Promise<void> {
  const runId = chat.activeGoal?.factoryRunId;
  if (!runId) return;
  const response = await fetch('/api/chats/' + encodeURIComponent(chat.id) + '/factory', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Minnow-Chat-Protocol': '1' },
    body: JSON.stringify({ runId, action }), signal: AbortSignal.timeout(10000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message || 'Could not update the factory run.');
  if (chat.activeGoal?.factoryRunId === runId) chat.activeGoal = result.goal ?? undefined;
  notifyManagedChatMetadata(chat.id);
  syncGoalActiveHint();
}
