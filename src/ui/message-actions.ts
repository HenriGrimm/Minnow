import { showToast } from './toast';
import { isActiveChatStreaming } from '../chat/streaming-state';
import {
  indexOfUserBeforeBlock,
  truncateChatHistory,
  updateUserMessageAt,
} from '../chat/history-truncate';
import { forkFromUserIndex } from '../chat/fork-from-run';
import {
  getUndoEligibility,
  undoBlockMessage,
  undoLastAgentTurn,
  UNDO_STATUS,
} from '../chat/undo-turn';
import { openForkModelDialog } from './fork-model-dialog';
import { getActiveRun } from '../state/runs-store';
import { formatComposerTextFromHistory, parseSkillTagFromHistory } from '../skills/history-content';
import { stripIssueRefBlocks } from '../chat/issue-mentions';
import { messageEditDraft } from '../chat/message-edit-draft';
import { replacePendingAttachments } from '../attachments/store';
import type { Attachment } from '../attachments/types';
import { buildHistoryUserContent, persistableUserImages } from '../chat/build-api-messages';
import { findChatById, getActiveChat } from '../state/sessions';
import { autoResize } from './input';
import { renderChatFromHistory, renderStatsForChat } from './messages';
import { renderSidebar } from './sidebar';
import { appConfirm } from './app-dialog';
import { setStatus } from './status';
import { CANONICAL_HISTORY_HINT, hasUnsettledAgentWork, supportsLocalHistoryMutation, supportsManagedHistoryMutation } from '../state/chat-relationships';
import type { Chat } from '../types';
import type { ManagedHistoryAction } from '../chat/managed-chat-client';
import { splitHistoryUserContentForEdit } from '../chat/user-message-parts';
import { formatHistoryWithSkillTag } from '../skills/parse-slash';

export type MessageTurnKind = 'user' | 'assistant' | 'assistant-tools';

export interface MessageActionTarget {
  chatId: string;
  historyIndex: number;
  turnKind: MessageTurnKind;
}

let openMenu: HTMLElement | null = null;
let closeMenuListeners: (() => void) | undefined;
let pendingEdit: { chatId: string; historyIndex: number } | null = null;

/** Pending user-message edit awaiting the next send. */
export function consumePendingMessageEdit(chatId: string): {
  chatId: string;
  historyIndex: number;
} | null {
  if (pendingEdit?.chatId !== chatId) return null;
  const next = pendingEdit;
  pendingEdit = null;
  return next;
}

/** Close any open message actions dropdown. */
export function closeMessageActionsMenu(): void {
  if (!openMenu) return;
  openMenu.remove();
  openMenu = null;
  closeMenuListeners?.();
  closeMenuListeners = undefined;
}

function guardStreaming(): boolean {
  if (!isActiveChatStreaming()) return false;
  showToast('Finish or stop the current reply first');
  return true;
}

function getCopyText(wrap: HTMLElement): string {
  const bubble = wrap.querySelector('.msg-bubble') as HTMLElement | null;
  const stored = bubble?.dataset.historyContent;
  if (stored) return stripIssueRefBlocks(formatComposerTextFromHistory(stored));
  if (bubble) return (bubble.textContent ?? '').trim();
  return (wrap.textContent ?? '').trim();
}

/** Copy a message row's text; shared by the ⋮ menu and the reply footer. */
export function copyMessageRow(wrap: HTMLElement): void {
  copyMessageRows([wrap]);
}

/** Copy all visible parts of a reply separated by bookkeeping calls. */
export function copyMessageRows(rows: readonly HTMLElement[]): void {
  const text = rows.map(getCopyText).filter(Boolean).join('\n\n');
  void navigator.clipboard.writeText(text).then(
    () => showToast('Copied'),
    () => setStatus('err', 'Could not copy'),
  );
}

/** Resend the user turn that produced this assistant row. */
export function remakeAssistantRow(chatId: string, historyIndex: number): void {
  if (guardStreaming()) return;
  const chat = findChatById(chatId);
  if (!chat) return;
  if (supportsManagedHistoryMutation(chat)) {
    const userIndex = managedReplayIndex(chat, historyIndex - 1);
    if (userIndex >= 0) void runManagedHistoryAction(chat, userIndex, 'replay');
    return;
  }
  if (!supportsLocalHistoryMutation(chat)) { showToast(CANONICAL_HISTORY_HINT); return; }
  const userIdx = indexOfUserBeforeBlock(chat.history, historyIndex);
  if (userIdx < 0) {
    setStatus('err', 'No user message to resend from');
    return;
  }
  void forkFromUserIndex(chatId, userIdx);
}

