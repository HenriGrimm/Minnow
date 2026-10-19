/** Chats tab root: the current workspace's conversations. */

import { getChatItemDotContext, resolveChatItemDotState, subscribeChatInputPending } from '../ui/chat-item-dot';
import { subscribeChatStreamActivity, subscribeChatStreamEnd } from '../chat/streaming-state';
import { isChatPinned, isBoardOwnedChat } from '../state/chat-groups';
import { getSidebarListedChatsForWorkspace, formatDraftChatSidebarName } from '../state/session-workspace-scope';
import { getChatSummaryPreview, isHiddenFromMainSidebar, sessionState } from '../state/sessions';
import { getWorkspaceLabel, getWorkspacePath, subscribeWorkspace } from '../state/workspace';
import { isChatsWorkspacePath } from '../lib/chats-workspace';
import { PLACEHOLDER_CHAT_NAME } from '../constants';
import type { Chat } from '../types';
import { chatPreview } from './chat-preview';
import { attachPullToRefresh, fab, screenHeader, searchField } from './chrome';
import { el, emptyState, icon, iconButton, shortTime } from './dom';
import { modeGlyph } from './modes';
import type { MobileScreen } from './nav';
import { openActionSheet } from './sheet';
import { switchWorkspaceFromSheet } from './workspace-switch';

export interface ChatsScreenDeps {
  openChat(chatId: string): void;
  newChat(): void;
  openSettings(): void;
}

function chatTitle(chat: Chat): string {
  const name = chat.name?.trim();
  if (name && name !== PLACEHOLDER_CHAT_NAME) return name;
  if (chat.composerDraft?.trim()) return formatDraftChatSidebarName(chat);
  return 'New chat';
}


function listedChats(): Chat[] {
  if (!sessionState) return [];
  return getSidebarListedChatsForWorkspace(getWorkspacePath(), sessionState)
    .filter((chat) => !isHiddenFromMainSidebar(chat))
    .filter((chat) => !isBoardOwnedChat(chat))
    .filter((chat) => !isChatsWorkspacePath(chat.workspacePath ?? ''));
}

const STATUS_LABEL: Record<string, string> = {
  working: 'Working',
  'needs-input': 'Needs you',
  error: 'Failed',
  unread: 'New reply',
};

function buildRow(chat: Chat, deps: ChatsScreenDeps, dot: string): HTMLElement {
  const preview = chatPreview(chat, getChatSummaryPreview(chat.id));
  const status = STATUS_LABEL[dot];
  return el(
    'button',
    {
      className: `m-chat-row m-chat-row--${dot}`,
      attrs: { type: 'button' },
      dataset: { chatId: chat.id },
      on: { click: () => deps.openChat(chat.id) },
    },
    el('span', { className: 'm-chat-row__avatar' }, icon(modeGlyph(chat.modeId), 16)),
    el(
      'span',
      { className: 'm-chat-row__main' },
      el(
        'span',
        { className: 'm-chat-row__top' },
        el('span', { className: 'm-chat-row__title', text: chatTitle(chat) }),
        isChatPinned(chat) ? el('span', { className: 'm-chat-row__pin' }, icon('fi-rr-thumbtack', 12)) : null,
        el('span', { className: 'm-chat-row__time', text: shortTime(chat.lastMessageAt ?? chat.updatedAt) }),
      ),
      el(
        'span',
        { className: 'm-chat-row__bottom' },
        el('span', { className: 'm-chat-row__preview', text: preview || ' ' }),
        status
          ? el('span', { className: `m-status m-status--${dot}`, text: status })
          : null,
      ),
    ),
  );
}


