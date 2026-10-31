import { showToast } from './toast';
import { isActiveChatStreaming } from '../chat/streaming-state';
import { confirmAndRestoreTurnSnapshot, UNDO_STATUS } from '../chat/undo-turn';
import {
  activateBranch,
  getActiveRun,
  listSelectableBranchesAtFork,
} from '../state/runs-store';
import {
  findChatById,
  getActiveChat,
  scheduleSaveSessions,
  sessionState,
  switchActiveChat,
  touchChat,
} from '../state/sessions';
import type { Chat, TurnRunRecord } from '../types';
import { getActiveChatMountElement } from './chat-mount';
import { switchComposerDraft } from './composer-draft';
import { renderChatInForegroundShell, renderStatsForChat } from './messages';
import { renderSidebar } from './sidebar';
import { setStatus } from './status';
import { iconHtml } from './icon';
import { CANONICAL_HISTORY_HINT, supportsLocalHistoryMutation } from '../state/chat-relationships';

function branchIndexLabel(index: number, total: number): string {
  return `Branch ${index + 1} of ${total}`;
}

function branchMeta(run: TurnRunRecord): string {
  const model = run.snapshot.modelId || 'model';
  const provider = run.snapshot.providerId || 'provider';
  return `${model} · ${provider}`;
}

function buildTriggerLabel(activeIndex: number, total: number): string {
  return `Branch ${activeIndex + 1} of ${total}`;
}

const BRANCH_CHEVRON_SVG = iconHtml('chevronDown', { className: 'branch-picker__trigger-chevron' });

function closeBranchMenu(menu: HTMLElement | null): void {
  if (!menu) return;
  menu.remove();
}

function findUserMessageRow(chatId: string, historyIndex: number): HTMLElement | null {
  const root = getActiveChatMountElement();
  for (const row of root.querySelectorAll<HTMLElement>('.msg.user[data-history-index]')) {
    if (
      row.dataset.chatId === chatId &&
      row.dataset.historyIndex === String(historyIndex)
    ) {
      return row;
    }
  }
  return null;
}

function removeBranchPickerFromRow(wrap: HTMLElement): void {
  wrap.querySelector('.branch-picker__trigger')?.remove();
  wrap.classList.remove('msg--has-branch-picker');
}

/** Re-attach the branch picker on an existing user row after a fork/replay turn completes (history render happens earlier, before the second branch exists). */
export function refreshBranchPickerAtFork(chat: Chat, forkHistoryIndex: number): void {
  const wrap = findUserMessageRow(chat.id, forkHistoryIndex);
  if (!wrap) return;
  removeBranchPickerFromRow(wrap);
  attachBranchPicker(wrap, chat.id, forkHistoryIndex);
}

/** Show the picker when there are multiple branches, or a single redoable branch while history ends at the fork user row (post-undo gap). */
function shouldAttachBranchPicker(
  chat: Chat,
  forkHistoryIndex: number,
  branchCount: number,
): boolean {
  if (branchCount >= 2) return true;
  if (branchCount < 1) return false;
  return (
    chat.history.length === forkHistoryIndex + 1 &&
    chat.history[forkHistoryIndex]?.role === 'user'
  );
}

