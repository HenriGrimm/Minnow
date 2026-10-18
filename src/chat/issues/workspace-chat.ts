import { ensureBackgroundChat } from '../../state/background-chat';
import { applyChatRunTargetChoice, type ChatRunTargetChoice } from '../../state/chat-worktree';
import { appendIssueActivity, appendIssueLinks, defaultIssuePlanPath, findIssueById, requireIssueStatusForRole, updateIssue } from '../../state/issues-store';
import { formatCodeRefLabel } from '../../attachments/code-ref-format';
import type { Attachment } from '../../attachments/types';
import { ensureSessionsReady, scheduleSaveSessions, touchChat } from '../../state/sessions';
import { isChatStreaming } from '../streaming-state';
import { canRunIssueWorkflow, buildIssueForegroundModeSeed, type IssueForegroundChatMode } from './workflow-seeds';
import { getChatRunActivity, setChatRunActivity } from '../../state/chat-run-activity';
import { randomUUID } from '../../lib/random-id';

/** Issue-owned chats run on the shared engine without changing the foreground app. */
export async function runIssueWorkspaceChat(
  issueId: string,
  modeId: IssueForegroundChatMode,
  runTarget?: ChatRunTargetChoice,
): Promise<{ ok: boolean; chatId?: string; error?: string; planPath?: string }> {
  try {
    const issue = findIssueById(issueId);
    if (!issue || !canRunIssueWorkflow(issue)) return { ok: false, error: 'Issue is unavailable or closed' };
    await ensureSessionsReady();
    const chat = ensureBackgroundChat({ key: `issue-chat:${issue.id}:${randomUUID()}`, name: `${issue.id}: ${issue.title}`, workspacePath: issue.workspacePath, modeId });
    if (!chat) return { ok: false, error: 'Chats are not ready yet' };
    if (isChatStreaming(chat.id) || getChatRunActivity(chat.id, chat) === 'running') return { ok: false, error: 'This issue chat is already running', chatId: chat.id };
    if (runTarget) {
      const result = await applyChatRunTargetChoice(chat, runTarget);
      if (!result.ok) return { ok: false, error: result.error || 'Could not set run target', chatId: chat.id };
    }
    appendIssueLinks(issue.id, { chatId: chat.id });
    if (modeId === 'build' || modeId === 'debug') updateIssue(issue.id, { status: requireIssueStatusForRole('in_progress') });
    if (modeId === 'plan') updateIssue(issue.id, { planPath: issue.planPath || defaultIssuePlanPath(issue.id), status: requireIssueStatusForRole('planned') });
    touchChat(chat);
    scheduleSaveSessions();
    appendIssueActivity(issue.id, { kind: 'chat-started', actorKind: 'user', data: { chatId: chat.id, modeId, worktreePath: chat.worktreeRoot || issue.workspacePath } });
    const seed = [buildIssueForegroundModeSeed(issue, modeId), ...(modeId === 'build' || modeId === 'debug' ? [
      '',
      'Work in this chat\'s assigned checkout. Run relevant verification and summarize the changes, results, and remaining concerns.',
      'Keep the issue In progress while working. Minnow hands successful turns back for Review; do not mark the issue Done. Leave merging and worktree cleanup to the Issues delivery controls.',
    ] : [])].join('\n');
    const snapshot = { id: issue.id, title: issue.title, type: issue.type, description: issue.description, status: issue.status, priority: issue.priority, labels: [...issue.labels], workspacePath: issue.workspacePath };
    const attachments: Attachment[] = (issue.codeRefs ?? []).map((ref, index) => ({
      id: `issue-ref-${chat.id}-${index}`, name: formatCodeRefLabel(ref.path, ref.startLine ?? 1, ref.endLine ?? ref.startLine ?? 1), kind: 'codeRef', mimeType: 'text/plain', size: ref.snippet?.length || 0,
      text: ref.snippet || `(code reference: ${ref.path})`, workspacePath: ref.path, lineStart: ref.startLine ?? 1, lineEnd: ref.endLine ?? ref.startLine ?? 1,
    }));
    const { sendProgrammaticChatText } = await import('../messaging');
    void sendProgrammaticChatText(chat, seed, { issue: snapshot, validAttachments: attachments, parseSlash: false, ownsGlobalStreaming: false, requireCompletedTurn: true }).catch(async (error: unknown) => {
      if (!getChatRunActivity(chat.id, chat)) setChatRunActivity(chat.id, 'failed');
      appendIssueActivity(issue.id, { kind: 'chat-failed', actorKind: 'system', data: { chatId: chat.id, error: error instanceof Error ? error.message : String(error) } });
      const { showToast } = await import('../../ui/toast');
      showToast(error instanceof Error ? error.message : String(error), 'error');
    });
    return { ok: true, chatId: chat.id, planPath: modeId === 'plan' ? findIssueById(issue.id)?.planPath : undefined };
  } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
}
