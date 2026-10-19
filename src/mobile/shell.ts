/**
 * The phone app: four tabs (Chats, Boards, Issues, Files) over the same
 * sessions, engine, issue store and board server as the desktop.
 */

import '../styles/mobile-app.css';
import { getChatItemDotContext, resolveChatItemDotState, subscribeChatInputPending } from '../ui/chat-item-dot';
import { subscribeChatStreamEnd } from '../chat/streaming-state';
import { listIssues } from '../state/issues-store';
import { subscribeIssuesChanges } from '../state/issues-events';
import { sessionState } from '../state/sessions';
import { getWorkspacePath } from '../state/workspace';
import { normalizeWorkspacePath } from '../lib/normalize-workspace-path';
import type { NotificationRecord } from '../notifications/types';
import { createBoardScreen } from './board';
import { createBoardsScreen } from './boards';
import { createChatThreadScreen } from './chat-thread';
import { createChatsScreen } from './chats';
import { el, icon } from './dom';
import { createFileViewerScreen } from './file-viewer';
import { createDirScreen } from './files';
import { createIssueScreen } from './issue';
import { createIssuesScreen } from './issues';
import { setMobileShellPreference } from './mode';
import { getActiveTab, onTabChange, popToRoot, pushScreen, registerTab, selectTab, type MobileTabId } from './nav';
import { openSheet, pickFromSheet } from './sheet';

const TABS: { id: MobileTabId; label: string; glyph: string; glyphActive: string }[] = [
  { id: 'chats', label: 'Chats', glyph: 'fi-rr-comment', glyphActive: 'fi-sr-comment' },
  { id: 'boards', label: 'Boards', glyph: 'fi-rr-square-kanban', glyphActive: 'fi-sr-square-kanban' },
  { id: 'issues', label: 'Issues', glyph: 'fi-rr-ticket', glyphActive: 'fi-sr-ticket' },
  { id: 'files', label: 'Files', glyph: 'fi-rr-folder', glyphActive: 'fi-sr-folder' },
];

const TAB_KEY = 'minnow.mobile.tab';

let mounted = false;

// ── Navigation ───────────────────────────────────────────────────────────────

function openChat(chatId: string): void {
  pushScreen(createChatThreadScreen(chatId, { openFiles: () => selectTab('files') }), 'chats');
}

async function newChat(): Promise<void> {
  const { createChatWithMode } = await import('../ui/sidebar');
  const { normalizeModeId } = await import('../chat/modes/registry');
  const { getActiveChat } = await import('../state/sessions');
  const lastMode = normalizeModeId(getActiveChat()?.modeId);
  const result = await createChatWithMode({ modeId: lastMode === 'orchestrate' ? 'general' : lastMode, forceNewChat: true });
  if (!result.ok || !result.chatId) {
    const { showToast } = await import('../ui/toast');
    showToast(result.error ?? 'Could not start a chat', 'error');
    return;
  }
  openChat(result.chatId);
  // Land in the composer so the keyboard is up.
  requestAnimationFrame(() => document.getElementById('msgInput')?.focus());
}

function openBoard(boardId: string): void {
  pushScreen(createBoardScreen(boardId), 'boards');
}

function openIssue(issueId: string): void {
  pushScreen(createIssueScreen(issueId, { openChat, openIssue, openFile }), 'issues');
}

function openDir(path: string): void {
  if (path === '.' || !path) {
    selectTab('files');
    popToRoot('files');
    return;
  }
  pushScreen(createDirScreen(path, { openDir, openFile }), 'files');
}

