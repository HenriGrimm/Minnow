/**
 * One conversation, full screen. The transcript, composer, tool approvals and
 * questions are the real Code surfaces, moved in through the shared chat host,
 * so every engine feature behaves exactly as on the desktop.
 */

import { mountSharedChatHost } from '../ui/shared-chat-host';
import { getSharedChatHost } from '../ui/shared-chat-host-state';
import { isChatStreaming, subscribeChatStreamActivity, subscribeChatStreamEnd } from '../chat/streaming-state';
import { isChatPinned, setChatPinned } from '../state/chat-groups';
import { renameChatTitle, scheduleSaveSessions, sessionState } from '../state/sessions';
import { PLACEHOLDER_CHAT_NAME } from '../constants';
import { isChatRunningRemotely } from '../chat/remote-turn-state';
import { getWorkspaceLabel } from '../state/workspace';
import type { Chat } from '../types';
import { screenHeader } from './chrome';
import { el, emptyState, icon, iconButton } from './dom';
import { modeGlyph, modeLabel, pickMode } from './modes';
import { popScreen, type MobileScreen } from './nav';
import { openActionSheet, promptSheet } from './sheet';

function findChat(chatId: string): Chat | undefined {
  return sessionState?.chats.find((chat) => chat.id === chatId);
}

function titleOf(chat: Chat | undefined): string {
  const name = chat?.name?.trim();
  return name && name !== PLACEHOLDER_CHAT_NAME ? name : 'New chat';
}

function shortModel(chat: Chat): string {
  const id = chat.modelId?.trim() ?? '';
  if (!id) return 'No model';
  const tail = id.split('/').pop() ?? id;
  return tail.length > 28 ? `${tail.slice(0, 27)}…` : tail;
}

