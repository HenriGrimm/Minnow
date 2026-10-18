import { isInProgressStatus, statusIdForRole } from '../../issues/taxonomy';
import { getIssuesTaxonomySync } from '../../state/issues-taxonomy-store';
import { appendIssueActivity, listIssues, updateIssue } from '../../state/issues-store';
import { findChatById } from '../../state/sessions';
import { getChatRunActivity, type ChatRunActivityStatus } from '../../state/chat-run-activity';

/** Successful implementation turns hand linked issues back for human review. */
export function markIssuesReviewForChatComplete(chatId: string, outcome: ChatRunActivityStatus): string[] {
  if (outcome !== 'completed') return [];
  const chat = findChatById(chatId);
  if (!chat || (chat.modeId !== 'build' && chat.modeId !== 'debug')) return [];
  const taxonomy = getIssuesTaxonomySync();
  const review = statusIdForRole(taxonomy, 'review');
  if (!review) return [];
  const updated: string[] = [];
  for (const issue of listIssues()) {
    if (!issue.chatIds?.includes(chatId) || !isInProgressStatus(taxonomy, issue.status)) continue;
    if (issue.agent?.phase === 'awaiting_input') continue;
    if (issue.chatIds.some((id) => id !== chatId && getChatRunActivity(id, findChatById(id)) === 'running')) continue;
    const from = issue.status;
    updateIssue(issue.id, { status: review });
    appendIssueActivity(issue.id, { kind: 'chat-completed', actorKind: 'system', data: { chatId, from, to: review } });
    updated.push(issue.id);
  }
  return updated;
}