function openFile(path: string): void {
  pushScreen(createFileViewerScreen(path.replace(/^\.\//, ''), { openDir }), 'files');
}

function openSettings(): void {
  const row = (label: string, glyph: string, onClick: () => void, description?: string) =>
    el(
      'button',
      { className: 'm-pick__row', attrs: { type: 'button' }, on: { click: onClick } },
      el('span', { className: 'm-pick__icon' }, icon(glyph, 18)),
      el('span', { className: 'm-pick__text' }, el('span', { className: 'm-pick__label', text: label }), description ? el('span', { className: 'm-pick__desc', text: description }) : null),
    );
  const sheet = openSheet(
    el(
      'div',
      { className: 'm-pick' },
      row('Appearance', 'fi-rr-palette', () => {
        sheet.close();
        void pickFromSheet('Appearance', [
          { value: 'system' as const, label: 'Match phone', glyph: 'fi-rr-mobile-notch' },
          { value: 'light' as const, label: 'Light', glyph: 'fi-rr-sun' },
          { value: 'dark' as const, label: 'Dark', glyph: 'fi-rr-moon' },
        ]).then(async (pref) => {
          if (!pref) return;
          const { setThemePreference } = await import('../ui/theme');
          setThemePreference(pref);
        });
      }),
      row('Use the desktop layout', 'fi-rr-computer', () => {
        setMobileShellPreference('off');
        window.location.reload();
      }, 'The full app, sized down. Best on a tablet.'),
    ),
    { title: 'Settings' },
  );
}

/** Notifications deep-link into the matching phone screen. Returns false to fall back. */
export async function openMobileNotificationTarget(record: NotificationRecord): Promise<boolean> {
  if (!mounted) return false;
  const { acknowledgeChatViewed } = await import('../notifications/acknowledge');
  const { markNotificationRead } = await import('../notifications/store');
  if (record.chatId?.trim()) {
    acknowledgeChatViewed(record.chatId);
    openChat(record.chatId);
    return true;
  }
  markNotificationRead(record.id);
  if (record.appId === 'issues') {
    selectTab('issues');
    return true;
  }
  return false;
}

// ── Tab bar ──────────────────────────────────────────────────────────────────

function buildTabBar(): { el: HTMLElement; setBadge(tab: MobileTabId, count: number): void } {
  const badges = new Map<MobileTabId, HTMLElement>();
  const buttons = new Map<MobileTabId, HTMLButtonElement>();
  const bar = el('nav', { className: 'm-tabbar', attrs: { 'aria-label': 'Sections' } });
  for (const tab of TABS) {
    const badge = el('span', { className: 'm-tabbar__badge', attrs: { 'aria-hidden': 'true' } });
    badge.hidden = true;
    const glyph = icon(tab.glyph, 22);
    const button = el(
      'button',
      {
        className: 'm-tabbar__tab',
        attrs: { type: 'button', 'aria-label': tab.label },
        dataset: { tab: tab.id },
        on: { click: () => selectTab(tab.id) },
      },
      el('span', { className: 'm-tabbar__icon' }, glyph, badge),
      el('span', { className: 'm-tabbar__label', text: tab.label }),
    );
    buttons.set(tab.id, button);
    badges.set(tab.id, badge);
    bar.append(button);
  }
  const sync = (active: MobileTabId) => {
    for (const tab of TABS) {
      const button = buttons.get(tab.id)!;
      const selected = tab.id === active;
      if (selected) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
      const glyph = button.querySelector('.m-tabbar__icon > i');
      if (glyph) glyph.className = `fi ${selected ? tab.glyphActive : tab.glyph} icon-svg`;
    }
  };
  sync(getActiveTab());
  onTabChange((tab) => {
    sync(tab);
    try {
      window.localStorage.setItem(TAB_KEY, tab);
    } catch {}
  });
  return {
    el: bar,
    setBadge(tab, count) {
      const badge = badges.get(tab);
      if (!badge) return;
      badge.hidden = count <= 0;
      badge.textContent = count > 9 ? '9+' : String(count);
      buttons.get(tab)?.setAttribute('aria-label', count > 0 ? `${TABS.find((t) => t.id === tab)?.label}, ${count} need you` : TABS.find((t) => t.id === tab)?.label ?? tab);
    },
  };
}

function countChatsNeedingInput(): number {
  if (!sessionState) return 0;
  const ctx = getChatItemDotContext(null);
  const workspace = normalizeWorkspacePath(getWorkspacePath());
  return sessionState.chats.filter(
    (chat) => normalizeWorkspacePath(chat.workspacePath ?? '') === workspace && resolveChatItemDotState(chat, ctx) === 'needs-input',
  ).length;
}

function countIssuesNeedingInput(): number {
  try {
    const workspace = normalizeWorkspacePath(getWorkspacePath());
    return listIssues().filter(
      (issue) => issue.agent?.phase === 'awaiting_input' && normalizeWorkspacePath(issue.workspacePath) === workspace,
    ).length;
  } catch {
    return 0;
  }
}

// ── Mount ────────────────────────────────────────────────────────────────────

function restoredTab(): MobileTabId {
  try {
    const saved = window.localStorage.getItem(TAB_KEY);
    if (saved && TABS.some((tab) => tab.id === saved)) return saved as MobileTabId;
  } catch {}
  return 'chats';
}

/** Build the phone app over the booted engine. Call once, after initApp. */
export function mountMobileShell(): void {
  if (mounted) return;
  mounted = true;

  const stage = el('div', { className: 'm-stage' });
  const hosts = new Map<MobileTabId, HTMLElement>();
  for (const tab of TABS) {
    const host = el('div', { className: 'm-tab-host', dataset: { tab: tab.id } });
    host.hidden = tab.id !== 'chats';
    hosts.set(tab.id, host);
    stage.append(host);
  }
  const tabBar = buildTabBar();
  const shell = el('div', { className: 'm-app', attrs: { id: 'mobileShell' } }, stage, tabBar.el);
  document.body.append(shell);

  registerTab('chats', hosts.get('chats')!, createChatsScreen({ openChat, newChat: () => void newChat(), openSettings }));
  registerTab('boards', hosts.get('boards')!, createBoardsScreen({ openBoard }));
  registerTab('issues', hosts.get('issues')!, createIssuesScreen({ openIssue }));
  registerTab('files', hosts.get('files')!, createDirScreen('.', { openDir, openFile }));

  const initial = restoredTab();
  if (initial !== 'chats') selectTab(initial);

  let badgeFrame = 0;
  const syncBadges = () => {
    if (badgeFrame) return;
    badgeFrame = requestAnimationFrame(() => {
      badgeFrame = 0;
      tabBar.setBadge('chats', countChatsNeedingInput());
      tabBar.setBadge('issues', countIssuesNeedingInput());
    });
  };
  subscribeChatInputPending(syncBadges);
  subscribeChatStreamEnd(syncBadges);
  subscribeIssuesChanges(syncBadges);
  syncBadges();

  // Keep the composer above the software keyboard.
  const viewport = window.visualViewport;
  if (viewport) {
    const syncKeyboard = () => {
      const covered = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
      shell.style.setProperty('--m-keyboard', `${covered}px`);
      shell.classList.toggle('is-keyboard-open', covered > 80);
    };
    viewport.addEventListener('resize', syncKeyboard);
    viewport.addEventListener('scroll', syncKeyboard);
    syncKeyboard();
  }
}