export function createChatThreadScreen(chatId: string, deps: {
  openFiles(): void;
  openMenu(): void;
  initialPrompt?: string;
  focus?: boolean;
}): MobileScreen {
  const header = screenHeader({ title: titleOf(findChat(chatId)), back: true });
  const statusText = el('span', { className: 'm-thread__status' });
  const subtitleRow = el('div', { className: 'm-thread__meta' }, statusText);
  header.el.querySelector('.m-header__titles')?.append(subtitleRow);
  const additions = el('span', { className: 'm-thread__diff-add' });
  const deletions = el('span', { className: 'm-thread__diff-delete' });
  const diff = el('button', {
    className: 'm-thread__diff m-mono',
    attrs: { type: 'button', 'aria-label': 'Changes' },
    on: { click: () => void openThreadSurface('changes') },
  }, additions, deletions);
  const agents = iconButton('fi-rr-user-robot', 'Agents', () => void openThreadSurface('agents'));
  header.el.querySelector('.m-header__actions')?.append(
    diff,
    agents,
    iconButton('fi-rr-menu-dots-vertical', 'Chat actions', () => openMenu()),
  );

  const host = el('div', { className: 'm-thread__host' });
  const emptyHint = el(
    'div',
    { className: 'm-thread__empty', attrs: { 'aria-hidden': 'true' } },
    el('span', { className: 'm-empty__icon' }, icon(modeGlyph(findChat(chatId)?.modeId), 24)),
    el('p', { className: 'm-empty__title', text: 'What should we work on?' }),
    el('p', { className: 'm-empty__body m-thread__empty-mode' }),
  );
  const root = el(
    'section',
    { className: 'm-screen m-thread', dataset: { screen: `chat:${chatId}` } },
    header.el,
    host,
  );

  let handle: ReturnType<typeof mountSharedChatHost> | null = null;
  let disposePanels: (() => void) | undefined;
  let visible = false;
  let disposed = false;
  let focusOnMount = deps.focus === true;

  async function mountPanels() {
    const { ensureCodeWorkspaceModules } = await import('../boot/code-workspace-modules');
    await ensureCodeWorkspaceModules();
    const surfaces = await import('../ui/surfaces/surfaces-column');
    if (!visible || disposed) return;
    disposePanels ??= surfaces.mountMobileSurfacePortal(root, chatId);
    return surfaces;
  }

  async function openThreadSurface(id: 'changes' | 'agents'): Promise<void> {
    const surfaces = await mountPanels();
    if (!surfaces) return;
    const opened = surfaces.openSurface(id, { force: id === 'changes' });
    if (!opened) {
      const { showToast } = await import('../ui/toast');
      if (visible && !disposed) showToast(id === 'agents' ? 'This thread has no agents yet' : 'Changes are unavailable');
    }
  }

  function syncMeta(): void {
    const chat = findChat(chatId);
    if (!chat) return;
    header.setTitle(titleOf(chat));
    const hintGlyph = emptyHint.querySelector('i');
    if (hintGlyph) hintGlyph.className = `fi ${modeGlyph(chat.modeId)} icon-svg`;
    const hintMode = emptyHint.querySelector('.m-thread__empty-mode');
    if (hintMode) hintMode.textContent = `${modeLabel(chat.modeId)} mode · ${getWorkspaceLabel() || 'this workspace'}`;
    const remote = isChatRunningRemotely(chatId);
    const working = isChatStreaming(chatId) || remote;
    statusText.textContent = chat.gitBranch || (remote ? 'Working on computer…' : working ? 'Working…' : shortModel(chat));
    statusText.classList.toggle('is-working', working);
    const added = chat.codeChangeTotals?.additions ?? 0;
    const deleted = chat.codeChangeTotals?.deletions ?? 0;
    diff.hidden = !added && !deleted;
    additions.textContent = `+${added}`;
    deletions.textContent = `−${deleted}`;
  }

  function mount(): void {
    const chat = findChat(chatId);
    if (!chat) {
      host.replaceChildren(
        emptyState({ glyph: 'fi-rr-comment-slash', title: 'This chat is gone', body: 'It was deleted on another device.' }),
      );
      return;
    }
    if (handle && getSharedChatHost(chatId)) return;
    // Another thread took the composer while this one was covered.
    handle?.dispose();
    host.replaceChildren();
    handle = mountSharedChatHost(host, chat, 'code');
    host.append(emptyHint);
    if (focusOnMount) {
      focusOnMount = false;
      const prompt = deps.initialPrompt;
      void handle.focus(prompt).then(async (ready) => {
        if (!ready || !prompt || disposed || !visible) return;
        const { handleComposerPrimaryAction } = await import('../ui/composer-send');
        if (!disposed && visible && getSharedChatHost(chatId)) handleComposerPrimaryAction();
      });
    }
  }

  async function changeMode(): Promise<void> {
    const chat = findChat(chatId);
    if (!chat) return;
    const next = await pickMode(chat.modeId);
    if (!next || next === chat.modeId) return;
    const { setChatMode } = await import('../ui/mode-selector');
    if (disposed) return;
    const result = setChatMode(next, chat);
    if (!result.ok) {
      const { showToast } = await import('../ui/toast');
      showToast(result.error ?? 'Could not change mode', 'error');
    }
    syncMeta();
  }

  function openMenu(): void {
    const chat = findChat(chatId);
    if (!chat) return;
    const pinned = isChatPinned(chat);
    openActionSheet(titleOf(chat), [
      {
        label: 'Rename',
        glyph: 'fi-rr-pencil',
        run: async () => {
          const name = await promptSheet({ title: 'Rename chat', value: titleOf(chat), confirmLabel: 'Rename' });
          if (!name || disposed) return;
          renameChatTitle(chatId, name);
          const { renderSidebar } = await import('../ui/sidebar');
          renderSidebar();
          syncMeta();
        },
      },
      {
        label: pinned ? 'Unpin' : 'Pin to top',
        glyph: 'fi-rr-thumbtack',
        run: async () => {
          if (disposed) return;
          setChatPinned(chat, !pinned);
          scheduleSaveSessions();
          const { renderSidebar } = await import('../ui/sidebar');
          renderSidebar();
        },
      },
      {
        label: 'Choose model',
        glyph: 'fi-rr-microchip',
        run: async () => {
          const { openActiveChatModelSelect } = await import('../ui/composer-model-trigger');
          if (!disposed) openActiveChatModelSelect();
        },
      },
      { label: 'Change workflow', glyph: 'fi-rr-layers', run: () => changeMode() },
      { label: 'Browse files', glyph: 'fi-rr-folder', run: () => deps.openFiles() },
      { label: 'Open menu', glyph: 'fi-rr-menu-burger', run: () => deps.openMenu() },
      {
        label: 'Delete chat',
        glyph: 'fi-rr-trash',
        danger: true,
        run: async () => {
          const { deleteChat } = await import('../ui/sidebar');
          if (disposed) return;
          await deleteChat(chatId, undefined, () => !disposed);
          if (!disposed && !findChat(chatId)) popScreen();
        },
      },
    ]);
  }

  const unsubs: (() => void)[] = [];
  let metaTimer = 0;
  const scheduleMeta = () => {
    if (metaTimer) return;
    metaTimer = window.setTimeout(() => {
      metaTimer = 0;
      syncMeta();
    }, 400);
  };
  unsubs.push(subscribeChatStreamActivity((id) => {
    if (id === chatId) scheduleMeta();
  }));
  unsubs.push(subscribeChatStreamEnd(() => syncMeta()));
  void import('../ui/sidebar').then(({ subscribeSidebarRender }) => {
    if (disposed) return;
    unsubs.push(subscribeSidebarRender(() => {
      if (visible) scheduleMeta();
    }));
  });

  return {
    key: `chat:${chatId}`,
    el: root,
    onShow() {
      visible = true;
      mount();
      syncMeta();
      void mountPanels();
    },
    onHide() {
      visible = false;
      disposePanels?.();
      disposePanels = undefined;
    },
    dispose() {
      disposed = true;
      for (const unsub of unsubs) unsub();
      window.clearTimeout(metaTimer);
      handle?.dispose();
      handle = null;
      disposePanels?.();
      disposePanels = undefined;
    },
  };
}