export function createChatsScreen(deps: ChatsScreenDeps): MobileScreen {
  let query = '';
  let frame = 0;
  let visible = true;

  const header = screenHeader({
    title: 'Chats',
    large: true,
    actions: [iconButton('fi-rr-menu-dots-vertical', 'More', () => openMenu())],
  });
  const workspaceBtn = el(
    'button',
    {
      className: 'm-workspace-chip',
      attrs: { type: 'button', 'aria-label': 'Switch workspace' },
      on: { click: () => void switchWorkspaceFromSheet() },
    },
    icon('fi-rr-folder', 14),
    el('span', { className: 'm-workspace-chip__label' }),
    icon('fi-rr-angle-small-down', 14),
  );
  const search = searchField('Search chats', (text) => {
    query = text.toLowerCase();
    render();
  });
  const list = el('div', { className: 'm-list', attrs: { role: 'list' } });
  const body = el('div', { className: 'm-screen__body' }, el('div', { className: 'm-toolbar' }, workspaceBtn), search.el, list);
  const newChatFab = fab('fi-rr-edit', 'New chat', () => deps.newChat());
  const root = el(
    'section',
    { className: 'm-screen m-screen--root', dataset: { screen: 'chats' } },
    header.el,
    body,
    newChatFab,
  );

  attachPullToRefresh(body, async () => {
    const { loadSessionsFromStorage } = await import('../state/sessions');
    await loadSessionsFromStorage({ force: true });
    render();
  });

  function openMenu(): void {
    openActionSheet('Minnow', [
      { label: 'Switch workspace', glyph: 'fi-rr-folder', run: () => switchWorkspaceFromSheet() },
      { label: 'Settings', glyph: 'fi-rr-settings', run: () => deps.openSettings() },
    ]);
  }

  function render(): void {
    frame = 0;
    const label = getWorkspaceLabel() || 'Workspace';
    const labelEl = workspaceBtn.querySelector('.m-workspace-chip__label');
    if (labelEl) labelEl.textContent = label;
    const all = listedChats();
    const chats = query
      ? all.filter((chat) => `${chatTitle(chat)} ${chatPreview(chat, getChatSummaryPreview(chat.id))}`.toLowerCase().includes(query))
      : all;
    const ctx = getChatItemDotContext(null);
    const pinned = chats.filter(isChatPinned);
    const rest = chats.filter((chat) => !isChatPinned(chat));
    const nodes: HTMLElement[] = [];
    if (pinned.length) {
      nodes.push(el('h2', { className: 'm-section-label', text: 'Pinned' }));
      for (const chat of pinned) nodes.push(buildRow(chat, deps, resolveChatItemDotState(chat, ctx)));
      if (rest.length) nodes.push(el('h2', { className: 'm-section-label', text: 'Recent' }));
    }
    for (const chat of rest) nodes.push(buildRow(chat, deps, resolveChatItemDotState(chat, ctx)));
    if (!nodes.length) {
      nodes.push(
        query
          ? emptyState({ glyph: 'fi-rr-search', title: 'No matching chats' })
          : emptyState({
              glyph: 'fi-rr-comment',
              title: 'No chats yet',
              body: `Start a conversation in ${label}.`,
              action: { label: 'New chat', onClick: () => deps.newChat() },
            }),
      );
    }
    list.replaceChildren(...nodes);
  }

  function schedule(): void {
    if (!visible || frame) return;
    frame = requestAnimationFrame(render);
  }

  const unsubs: (() => void)[] = [];
  void import('../ui/sidebar').then(({ subscribeSidebarRender }) => unsubs.push(subscribeSidebarRender(schedule)));
  unsubs.push(subscribeWorkspace(schedule));
  unsubs.push(subscribeChatStreamEnd(schedule));
  unsubs.push(subscribeChatInputPending(schedule));
  // Stream deltas only flip a row into Working; one paint per burst is enough.
  let streamTimer = 0;
  unsubs.push(
    subscribeChatStreamActivity(() => {
      if (streamTimer) return;
      streamTimer = window.setTimeout(() => {
        streamTimer = 0;
        schedule();
      }, 1000);
    }),
  );
  render();

  return {
    key: 'chats',
    el: root,
    onShow() {
      visible = true;
      render();
    },
    onHide() {
      visible = false;
    },
    dispose() {
      for (const unsub of unsubs) unsub();
    },
  };
}
