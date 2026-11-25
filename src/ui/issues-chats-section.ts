import { pickIssueLaunchModel, issueLaunchModelLabel } from './issues-chat-run-target';
/**
 * Peek Chats: linked sessions, New / Existing, unlink without delete.
 */

import { isChatStreaming, subscribeChatStreamActivity, subscribeChatStreamEnd } from '../chat/streaming-state';
import { listIssuePeekChatRows, type IssuePeekChatRow } from '../issues/issue-peek-chats';
import { appendIssueLinks, findIssueById, updateIssue } from '../state/issues-store';
import {
  findChatById,
  getChatsForWorkspace,
  sessionState,
} from '../state/sessions';
import type { Chat, IssueCard } from '../types';
import { createDetailIconButton } from './issues-detail-section';
import { openIssuesContextMenu, type IssuesContextMenuItem } from './issues-context-menu';
import { canRunIssueWorkflow } from '../chat/issues/pipeline';
import { runIssueWorkspaceChat } from '../chat/issues/workspace-chat';
import { getAppWindowId } from '../os/app-window';
import { paintLinkedChatActivity } from './issues-chat-activity';

/** Keep the attach picker a menu, not a search dialog. */
const ATTACH_MENU_CAP = 30;

function toast(message: string, kind: 'success' | 'error' = 'success'): void {
  void import('./toast').then((m) => m.showToast(message, kind));
}

function refreshOpenPeek(): void {
  void import('./issues-detail').then((m) => {
    if (m.isIssuesDetailEditing()) return;
    m.refreshIssueDetailIfOpen();
  });
}

/** Live lookup against the session store (undefined when sessions are not loaded). */
export function issuePeekChatLookup() {
  return {
    findChat: findChatById,
    isStreaming: isChatStreaming,
  };
}

/** Workspace chats not already on this issue. */
export function eligibleIssuePeekChats(issue: IssueCard): Chat[] {
  const linked = new Set((issue.chatIds ?? []).map((id) => id.trim()).filter(Boolean));
  if (issue.boardChatId?.trim()) linked.add(issue.boardChatId.trim());
  if (!sessionState) return [];
  try {
    return getChatsForWorkspace(issue.workspacePath).filter((chat) => !linked.has(chat.id));
  } catch {
    return [];
  }
}

/** Drop a session id from the card; the chat itself stays in the sidebar. */
export function unlinkIssuePeekChat(issueId: string, row: Pick<IssuePeekChatRow, 'unlinkChatId' | 'unlinkBoardChat'>): void {
  const issue = findIssueById(issueId);
  if (!issue) return;
  const patch: { chatIds?: string[]; boardChatId?: string } = {};
  if (row.unlinkChatId) {
    patch.chatIds = (issue.chatIds ?? []).filter((id) => id !== row.unlinkChatId);
  }
  if (row.unlinkBoardChat) patch.boardChatId = '';
  if (patch.chatIds === undefined && patch.boardChatId === undefined) return;
  updateIssue(issueId, patch);
  refreshOpenPeek();
}

export function attachExistingIssueChat(issueId: string, chatId: string): void {
  if (!findChatById(chatId)) {
    toast('Chat unavailable', 'error');
    return;
  }
  appendIssueLinks(issueId, { chatId });
  refreshOpenPeek();
}

async function startNewIssueChat(issueId: string): Promise<void> {
  const issue = findIssueById(issueId);
  if (!issue) return;
  if (!canRunIssueWorkflow(issue)) {
    toast('Issue is closed', 'error');
    return;
  }
  const result = await runIssueWorkspaceChat(issueId, 'general');
  if (!result.ok) {
    toast(result.error || 'Send to chat failed', 'error');
    return;
  }
  toast('General chat started in Code', 'success');
  refreshOpenPeek();
}

async function openPeekChatRow(issueId: string, row: IssuePeekChatRow): Promise<void> {
  const chat = findChatById(row.chatId);
  const { routeCodeWindowCommand } = await import('../os/code-window-command');
  if (await routeCodeWindowCommand({ kind: 'chat', chatId: row.chatId, workspacePath: chat?.workspacePath || findIssueById(issueId)?.workspacePath || '' })) return;
  if (!row.available) return;
  const { launchCodeWithChat } = await import('../os/chat-launch');
  await launchCodeWithChat(row.chatId);
}

