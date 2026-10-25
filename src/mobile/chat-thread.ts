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

export function createChatThreadScreen(chatId: string, deps: { openFiles(): void }): MobileScreen {
  const header = screenHeader({ title: titleOf(findChat(chatId)), back: true });
  const modeChip = el(
    'button',
    {
      className: 'm-mode-chip',
      attrs: { type: 'button', 'aria-label': 'Change mode' },
      on: { click: () => void changeMode() },
    },
    icon(modeGlyph(findChat(chatId)?.modeId), 12),
    el('span', { className: 'm-mode-chip__label' }),
  );
  const statusText = el('span', { className: 'm-thread__status' });
  const subtitleRow = el('div', { className: 'm-thread__meta' }, modeChip, statusText);
  header.el.querySelector('.m-header__titles')?.append(subtitleRow);
  header.el.querySelector('.m-header__actions')?.append(
    iconButton('fi-rr-menu-dots-vertical', 'Chat actions', () => openMenu()),
  );

  const host = el('div', { className: 'm-thread__host' });
  // The model chip opens the phone sheet; its hover-driven desktop menu is hard to use by touch.
  host.addEventListener(
    'click',
    (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target?.closest('#codeComposerModelAnchor button')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void import('./models').then((m) => m.openModelSheet());
    },
    true,
  );
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
  let visible = false;

  function syncMeta(): void {
    const chat = findChat(chatId);
    if (!chat) return;
    header.setTitle(titleOf(chat));
    const glyph = modeChip.querySelector('i');
    if (glyph) glyph.className = `fi ${modeGlyph(chat.modeId)} icon-svg`;
    const label = modeChip.querySelector('.m-mode-chip__label');
    if (label) label.textContent = modeLabel(chat.modeId);
    const hintGlyph = emptyHint.querySelector('i');
    if (hintGlyph) hintGlyph.className = `fi ${modeGlyph(chat.modeId)} icon-svg`;
    const hintMode = emptyHint.querySelector('.m-thread__empty-mode');
    if (hintMode) hintMode.textContent = `${modeLabel(chat.modeId)} mode · ${getWorkspaceLabel() || 'this workspace'}`;
    const remote = isChatRunningRemotely(chatId);
    const working = isChatStreaming(chatId) || remote;
    statusText.textContent = remote ? 'Working on computer…' : working ? 'Working…' : shortModel(chat);
    statusText.classList.toggle('is-working', working);
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
    addAttachButton();
    host.append(emptyHint);
  }

  /** Phones have no drag-and-drop or paste-heavy flow; give attachments a button. */
  function addAttachButton(): void {
    const actions = host.querySelector<HTMLElement>('#composerInsetActions');
    if (!actions || actions.querySelector('.m-attach-btn')) return;
    const button = el(
      'button',
      {
        className: 'm-attach-btn',
        attrs: { type: 'button', 'aria-label': 'Attach files', title: 'Attach files' },
        on: { click: () => document.getElementById('fileInput')?.click() },
      },
      icon('fi-rr-clip', 18),
    );
    actions.prepend(button);
  }

  async function changeMode(): Promise<void> {
    const chat = findChat(chatId);
    if (!chat) return;
    const next = await pickMode(chat.modeId);
    if (!next || next === chat.modeId) return;
    const { setChatMode } = await import('../ui/mode-selector');
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
          if (!name) return;
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
          const { openModelSheet } = await import('./models');
          await openModelSheet();
        },
      },
      { label: 'Browse files', glyph: 'fi-rr-folder', run: () => deps.openFiles() },
      {
        label: 'Delete chat',
        glyph: 'fi-rr-trash',
        danger: true,
        run: async () => {
          const { deleteChat } = await import('../ui/sidebar');
          await deleteChat(chatId);
          if (!findChat(chatId)) popScreen();
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
    },
    onHide() {
      visible = false;
    },
    dispose() {
      for (const unsub of unsubs) unsub();
      window.clearTimeout(metaTimer);
      handle?.dispose();
      handle = null;
    },
  };
}