function canReplayManagedMessage(chat: Chat, index: number): boolean {
  const row = chat.history[index];
  return row?.role === 'user' && typeof row.content === 'string' && !row.steer && !row.hiddenFromTranscript &&
    (!row.provenance || row.provenance.actor === 'human');
}

function managedReplayIndex(chat: Chat, from: number): number {
  for (let index = from; index >= 0; index--) {
    if (canReplayManagedMessage(chat, index)) return index;
  }
  return -1;
}

async function runManagedHistoryAction(chat: Chat, index: number, action: ManagedHistoryAction['action']): Promise<void> {
  if (chat.agentExecution?.status === 'recovery_required') {
    showToast('Resolve the interrupted execution before changing this chat’s history');
    return;
  }
  if (guardStreaming()) return;
  if (hasUnsettledAgentWork(chat) || chat.agentTaskAttention?.pendingCount) {
    showToast('Finish or stop the current work before changing this chat’s history');
    return;
  }
  const digest = chat.historyDigest;
  if (!digest) { setStatus('err', 'The saved messages are still loading. Try again after the chat refreshes.'); return; }
  const row = chat.history[index];
  if (!row) return;
  let change: ManagedHistoryAction;
  const hasLaterMessages = index < chat.history.length - 1;
  if (action === 'edit' && row.role === 'user') {
    const draft = splitHistoryUserContentForEdit(row.content);
    const { skillId, displayText } = parseSkillTagFromHistory(stripIssueRefBlocks(draft.text));
    const input = document.createElement('textarea');
    input.className = 'app-dialog-panel__input';
    input.rows = 5;
    input.setAttribute('aria-label', 'Message text');
    input.value = displayText;
    const details = [hasLaterMessages ? 'Saving replaces the messages after this one.' : 'Saving sends this message again.'];
    if (draft.attachments.length || row.images?.length) details.push('Attachments are kept.');
    const ok = await appConfirm(details.join(' '), { title: 'Edit message', confirmLabel: 'Save and replay', body: input, initialFocus: input });
    if (!ok) return;
    const { attachMentionedIssues } = await import('../chat/issue-mention-context');
    const userText = input.value.trim();
    const display = skillId ? formatHistoryWithSkillTag(userText, skillId) : userText;
    const message = [attachMentionedIssues(display, userText, chat.workspacePath), ...draft.attachments].filter(Boolean).join('\n\n');
    if (!message.trim()) { setStatus('err', 'Enter a message before replaying'); return; }
    change = { action, message, text: userText };
  } else if (action === 'delete') {
    if (!await appConfirm(hasLaterMessages ? 'Delete this message and all messages after it?' : 'Delete this message?', { confirmLabel: 'Delete', danger: true })) return;
    change = { action };
  } else if (action === 'replay') {
    if (hasLaterMessages && !await appConfirm('Replay this message and replace all messages after it?', { confirmLabel: 'Replay' })) return;
    change = { action };
  } else return;
  try {
    const { rewriteManagedChatHistory } = await import('../chat/managed-chat-client');
    await rewriteManagedChatHistory(chat.id, index, digest, change);
  } catch (error) { setStatus('err', error instanceof Error ? error.message : String(error)); }
}

function shouldConfirmDelete(historyIndex: number): boolean {
  const chat = getActiveChat();
  const remaining = chat.history.length - historyIndex;
  return remaining > 1;
}

function buildMenuButton(
  label: string,
  action: () => void,
  options?: { disabled?: boolean; title?: string },
): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'message-actions__item';
  btn.textContent = label;
  if (options?.title) btn.title = options.title;
  if (options?.disabled) {
    btn.disabled = true;
    btn.classList.add('message-actions__item--disabled');
    return btn;
  }
  btn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    closeMessageActionsMenu();
    action();
  });
  return btn;
}

