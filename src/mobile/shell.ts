/** The dedicated Graphite phone workspace over Minnow’s shared runtime. */

import '../styles/mobile-app.css';
import { getChatItemDotContext, resolveChatItemDotState } from '../ui/chat-item-dot';
import { listIssues } from '../state/issues-store';
import { sessionState } from '../state/sessions';
import { getWorkspaceLabel, getWorkspacePath, subscribeWorkspace } from '../state/workspace';
import { normalizeWorkspacePath, workspacePathsEqual } from '../lib/normalize-workspace-path';
import type { NotificationRecord } from '../notifications/types';
import { createBoardScreen } from './board';
import { createBoardsScreen } from './boards';
import { createChatThreadScreen } from './chat-thread';
import { createChatsScreen, createMobileModelCard, listedMobileChats } from './chats';
import { el, icon, iconButton } from './dom';
import { createFileViewerScreen } from './file-viewer';
import { createDirScreen } from './files';
import { createIssueScreen } from './issue';
import { createIssuesScreen } from './issues';
import { getActiveTab, getMobileWorkspaceScope, getTopScreen, onTabChange, popToRoot, pushScreen, registerTab, resetWorkspaceScreens, selectTab, type MobileTabId } from './nav';
import { closeMobileSheets, openSheet } from './sheet';
import { openPhoneApp } from './apps';
import { switchWorkspaceFromSheet } from './workspace-switch';
import { isPairedDevice } from '../api/session-token';

const TABS: readonly MobileTabId[] = ['chats', 'boards', 'issues', 'files'];

const TAB_KEY = 'minnow.mobile.tab';

let mounted = false;
let creatingThread = false;

// ── Navigation ───────────────────────────────────────────────────────────────

function openChat(chatId: string, options?: { initialPrompt?: string; focus?: boolean }): void {
  pushScreen(createChatThreadScreen(chatId, {
    openFiles: () => selectTab('files'), openMenu: openDrawer, ...options,
  }), 'chats');
}