/** Attach branch pill to a user message row when branches are selectable. */
export function attachBranchPicker(
  wrap: HTMLElement,
  chatId: string,
  forkHistoryIndex: number,
): void {
  const chat =
    findChatById(chatId) ??
    (getActiveChat().id === chatId ? getActiveChat() : undefined);
  if (!chat || !supportsLocalHistoryMutation(chat)) return;

  const branches = listSelectableBranchesAtFork(chat, forkHistoryIndex);
  if (!shouldAttachBranchPicker(chat, forkHistoryIndex, branches.length)) return;

  const active = getActiveRun(chat, forkHistoryIndex);
  const sorted = [...branches].sort((a, b) => a.createdAt - b.createdAt);
  const activeIndex = sorted.findIndex((run) => run.branchId === active?.branchId);
  const historyEndsAtFork =
    chat.history.length === forkHistoryIndex + 1 &&
    chat.history[forkHistoryIndex]?.role === 'user';
  const triggerLabel = historyEndsAtFork
    ? branches.length === 1
      ? 'Restore branch'
      : `Restore · ${branches.length} branches`
    : buildTriggerLabel(Math.max(0, activeIndex), branches.length);
  const ariaLabel = historyEndsAtFork
    ? `Restore undone reply, ${branches.length} branch${branches.length === 1 ? '' : 'es'}`
    : `Switch reply branch, ${branches.length} alternatives`;

  const pill = document.createElement('button');
  pill.type = 'button';
  pill.className = 'branch-picker__trigger';
  pill.setAttribute('aria-haspopup', 'menu');
  pill.setAttribute('aria-expanded', 'false');
  pill.setAttribute('aria-label', ariaLabel);
  pill.innerHTML = `${BRANCH_CHEVRON_SVG}<span class="branch-picker__trigger-label">${triggerLabel}</span>`;

  let openMenu: HTMLElement | null = null;

  const setExpanded = (open: boolean): void => {
    pill.setAttribute('aria-expanded', open ? 'true' : 'false');
  };

  pill.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (!supportsLocalHistoryMutation(chat)) { showToast(CANONICAL_HISTORY_HINT); return; }
    if (isActiveChatStreaming()) {
      showToast('Finish or stop the current reply first');
      return;
    }
    if (openMenu) {
      closeBranchMenu(openMenu);
      openMenu = null;
      setExpanded(false);
      return;
    }

    const menu = document.createElement('div');
    menu.className = 'branch-picker__menu';
    menu.setAttribute('role', 'menu');

    for (let i = 0; i < sorted.length; i += 1) {
      const run = sorted[i]!;
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'branch-picker__item';
      item.setAttribute('role', 'menuitem');

      const label = document.createElement('span');
      label.className = 'branch-picker__item-label';
      label.textContent = branchIndexLabel(i, sorted.length);

      const meta = document.createElement('span');
      meta.className = 'branch-picker__item-meta';
      meta.textContent = branchMeta(run);

      item.append(label, meta);

      if (!historyEndsAtFork && active?.branchId === run.branchId) {
        item.classList.add('branch-picker__item--active');
        item.setAttribute('aria-current', 'true');
      }
      if (historyEndsAtFork) {
        label.textContent =
          sorted.length === 1
            ? 'Restore branch'
            : `Restore branch ${i + 1} of ${sorted.length}`;
      }
      item.addEventListener('click', (itemEv) => {
        itemEv.stopPropagation();
        closeBranchMenu(menu);
        openMenu = null;
        setExpanded(false);
        void switchBranch(chat, forkHistoryIndex, run.branchId);
      });
      menu.appendChild(item);
    }

    pill.after(menu);
    openMenu = menu;
    setExpanded(true);

    const onDoc = (docEv: MouseEvent): void => {
      const t = docEv.target as Node;
      if (menu.contains(t) || pill.contains(t)) return;
      closeBranchMenu(menu);
      openMenu = null;
      setExpanded(false);
      document.removeEventListener('click', onDoc, true);
    };
    const onKey = (keyEv: KeyboardEvent): void => {
      if (keyEv.key === 'Escape') {
        closeBranchMenu(menu);
        openMenu = null;
        setExpanded(false);
        document.removeEventListener('keydown', onKey);
      }
    };
    requestAnimationFrame(() => {
      document.addEventListener('click', onDoc, true);
      document.addEventListener('keydown', onKey);
    });
  });

  wrap.classList.add('msg--has-branch-picker');
  wrap.appendChild(pill);
}

async function switchBranch(
  chat: Chat,
  forkHistoryIndex: number,
  branchId: string,
): Promise<void> {
  if (!supportsLocalHistoryMutation(chat)) { showToast(CANONICAL_HISTORY_HINT); return; }
  const targetRun = listSelectableBranchesAtFork(chat, forkHistoryIndex).find(
    (r) => r.branchId === branchId,
  );
  const isRedoRestore =
    chat.history.length === forkHistoryIndex + 1 &&
    chat.history[forkHistoryIndex]?.role === 'user';

  const ok = activateBranch(chat, forkHistoryIndex, branchId);
  if (!ok) {
    setStatus('err', 'Could not switch branch');
    return;
  }
  touchChat(chat);
  scheduleSaveSessions();
  const prevActiveId = sessionState?.activeId;
  const switched = await switchActiveChat(chat.id);
  if (switched) {
    void switchComposerDraft(prevActiveId, chat);
  }
  renderChatInForegroundShell(chat);
  renderStatsForChat(chat);
  renderSidebar();

  let filesRestored = false;
  if (targetRun?.postTurnSnapshotSha?.trim() && targetRun.snapshotCwd?.trim()) {
    const fileResult = await confirmAndRestoreTurnSnapshot(targetRun, 'post');
    if (fileResult.cancelled) {
      showToast(isRedoRestore
          ? UNDO_STATUS.branchRestoredFilesSkipped
          : UNDO_STATUS.branchSwitchedFilesSkipped,
      );
      return;
    }
    filesRestored = fileResult.restored;
  }

  if (isRedoRestore) {
    showToast(filesRestored ? UNDO_STATUS.branchRestoredFiles : UNDO_STATUS.branchRestored,
    );
    return;
  }

  showToast(filesRestored ? UNDO_STATUS.branchSwitchedFiles : UNDO_STATUS.branchSwitched,
  );
}