function buildChatRow(issueId: string, row: IssuePeekChatRow): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'issues-detail__chat';

  const openBtn = document.createElement('button');
  openBtn.type = 'button';
  openBtn.className = 'issues-detail__chat-open';
  openBtn.disabled = !row.available && !getAppWindowId();
  openBtn.title = row.available ? `Open chat ${row.title}` : row.title;

  const titleEl = document.createElement('span');
  titleEl.className = 'issues-detail__chat-title';
  titleEl.textContent = row.title;
  openBtn.appendChild(titleEl);

  if (row.available) {
    const statusEl = document.createElement('span');
    statusEl.className = 'issues-detail__chat-status';
    paintLinkedChatActivity(statusEl, row.chatId);
    openBtn.appendChild(statusEl);
  }

  if (row.modeLabel) {
    const modeEl = document.createElement('span');
    modeEl.className = 'issues-detail__chat-mode';
    modeEl.textContent = row.modeLabel;
    openBtn.appendChild(modeEl);
  }

  openBtn.addEventListener('click', () => {
    void openPeekChatRow(issueId, row).catch((error: unknown) => toast(error instanceof Error ? error.message : String(error), 'error'));
  });

  li.appendChild(openBtn);

  const canUnlink = Boolean(row.unlinkChatId || row.unlinkBoardChat);
  if (canUnlink) {
    const name = row.title;
    const removeLabel = `Remove chat ${name} from this issue`;
    const removeBtn = createDetailIconButton({
      label: removeLabel,
      icon: 'close',
      danger: true,
      className: 'issues-detail__row-remove issues-detail__chat-remove',
      onClick: () => unlinkIssuePeekChat(issueId, row),
    });
    li.appendChild(removeBtn);
  }

  return li;
}

/** Menu behind the section's + control: start a chat, or link one that exists. */
export function issueChatsMenuItems(issue: IssueCard): IssuesContextMenuItem[] {
  const canRun = canRunIssueWorkflow(issue);
  const attachable = eligibleIssuePeekChats(issue);
  return [
    { id: 'issue-chat-model', label: `Model: ${issueLaunchModelLabel(issue.id)}`, disabled: !canRun, onSelect: () => pickIssueLaunchModel(issue.id, document.activeElement as HTMLElement || document.body, refreshOpenPeek) },
    {
      id: 'new-issue-chat',
      label: 'New chat',
      hint: canRun ? 'Start a General chat from this issue' : 'Closed issues cannot start a chat',
      disabled: !canRun,
      iconClass: 'fi-rr-comment',
      onSelect: () => {
        void startNewIssueChat(issue.id);
      },
    },
    {
      id: 'attach-existing-chat',
      label: 'Link an existing chat',
      hint:
        attachable.length === 0
          ? 'No other chats in this workspace'
          : `${attachable.length} available`,
      disabled: attachable.length === 0,
      submenu: () =>
        eligibleIssuePeekChats(issue)
          .slice(0, ATTACH_MENU_CAP)
          .map((chat) => ({
            id: `attach-chat-${chat.id}`,
            label: chat.name.trim() || chat.id,
            hint: chat.id.slice(0, 8),
            onSelect: () => attachExistingIssueChat(issue.id, chat.id),
          })),
    },
  ];
}

/** Row counts for the peek's Chats summary: how many, and how many are live. */
export function issueChatsSummary(issue: IssueCard): { total: number; running: number } {
  const rows = listIssuePeekChatRows(issue, issuePeekChatLookup());
  return {
    total: rows.length,
    running: rows.filter((row) => row.running).length,
  };
}

/** Peek section body: linked chats. Empty renders nothing. */
export function fillIssueChatsSection(issue: IssueCard, body: HTMLElement): void {
  ensurePeekChatStreamBind();
  peekStreamPaintKey = streamingKeyForIssue(issue.id);
  const rows = listIssuePeekChatRows(issue, issuePeekChatLookup());
  if (rows.length === 0) return;

  const list = document.createElement('ul');
  list.className = 'issues-detail__chats-list';
  for (const row of rows) {
    list.appendChild(buildChatRow(issue.id, row));
  }
  body.appendChild(list);
}

let peekStreamPaintKey = '';
let peekStreamBound = false;

function peekLinkedChatIds(issueId: string): Set<string> {
  const issue = findIssueById(issueId);
  const ids = new Set<string>();
  for (const id of issue?.chatIds ?? []) {
    if (id.trim()) ids.add(id.trim());
  }
  const board = issue?.boardChatId?.trim();
  if (board) ids.add(board);
  return ids;
}

function streamingKeyForIssue(issueId: string): string {
  return [...peekLinkedChatIds(issueId)]
    .map((id) => `${id}:${isChatStreaming(id) ? 1 : 0}`)
    .join(',');
}

/** Remount peek only when Running/Done actually flips for a linked chat. */
function maybeRefreshPeekForStream(chatId: string): void {
  void import('./issues-detail').then((m) => {
    const issueId = m.getSelectedIssueId();
    if (!issueId) return;
    if (!peekLinkedChatIds(issueId).has(chatId)) return;
    if (m.isIssuesDetailEditing()) return;
    const key = streamingKeyForIssue(issueId);
    if (key === peekStreamPaintKey) return;
    peekStreamPaintKey = key;
    m.refreshIssueDetailIfOpen();
  });
}

function ensurePeekChatStreamBind(): void {
  if (peekStreamBound) return;
  peekStreamBound = true;
  subscribeChatStreamActivity(maybeRefreshPeekForStream);
  subscribeChatStreamEnd(maybeRefreshPeekForStream);
}