/** Undo last agent turn from the ⋮ menu; re-render + focus composer on success. */
async function runUndoFromMenu(chatId: string): Promise<void> {
  const result = await undoLastAgentTurn(chatId);
  if (!result.ok) {
    if (result.error === 'cancelled') {
      showToast(UNDO_STATUS.cancelled);
      return;
    }
    const msg =
      result.error === 'streaming'
        ? undoBlockMessage('streaming')
        : UNDO_STATUS.failed;
    if (result.error === 'streaming') showToast(msg);
    else setStatus('err', msg);
    return;
  }
  const chat = getActiveChat();
  renderChatFromHistory(chat);
  renderStatsForChat(chat);
  renderSidebar();
  void import('./composer-undo').then((m) => m.syncComposerUndoFromActiveChat());
  const input = document.getElementById('msgInput') as HTMLTextAreaElement | null;
  input?.focus();
  showToast(result.filesRestored ? UNDO_STATUS.successFiles : UNDO_STATUS.successChat,
  );
}

function openMenuAt(trigger: HTMLButtonElement, items: HTMLButtonElement[]): void {
  closeMessageActionsMenu();
  const menu = document.createElement('div');
  menu.className = 'message-actions__menu';
  menu.setAttribute('role', 'menu');
  for (const item of items) {
    menu.appendChild(item);
  }
  trigger.after(menu);
  openMenu = menu;
  trigger.setAttribute('aria-expanded', 'true');

  const onDocClick = (ev: MouseEvent): void => {
    const t = ev.target as Node;
    if (menu.contains(t) || trigger.contains(t)) return;
    closeMessageActionsMenu();
  };
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') {
      closeMessageActionsMenu();
      trigger.focus();
    }
  };
  document.addEventListener('click', onDocClick, true);
  document.addEventListener('keydown', onKey);
  closeMenuListeners = () => {
    trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', onDocClick, true);
    document.removeEventListener('keydown', onKey);
  };
}