async function newChat(prompt?: string): Promise<boolean> {
  if (creatingThread) return false;
  creatingThread = true;
  const scope = getMobileWorkspaceScope();
  try {
    const { createChatWithMode } = await import('../ui/sidebar');
    const { normalizeModeId } = await import('../chat/modes/registry');
    const { getActiveChat } = await import('../state/sessions');
    if (scope !== getMobileWorkspaceScope()) return false;
    const lastMode = normalizeModeId(getActiveChat()?.modeId);
    const result = await createChatWithMode({ modeId: lastMode === 'orchestrate' ? 'general' : lastMode, forceNewChat: true });
    if (scope !== getMobileWorkspaceScope()) return false;
    if (!result.ok || !result.chatId) throw new Error(result.error ?? 'Could not start a thread');
    openChat(result.chatId, { initialPrompt: prompt, focus: true });
    return true;
  } catch (error) {
    const { showToast } = await import('../ui/toast');
    showToast(error instanceof Error ? error.message : 'Could not start a thread', 'error');
    return false;
  } finally {
    creatingThread = false;
  }
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

function openDrawer(): void {
  const current = getActiveTab();
  const chats = listedMobileChats();
  const workspaceLabel = getWorkspaceLabel() || 'Minnow';
  const ctx = getChatItemDotContext(null);
  const modelCard = createMobileModelCard(() => run(() => openPhoneApp('models')));
  const panel = el('div', { className: 'm-drawer' });
  const drawer = openSheet(panel, { title: 'Minnow', placement: 'left', onClose: modelCard.dispose });

  function run(action: () => void): void {
    drawer.close();
    action();
  }

  function navRow(label: string, glyph: string, action: () => void, options?: { tab?: MobileTabId; count?: number; selected?: boolean }) {
    return el('button', {
      className: 'm-drawer__nav',
      attrs: { type: 'button', 'aria-current': options?.selected ? 'page' : null },
      dataset: options?.tab ? { tab: options.tab } : undefined,
      on: { click: () => run(action) },
    }, icon(glyph, 16), el('span', { className: 'm-drawer__name', text: label }),
    options?.count ? el('span', { className: 'm-drawer__meta', text: String(options.count) }) : null);
  }

  const workspace = el('button', {
    className: 'm-drawer__workspace',
    attrs: { type: 'button', 'aria-label': 'Switch workspace' },
    on: { click: () => run(() => void switchWorkspaceFromSheet()) },
  },
  el('span', { className: 'm-drawer__logo', attrs: { 'aria-hidden': 'true' }, text: workspaceLabel.charAt(0).toLowerCase() }),
  el('span', { className: 'm-drawer__workspace-copy' },
    el('strong', { text: workspaceLabel }),
    el('span', { className: 'm-mono', text: getWorkspacePath() }),
  ), icon('fi-rr-sort-alt', 14));

  const start = el('button', {
    className: 'm-drawer__new',
    attrs: { type: 'button' },
    on: { click: () => run(() => void newChat()) },
  }, icon('fi-rr-pencil', 14), el('span', { text: 'New thread' }));

  const applications = el('nav', { className: 'm-drawer__apps', attrs: { 'aria-label': 'Workspace apps' } });
  applications.append(
    navRow('Threads', 'fi-rr-comment', () => { selectTab('chats'); popToRoot('chats'); }, { tab: 'chats', count: chats.length, selected: current === 'chats' }),
    navRow('Issues', 'fi-rr-ticket', () => selectTab('issues'), { tab: 'issues', count: countIssuesNeedingInput(), selected: current === 'issues' }),
    navRow('Boards', 'fi-rr-layers', () => selectTab('boards'), { tab: 'boards', selected: current === 'boards' }),
    navRow('Files', 'fi-rr-folder', () => selectTab('files'), { tab: 'files', selected: current === 'files' }),
    navRow('Brain', 'fi-rr-book-alt', () => openPhoneApp('brain')),
    navRow('Automations', 'fi-rr-bolt', () => openPhoneApp('scheduler')),
    navRow('Models', 'fi-rr-microchip', () => openPhoneApp('models')),
    navRow('Settings', 'fi-rr-settings-sliders', () => openPhoneApp('settings')),
  );
  if (chats.length) applications.append(el('h2', { className: 'm-drawer__label', text: 'Recent threads' }));
  for (const chat of chats.slice(0, 5)) {
    const status = resolveChatItemDotState(chat, ctx);
    const title = chat.name?.trim() || 'New thread';
    applications.append(el('button', {
      className: 'm-drawer__nav m-drawer__thread',
      attrs: { type: 'button' },
      on: { click: () => run(() => openChat(chat.id)) },
    }, el('span', { className: 'm-drawer__thread-dot', dataset: { status } }),
    el('span', { className: 'm-drawer__name', text: title })));
  }

  const footer = el('div', { className: 'm-drawer__footer' }, modelCard.el);
  if (isPairedDevice()) {
    footer.append(el('button', {
      className: 'm-drawer__device',
      attrs: { type: 'button' },
      on: { click: () => run(() => openPhoneApp('settings', { settingsSection: 'devices' })) },
    }, icon('fi-rr-mobile', 13), el('span', { text: 'Paired device' })));
  }
  panel.append(workspace, start, applications, footer);
}

/** Notifications deep-link into the matching phone screen. Returns false to fall back. */
export async function openMobileNotificationTarget(record: NotificationRecord): Promise<boolean> {
  if (!mounted) return false;
  const { acknowledgeChatViewed } = await import('../notifications/acknowledge');
  const { markNotificationRead } = await import('../notifications/store');
  if (record.chatId?.trim()) {
    if (!sessionState?.chats.some(chat => chat.id === record.chatId)) return false;
    acknowledgeChatViewed(record.chatId);
    openChat(record.chatId);
    return true;
  }
  if (record.appId === 'issues') {
    markNotificationRead(record.id);
    selectTab('issues');
    return true;
  }
  const app = record.kind === 'device_request' ? 'settings' : record.appId;
  if (app === 'settings' || app === 'brain' || app === 'models' || app === 'scheduler') {
    markNotificationRead(record.id);
    openPhoneApp(app, { settingsSection: record.kind === 'device_request' ? 'devices' : undefined });
    return true;
  }
  return false;
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
    if (saved && (TABS as readonly string[]).includes(saved)) return saved as MobileTabId;
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
    const host = el('div', { className: 'm-tab-host', dataset: { tab } });
    host.hidden = tab !== 'chats';
    hosts.set(tab, host);
    stage.append(host);
  }
  const workspaceFrame = el('div', { className: 'm-workspace' }, stage);
  const shell = el('div', { className: 'm-app', attrs: { id: 'mobileShell' } }, workspaceFrame);
  document.body.append(shell);
  const startupToasts = document.body.querySelector(':scope > .mn-toast-stack');
  if (startupToasts) shell.append(startupToasts);

  function mountRoots(): void {
    registerTab('chats', hosts.get('chats')!, createChatsScreen({
      openChat, newChat, openMenu: openDrawer, openModels: () => openPhoneApp('models'),
      openAlertsSettings: () => openPhoneApp('settings', { settingsSection: 'notifications' }),
    }));
    const roots = {
      boards: createBoardsScreen({ openBoard }),
      issues: createIssuesScreen({ openIssue }),
      files: createDirScreen('.', { openDir, openFile }),
    };
    for (const id of ['boards', 'issues', 'files'] as const) {
      const screen = roots[id];
      screen.el.querySelector('.m-header__actions')?.append(iconButton('fi-rr-menu-burger', 'Open menu', openDrawer));
      registerTab(id, hosts.get(id)!, screen);
    }
  }

  let workspace = getWorkspacePath();
  subscribeWorkspace(() => {
    const next = getWorkspacePath();
    if (workspace === next || workspacePathsEqual(workspace, next)) return;
    workspace = next;
    resetWorkspaceScreens();
    closeMobileSheets();
    mountRoots();
    getTopScreen()?.onShow?.();
  });
  mountRoots();

  const initial = restoredTab();
  if (initial !== 'chats') selectTab(initial);

  onTabChange((tab) => {
    try { window.localStorage.setItem(TAB_KEY, tab); } catch {}
  });

  // Keep the composer above the software keyboard.
  const viewport = window.visualViewport;
  if (viewport) {
    const syncKeyboard = () => {
      if (viewport.scale !== 1) return;
      const covered = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
      document.documentElement.style.setProperty('--m-viewport-covered', `${covered}px`);
      shell.classList.toggle('is-keyboard-open', window.innerHeight - viewport.height > 80);
    };
    viewport.addEventListener('resize', syncKeyboard);
    viewport.addEventListener('scroll', syncKeyboard);
    syncKeyboard();
  }
}
