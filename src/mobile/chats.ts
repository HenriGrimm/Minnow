/** Chats tab root: the current workspace's conversations. */

import { getChatItemDotContext, resolveChatItemDotState, subscribeChatInputPending } from '../ui/chat-item-dot';
import { subscribeChatStreamActivity, subscribeChatStreamEnd } from '../chat/streaming-state';
import { isChatPinned, isBoardOwnedChat } from '../state/chat-groups';
import { getSidebarListedChatsForWorkspace, formatDraftChatSidebarName } from '../state/session-workspace-scope';
import { getChatSummaryPreview, isHiddenFromMainSidebar, sessionState } from '../state/sessions';
import { getWorkspaceLabel, getWorkspacePath, subscribeWorkspace } from '../state/workspace';
import { isChatsWorkspacePath } from '../lib/chats-workspace';
import { openNotificationTarget } from '../notifications/navigate';
import { PLACEHOLDER_CHAT_NAME } from '../constants';
import { formatCodeChangeTotalsText, hasCodeChangeTotals } from '../usage/code-change-ledger';
import type { Chat } from '../types';
import { chatPreview } from './chat-preview';
import { attachPullToRefresh, screenHeader, searchField } from './chrome';
import { el, emptyState, icon, iconButton, shortTime } from './dom';
import { modeGlyph } from './modes';
import type { MobileScreen } from './nav';

export interface ChatsScreenDeps {
  openChat(chatId: string): void;
  newChat(prompt?: string): Promise<boolean>;
  openMenu(): void;
  openModels(): void;
  openAlertsSettings(): void;
}

function chatTitle(chat: Chat): string {
  const name = chat.name?.trim();
  if (name && name !== PLACEHOLDER_CHAT_NAME) return name;
  if (chat.composerDraft?.trim()) return formatDraftChatSidebarName(chat);
  return 'New chat';
}


export function listedMobileChats(): Chat[] {
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
  const changes = chat.codeChangeTotals;
  const changed = hasCodeChangeTotals(changes);
  const status = STATUS_LABEL[dot] ?? (changed && changes ? `Changes to review · ${formatCodeChangeTotalsText(changes)}` : preview);
  const glyph = dot === 'working' ? 'fi-rr-spinner'
    : dot === 'needs-input' || dot === 'error' ? 'fi-rr-exclamation'
      : dot === 'unread' || changed ? 'fi-rr-check-circle'
        : chat.gitBranch ? 'fi-rr-code-branch' : modeGlyph(chat.modeId);
  return el(
    'button',
    {
      className: `m-chat-row m-chat-row--${dot}${changed ? ' m-chat-row--changed' : ''}`,
      attrs: { type: 'button' },
      dataset: { chatId: chat.id },
      on: { click: () => deps.openChat(chat.id) },
    },
    el('span', { className: 'm-chat-row__avatar' }, icon(glyph, 14)),
    el(
      'span',
      { className: 'm-chat-row__main' },
      el(
        'span',
        { className: 'm-chat-row__top' },
        el('span', { className: 'm-chat-row__title', text: chatTitle(chat) }),
        isChatPinned(chat) ? el('span', { className: 'm-chat-row__pin' }, icon('fi-rr-thumbtack', 12)) : null,
      ),
      el(
        'span',
        { className: 'm-chat-row__bottom' },
        el('span', { className: 'm-chat-row__preview', text: status }),
      ),
    ),
    el('span', { className: 'm-chat-row__time', text: shortTime(chat.lastMessageAt ?? chat.updatedAt) }),
  );
}


