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
import { formatComposerTextFromHistory } from '../skills/history-content';
import { getActiveChat } from '../state/sessions';
import { autoResize } from './input';
import { renderChatFromHistory, renderStatsForChat } from './messages';
import { renderSidebar } from './sidebar';
import { appConfirm } from './app-dialog';
import { setStatus } from './status';

export type MessageTurnKind = 'user' | 'assistant' | 'assistant-tools';

export interface MessageActionTarget {
  chatId: string;
  historyIndex: number;
  turnKind: MessageTurnKind;
}

let openMenu: HTMLElement | null = null;
let pendingEdit: { chatId: string; historyIndex: number } | null = null;

/** Pending user-message edit awaiting the next send. */
export function consumePendingMessageEdit(): {
  chatId: string;
  historyIndex: number;
} | null {
  const next = pendingEdit;
  pendingEdit = null;
  return next;
}

/** Close any open message actions dropdown. */
export function closeMessageActionsMenu(): void {
  if (!openMenu) return;
  openMenu.remove();
  openMenu = null;
}

function guardStreaming(): boolean {
  if (!isActiveChatStreaming()) return false;
  setStatus('spin', 'Finish or stop the current reply first');
  return true;
}

function getCopyText(wrap: HTMLElement): string {
  const bubble = wrap.querySelector('.msg-bubble') as HTMLElement | null;
  const stored = bubble?.dataset.historyContent;
  if (stored) return formatComposerTextFromHistory(stored).trim();
  if (bubble) return (bubble.textContent ?? '').trim();
  return (wrap.textContent ?? '').trim();
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
      setStatus('ok', UNDO_STATUS.cancelled);
      return;
    }
    const msg =
      result.error === 'streaming'
        ? undoBlockMessage('streaming')
        : UNDO_STATUS.failed;
    setStatus(result.error === 'streaming' ? 'spin' : 'err', msg);
    return;
  }
  const chat = getActiveChat();
  renderChatFromHistory(chat);
  renderStatsForChat(chat);
  renderSidebar();
  void import('./composer-undo').then((m) => m.syncComposerUndoFromActiveChat());
  const input = document.getElementById('msgInput') as HTMLTextAreaElement | null;
  input?.focus();
  setStatus(
    'ok',
    result.filesRestored ? UNDO_STATUS.successFiles : UNDO_STATUS.successChat,
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

  const onDocClick = (ev: MouseEvent): void => {
    const t = ev.target as Node;
    if (menu.contains(t) || trigger.contains(t)) return;
    closeMessageActionsMenu();
    document.removeEventListener('click', onDocClick, true);
  };
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') {
      closeMessageActionsMenu();
      document.removeEventListener('keydown', onKey);
    }
  };
  requestAnimationFrame(() => {
    document.addEventListener('click', onDocClick, true);
    document.addEventListener('keydown', onKey);
  });
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
  trigger.textContent = '⋮';

  trigger.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (guardStreaming()) return;

    const items: HTMLButtonElement[] = [];
    items.push(
      buildMenuButton('Copy', () => {
        const text = getCopyText(wrap);
        void navigator.clipboard.writeText(text).then(
          () => setStatus('ok', 'Copied'),
          () => setStatus('err', 'Could not copy'),
        );
      }),
    );

    if (target.turnKind === 'user') {
      items.push(
        buildMenuButton('Edit', () => {
          const chat = getActiveChat();
          const row = chat.history[target.historyIndex];
          if (!row || row.role !== 'user') return;
          truncateChatHistory(target.chatId, target.historyIndex, 'inclusive');
          renderChatFromHistory(getActiveChat());
          const input = document.getElementById('msgInput') as HTMLTextAreaElement;
          input.value = formatComposerTextFromHistory(row.content);
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

    if (target.turnKind === 'assistant' || target.turnKind === 'assistant-tools') {
      items.push(
        buildMenuButton('Remake', () => {
          const chat = getActiveChat();
          const userIdx = indexOfUserBeforeBlock(chat.history, target.historyIndex);
          if (userIdx < 0) {
            setStatus('err', 'No user message to resend from');
            return;
          }
          void forkFromUserIndex(target.chatId, userIdx);
        }),
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
      if (isAssistantRow || isTargetUserFork) {
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

    items.push(
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
): Promise<void> {
  if (guardStreaming()) return;
  const tagged = newContent.trim();
  if (!updateUserMessageAt(chatId, historyIndex, tagged)) {
    setStatus('err', 'Could not update message');
    return;
  }
  renderChatFromHistory(getActiveChat());
  await forkFromUserIndex(chatId, historyIndex);
}