/** Wire ⋮ menu on a rendered message row. */
export function attachMessageActions(
  wrap: HTMLElement,
  target: MessageActionTarget,
): void {
  if (wrap.dataset.streaming === 'true') return;

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'message-actions__trigger';
  trigger.setAttribute('aria-label', 'Message actions');
  trigger.setAttribute('aria-haspopup', 'menu');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.textContent = '⋮';

  trigger.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (trigger.getAttribute('aria-expanded') === 'true') { closeMessageActionsMenu(); return; }
    if (guardStreaming()) return;

    const items: HTMLButtonElement[] = [];
    items.push(
      buildMenuButton('Copy', () => copyMessageRow(wrap)),
    );

    const actionChat = findChatById(target.chatId) ?? getActiveChat();
    const canRewrite = supportsLocalHistoryMutation(actionChat);
    const canRewriteManaged = supportsManagedHistoryMutation(actionChat);
    const savedUser = actionChat.history[target.historyIndex];
    if (canRewriteManaged) {
      if (target.turnKind === 'user' && canReplayManagedMessage(actionChat, target.historyIndex)) {
        items.push(buildMenuButton('Edit', () => { void runManagedHistoryAction(actionChat, target.historyIndex, 'edit'); }));
        items.push(buildMenuButton('Replay', () => { void runManagedHistoryAction(actionChat, target.historyIndex, 'replay'); }));
      } else if (target.turnKind !== 'user' && managedReplayIndex(actionChat, target.historyIndex - 1) >= 0) {
        items.push(buildMenuButton('Remake', () => remakeAssistantRow(target.chatId, target.historyIndex)));
      }
    }
    if (actionChat.chatCommandVersion === 1 && !actionChat.agentConversation && target.turnKind === 'user' &&
        savedUser?.role === 'user' && savedUser.messageId && savedUser.commandId) {
      items.push(buildMenuButton('Replay in new chat', () => {
        void forkFromUserIndex(target.chatId, target.historyIndex);
      }, { title: 'Start a new saved branch; keep this conversation and its completed tool results unchanged' }));
    }
    if (canRewrite && target.turnKind === 'user') {
      items.push(
        buildMenuButton('Edit', () => {
          const chat = findChatById(target.chatId);
          if (!chat || !supportsLocalHistoryMutation(chat)) return;
          const row = chat.history[target.historyIndex];
          if (!row || row.role !== 'user') return;
          if (!truncateChatHistory(target.chatId, target.historyIndex, 'inclusive').ok) return;
          renderChatFromHistory(getActiveChat());
          const draft = messageEditDraft(row.content);
          replacePendingAttachments(draft.attachments);
          const input = document.getElementById('msgInput') as HTMLTextAreaElement;
          input.value = draft.text;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          autoResize(input);
          input.focus();
          pendingEdit = {
            chatId: target.chatId,
            historyIndex: target.historyIndex,
          };
        }),
      );
      items.push(
        buildMenuButton('Replay', () => {
          void forkFromUserIndex(target.chatId, target.historyIndex);
        }),
      );
      items.push(
        buildMenuButton('Fork with different model…', () => {
          void (async () => {
            const chat = getActiveChat();
            const prior = getActiveRun(chat, target.historyIndex);
            const snap = prior?.snapshot;
            const picked = await openForkModelDialog({
              providerId: snap?.providerId ?? chat.providerId,
              modelId: snap?.modelId ?? chat.modelId,
              temperature: snap?.temperature,
              maxTokens: snap?.maxTokens,
            });
            if (!picked) return;
            void forkFromUserIndex(target.chatId, target.historyIndex, picked);
          })();
        }),
      );
    }

    if (canRewrite && (target.turnKind === 'assistant' || target.turnKind === 'assistant-tools')) {
      items.push(
        buildMenuButton('Remake', () => remakeAssistantRow(target.chatId, target.historyIndex)),
      );
    }

    {
      const chat = getActiveChat();
      const eligibility = getUndoEligibility(chat);
      const isAssistantRow =
        target.turnKind === 'assistant' || target.turnKind === 'assistant-tools';
      const isTargetUserFork =
        target.turnKind === 'user' &&
        eligibility.ok &&
        eligibility.target?.forkHistoryIndex === target.historyIndex;
      if (canRewrite && (isAssistantRow || isTargetUserFork)) {
        items.push(
          buildMenuButton(
            'Undo turn',
            () => {
              void runUndoFromMenu(target.chatId);
            },
            eligibility.ok
              ? { title: 'Undo last agent turn (rewind chat; restore files if snapshotted)' }
              : {
                  disabled: true,
                  title: eligibility.message ?? 'Undo unavailable',
                },
          ),
        );
      }
    }

    if (canRewriteManaged) items.push(buildMenuButton('Delete message', () => { void runManagedHistoryAction(actionChat, target.historyIndex, 'delete'); }));
    if (canRewrite) items.push(
      buildMenuButton('Delete message', () => {
        void (async () => {
          if (shouldConfirmDelete(target.historyIndex)) {
            const ok = await appConfirm('Delete this message and all messages after it?', {
              confirmLabel: 'Delete',
              danger: true,
            });
            if (!ok) return;
          }
          const result = truncateChatHistory(
            target.chatId,
            target.historyIndex,
            'exclusive',
          );
          if (!result.ok) {
            if (result.error === 'streaming') guardStreaming();
            else setStatus('err', 'Could not delete');
            return;
          }
          const chat = getActiveChat();
          renderChatFromHistory(chat);
          renderStatsForChat(chat);
          renderSidebar();
          setStatus('ok', 'Message deleted');
        })();
      }),
    );

    openMenuAt(trigger, items);
  });

  wrap.classList.add('msg--has-actions');
  wrap.appendChild(trigger);
}

/** After edit+send: replace user row and resend from that index. */
export async function completePendingMessageEdit(
  chatId: string,
  historyIndex: number,
  newContent: string,
  attachments: Attachment[] = [],
): Promise<void> {
  if (guardStreaming()) return;
  const chat = findChatById(chatId);
  if (!chat || !supportsLocalHistoryMutation(chat)) { showToast(CANONICAL_HISTORY_HINT); return; }
  const trimmed = newContent.trim();
  const { attachMentionedIssues } = await import('../chat/issue-mention-context');
  const tagged = attachMentionedIssues(buildHistoryUserContent(trimmed, attachments), trimmed);
  if (!updateUserMessageAt(chatId, historyIndex, tagged)) {
    setStatus('err', 'Could not update message');
    return;
  }
  const row = findChatById(chatId)?.history[historyIndex];
  const images = persistableUserImages(attachments);
  if (row?.role === 'user' && images.length) {
    row.images = [...(row.images ?? []), ...images];
  }
  renderChatFromHistory(getActiveChat());
  await forkFromUserIndex(chatId, historyIndex);
}