export function createChatsScreen(deps: ChatsScreenDeps): MobileScreen {
  let query = '';
  let frame = 0;
  let visible = true;
  let disposed = false;

  const menu = iconButton('fi-rr-menu-burger', 'Open menu', deps.openMenu);
  const notifications = el('button', {
    className: 'm-icon-btn m-phone-activity-trigger',
    attrs: { type: 'button', 'aria-label': 'Activity', disabled: true },
  }, icon('fi-rr-bell', 16));
  const header = screenHeader({
    title: 'minnow',
    actions: [iconButton('fi-rr-search', 'Search threads', () => {
      search.el.hidden = !search.el.hidden;
      if (search.el.hidden) {
        search.input.value = '';
        query = '';
        render();
      } else search.input.focus();
    }), notifications],
  });
  header.el.prepend(menu);
  const search = searchField('Search threads', (text) => {
    query = text.toLowerCase();
    render();
  });
  search.el.hidden = true;
  const list = el('div', { className: 'm-list', attrs: { role: 'list' } });
  const body = el('div', { className: 'm-screen__body' }, list);
  const modelCard = createMobileModelCard(deps.openModels);
  const prompt = el('textarea', {
    attrs: { rows: 1, placeholder: 'Start a thread…', 'aria-label': 'Start a thread', spellcheck: 'false' },
  });
  const send = el('button', {
    className: 'm-thread-starter__send',
    attrs: { type: 'submit', 'aria-label': 'Send message', disabled: true },
  }, icon('fi-rr-arrow-small-up', 18));
  const newThread = iconButton('fi-rr-edit', 'New thread', () => void deps.newChat());
  const model = iconButton('fi-rr-microchip', 'Open Models', deps.openModels);
  const form = el('form', { className: 'm-thread-starter' }, prompt,
    el('div', { className: 'm-thread-starter__controls' }, newThread, model, send));
  prompt.addEventListener('input', () => { send.disabled = !prompt.value.trim(); });
  prompt.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      if (!send.disabled) form.requestSubmit();
    }
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (send.disabled || !prompt.value.trim()) return;
    send.disabled = true;
    const captured = prompt.value;
    try {
      if (await deps.newChat(captured.trim()) && prompt.value === captured) prompt.value = '';
    } finally {
      send.disabled = !prompt.value.trim();
    }
  });
  const root = el(
    'section',
    { className: 'm-screen m-screen--root m-graphite-threads', dataset: { screen: 'chats' } },
    header.el,
    search.el,
    modelCard.el,
    body,
    form,
  );

  attachPullToRefresh(body, async () => {
    const { loadSessionsFromStorage } = await import('../state/sessions');
    await loadSessionsFromStorage({ force: true });
    render();
  });

  let closeActivity: (() => void) | undefined;
  let disposeActivity: (() => void) | undefined;
  void import('../ui/agent-activity-panel').then((activity) => {
    if (disposed) return;
    closeActivity = activity.closeAgentActivityPanel;
    disposeActivity = activity.initAgentActivityMenubar(notifications, {
      phone: true,
      open(item) {
        const record = item.notifications.at(-1);
        if (record) void openNotificationTarget(record);
        else if (item.chatId) deps.openChat(item.chatId);
      },
      settings: deps.openAlertsSettings,
    });
    notifications.disabled = false;
  });

  function render(): void {
    frame = 0;
    const label = getWorkspaceLabel() || 'Minnow';
    header.setSubtitle(getWorkspaceLabel());
    const all = listedMobileChats();
    const chats = query
      ? all.filter((chat) => `${chatTitle(chat)} ${chatPreview(chat, getChatSummaryPreview(chat.id))}`.toLowerCase().includes(query))
      : all;
    const ctx = getChatItemDotContext(null);
    const groups = new Map<string, HTMLElement[]>([
      ['Needs you', []], ['Running', []], ['Pinned', []], ['Ready', []], ['Earlier', []],
    ]);
    for (const chat of chats) {
      const status = resolveChatItemDotState(chat, ctx);
      const hasChanges = hasCodeChangeTotals(chat.codeChangeTotals);
      const group = status === 'needs-input' ? 'Needs you' : status === 'working' ? 'Running'
        : isChatPinned(chat) ? 'Pinned' : status === 'unread' || hasChanges ? 'Ready' : 'Earlier';
      groups.get(group)?.push(buildRow(chat, deps, status));
    }
    const nodes: HTMLElement[] = [];
    for (const [title, rows] of groups) {
      if (!rows.length) continue;
      nodes.push(el('h2', { className: 'm-section-label m-graphite-thread-group' },
        el('span', { text: title }), el('span', { className: 'm-mono', text: String(rows.length) })), ...rows);
    }
    if (!nodes.length) {
      nodes.push(
        query
          ? emptyState({ glyph: 'fi-rr-search', title: 'No matching threads' })
          : emptyState({
              glyph: 'fi-rr-comment',
              title: 'No threads yet',
              body: `Start a conversation in ${label}.`,
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
  void import('../ui/sidebar').then(({ subscribeSidebarRender }) => {
    if (!disposed) unsubs.push(subscribeSidebarRender(schedule));
  });
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
      void modelCard.refresh();
    },
    onHide() {
      visible = false;
      closeActivity?.();
      modelCard.pause();
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(frame);
      window.clearTimeout(streamTimer);
      for (const unsub of unsubs) unsub();
      disposeActivity?.();
      modelCard.dispose();
    },
  };
}

/** Live model summary used in the phone list and drawer. */
export function createMobileModelCard(openModels: () => void) {
  const dot = el('span', { className: 'm-model-summary__dot' });
  const title = el('span', { className: 'm-model-summary__title', text: 'Local models' });
  const status = el('span', { className: 'm-model-summary__status' });
  const action = el('span', { className: 'm-model-summary__action', text: 'Open Models' });
  const spark = el('span', { className: 'm-model-summary__spark', attrs: { 'aria-hidden': 'true', hidden: true } });
  const root = el('button', {
    className: 'm-model-summary',
    attrs: { type: 'button', hidden: true },
    on: { click: openModels },
  }, dot, el('span', { className: 'm-model-summary__copy' }, title, status), spark, action);
  let request: AbortController | undefined;
  let unsubscribeActivity: (() => void) | undefined;
  let serveId: string | undefined;
  let lastSample = 0;
  const samples: number[] = [];

  function pause(): void {
    request?.abort();
    unsubscribeActivity?.();
    unsubscribeActivity = undefined;
  }

  async function refresh(): Promise<void> {
    pause();
    const controller = new AbortController();
    request = controller;
    try {
      const { listModelServes } = await import('../models/api-client');
      const rows = await listModelServes(AbortSignal.any([controller.signal, AbortSignal.timeout(4_000)]));
      if (controller.signal.aborted) return;
      const live = rows.find(row => row.status === 'running') ?? rows.find(row => row.status === 'starting');
      if (live?.id !== serveId) {
        serveId = live?.id;
        lastSample = 0;
        samples.length = 0;
        spark.hidden = true;
        spark.replaceChildren();
      }
      root.hidden = !live;
      if (!live) return;
      root.dataset.state = live.status;
      title.textContent = live.modelLabel || 'Local models';
      status.textContent = live.status === 'running' ? 'Ready' : 'Loading…';
      action.hidden = live.status === 'running';
      if (live.status !== 'running') return;
      const { subscribeServeActivityFeed } = await import('../models/serve-activity-feed');
      if (controller.signal.aborted) return;
      unsubscribeActivity = subscribeServeActivityFeed(activity => {
        if (activity.serveId !== live.id || activity.updatedAt <= lastSample) return;
        lastSample = activity.updatedAt;
        const rate = activity.mtplx?.latest?.decode_tok_s
          ?? activity.slots.find(slot => slot.state === 'generating')?.tokensPerSecond;
        if (!activity.available || activity.stale || rate == null || !Number.isFinite(rate) || rate <= 0) {
          status.textContent = 'Ready';
          return;
        }
        status.textContent = `${Math.round(rate)} tok/s · on your computer`;
        samples.push(rate);
        if (samples.length > 15) samples.shift();
        const max = Math.max(...samples);
        spark.replaceChildren(...samples.map(sample => {
          const bar = el('span');
          bar.style.height = `${Math.max(18, sample / max * 100)}%`;
          return bar;
        }));
        spark.hidden = false;
      });
    } catch {
      if (!controller.signal.aborted) status.textContent = 'Unavailable';
    }
  }
  void refresh();
  return { el: root, refresh, pause, dispose: pause };
}
