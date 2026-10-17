import { fetchShellProfiles, type ShellProfile } from '../api/terminal-pty';
import { randomUUID } from '../lib/random-id.ts';
import { openContextMenu } from './context-menu';
import {
  formatTerminalTabTitle,
  formatTerminalTabTooltip,
  resolveFileExplorerTerminalCwd,
  terminalCwdsEqual,
} from './terminal-worktree-cwd';
import {
  getTerminalMetaCached,
  loadTerminalMeta,
  saveTerminalMeta,
  saveTerminalMetaKeepalive,
  type TerminalTabMeta,
} from '../config/terminal-meta';
import {
  attachTerminalTab,
  clearTabHistory,
  detachTerminalTab,
  disconnectActiveTerminalWs,
  fitTerminalXterm,
  focusTerminalXterm,
  profileTabTitle,
  setTerminalSessionEndedHandler,
  type TerminalTabSession,
} from './terminal-xterm';

/** Virtual tab id for agent command output (not a PTY session). */
export const AGENT_TAB_ID = '__minnow_agent__';

export type TerminalTabKind = 'agent' | 'pty';

let tabBarEl: HTMLElement | null = null;
let defaultShellProfileId: string | undefined;
let profiles: ShellProfile[] = [];
const liveTabs = new Map<string, TerminalTabSession>();
let tabsInitialized = false;
let onActiveTabChange: ((tabId: string, kind: TerminalTabKind) => void) | null =
  null;
/** When true, the Agent tab shows a pulse dot (agent command running off-tab). */
let agentTabActivityBadge = false;
/** Target cwd for newly opened PTY tabs (follows file explorer). */
let newTabTargetCwd: string | undefined;

export function isAgentTabId(tabId: string): boolean {
  return tabId === AGENT_TAB_ID;
}

function tabKindFromId(tabId: string): TerminalTabKind {
  if (isAgentTabId(tabId)) return 'agent';
  return 'pty';
}

function isVirtualTabId(tabId: string): boolean {
  return isAgentTabId(tabId);
}

export function setTerminalTabChangeHandler(
  handler: (tabId: string, kind: TerminalTabKind) => void,
): void {
  onActiveTabChange = handler;
}

function syncAgentTabActivityBadge(): void {
  const btn = tabBarEl?.querySelector<HTMLButtonElement>('.terminal-tab--agent');
  if (!btn) return;
  btn.classList.toggle('terminal-tab--agent-run', agentTabActivityBadge);
  btn.setAttribute(
    'title',
    agentTabActivityBadge
      ? 'Agent command running — click to view output'
      : 'Agent command output',
  );
}

/** Show or hide the activity dot on the Agent tab (MIN-242). */
export function setAgentTabActivityBadge(active: boolean): void {
  agentTabActivityBadge = active;
  syncAgentTabActivityBadge();
}

function notifyActiveTabChange(tabId: string): void {
  onActiveTabChange?.(tabId, tabKindFromId(tabId));
}

function randomTabId(): string {
  return randomUUID();
}

function metaToSession(meta: TerminalTabMeta): TerminalTabSession {
  return {
    tabId: meta.id,
    shellProfileId: meta.shellProfileId,
    sessionId: meta.sessionId ?? null,
    title: meta.title ?? meta.shellProfileId,
    boundCwd: meta.boundCwd,
    chatId: meta.chatId,
  };
}

function sessionsToMeta(): TerminalTabMeta[] {
  return [...liveTabs.values()].map((t, i) => ({
    id: t.tabId,
    shellProfileId: t.shellProfileId,
    title: t.title,
    boundCwd: t.boundCwd,
    chatId: t.chatId ?? null,
    sessionId: t.sessionId ?? null,
    order: i,
  }));
}

/** Visible tab label — shell name plus workspace or worktree scope. */
function resolveTabDisplayTitle(tab: TerminalTabSession): string {
  const cwd = tab.boundCwd ?? resolveFileExplorerTerminalCwd();
  return formatTerminalTabTitle(tab.title, cwd);
}

function resolveTabTooltip(tab: TerminalTabSession): string {
  const cwd = tab.boundCwd ?? resolveFileExplorerTerminalCwd();
  return formatTerminalTabTooltip(tab.title, cwd);
}

/** Scope for the next PTY tab — updated when the file explorer root changes. */
export function setTerminalNewTabScope(cwd: string): void {
  newTabTargetCwd = cwd;
}

/** Cwd of the active PTY tab's spawned session, if any. */
export function getActivePtySessionCwd(): string | undefined {
  const activeId = getTerminalMetaCached().activeTabId;
  if (!activeId || isVirtualTabId(activeId)) return undefined;
  return liveTabs.get(activeId)?.boundCwd;
}

/** True when the active PTY tab was started in a different directory. */
export function activePtyDiffersFromTargetCwd(targetCwd: string): boolean {
  const activeCwd = getActivePtySessionCwd();
  if (!activeCwd) return false;
  return !terminalCwdsEqual(activeCwd, targetCwd);
}

function resolveScopeForNewTab(): { cwd: string } {
  if (newTabTargetCwd) {
    return { cwd: newTabTargetCwd };
  }
  return { cwd: resolveFileExplorerTerminalCwd() };
}

async function persistTabs(activeId: string | null): Promise<void> {
  await saveTerminalMeta({
    tabs: sessionsToMeta(),
    activeTabId: activeId,
  });
}

function renderAgentTab(activeId: string | null): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'terminal-tab terminal-tab--agent';
  btn.setAttribute('role', 'tab');
  btn.dataset.tabId = AGENT_TAB_ID;
  btn.setAttribute(
    'aria-selected',
    activeId === AGENT_TAB_ID ? 'true' : 'false',
  );
  btn.tabIndex = activeId === AGENT_TAB_ID ? 0 : -1;
  btn.textContent = 'Agent';
  btn.title = 'Agent command output';
  btn.addEventListener('click', () => {
    void switchTab(AGENT_TAB_ID);
  });
  return btn;
}

function renderTabBar(activeId: string | null): void {
  if (!tabBarEl) return;
  tabBarEl.innerHTML = '';

  const list = document.createElement('div');
  list.className = 'terminal-tab-list';
  list.setAttribute('role', 'tablist');

  list.appendChild(renderAgentTab(activeId));

  for (const tab of liveTabs.values()) {
    const displayTitle = resolveTabDisplayTitle(tab);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'terminal-tab';
    btn.setAttribute('role', 'tab');
    btn.dataset.tabId = tab.tabId;
    btn.setAttribute('aria-selected', tab.tabId === activeId ? 'true' : 'false');
    btn.tabIndex = tab.tabId === activeId ? 0 : -1;
    btn.title = resolveTabTooltip(tab);
    btn.addEventListener('click', () => {
      void switchTab(tab.tabId);
    });

    const label = document.createElement('span');
    label.className = 'terminal-tab-label';
    label.textContent = displayTitle;
    btn.appendChild(label);

    const close = document.createElement('span');
    close.className = 'terminal-tab-close';
    close.setAttribute('aria-label', `Close ${displayTitle}`);
    close.innerHTML =
      '<i class="fi fi-rr-cross-small icon-svg" aria-hidden="true"></i>';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      void closeTab(tab.tabId);
    });
    btn.appendChild(close);
    list.appendChild(btn);
  }

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'terminal-tab-add';
  addBtn.setAttribute('aria-label', 'New terminal tab');
  addBtn.textContent = '+';
  addBtn.addEventListener('click', () => {
    void addTab();
  });
  const newTab = document.createElement('div');
  newTab.className = 'terminal-new-tab';
  newTab.appendChild(addBtn);

  const shellMenuBtn = document.createElement('button');
  shellMenuBtn.type = 'button';
  shellMenuBtn.className = 'terminal-tab-shell-menu';
  shellMenuBtn.setAttribute('aria-label', 'New terminal tab with shell');
  shellMenuBtn.setAttribute('aria-haspopup', 'menu');
  shellMenuBtn.title = 'New terminal tab with shell';
  shellMenuBtn.disabled = profiles.length === 0;
  shellMenuBtn.innerHTML = '<i class="fi fi-rr-angle-small-down icon-svg" aria-hidden="true"></i>';
  shellMenuBtn.addEventListener('click', () => {
    openContextMenu({
      anchor: shellMenuBtn,
      restoreFocus: shellMenuBtn,
      label: 'New terminal tab with shell',
      items: profiles.map((profile) => ({
        id: profile.id,
        label: profile.label,
        onSelect: async () => { await addTab(profile.id); },
      })),
    });
  });
  newTab.appendChild(shellMenuBtn);

  tabBarEl.appendChild(list);
  tabBarEl.appendChild(newTab);
  syncAgentTabActivityBadge();
}

async function switchTab(tabId: string): Promise<void> {
  if (isVirtualTabId(tabId)) {
    disconnectActiveTerminalWs();
    renderTabBar(tabId);
    await persistTabs(tabId);
    notifyActiveTabChange(tabId);
    return;
  }

  const tab = liveTabs.get(tabId);
  if (!tab) return;

  disconnectActiveTerminalWs();
  try {
    await attachTerminalTab(tab);
  } catch {
    renderTabBar(tabId);
    await persistTabs(tabId);
    notifyActiveTabChange(tabId);
    return;
  }
  renderTabBar(tabId);
  await persistTabs(tabId);
  notifyActiveTabChange(tabId);
  focusTerminalXterm();
}

/** Switch the tab bar to the Agent output tab. */
export async function switchToAgentTab(): Promise<void> {
  if (!tabsInitialized) return;
  await switchTab(AGENT_TAB_ID);
}

export async function addTab(shellProfileId?: string): Promise<string> {
  const meta = getTerminalMetaCached();
  const profileId =
    shellProfileId ??
    meta.defaultShellProfileId ??
    defaultShellProfileId ??
    profiles[0]?.id ??
    'powershell';
  const profile = profiles.find((p) => p.id === profileId) ?? profiles[0];
  const { cwd } = resolveScopeForNewTab();
  const tabId = randomTabId();
  const session: TerminalTabSession = {
    tabId,
    shellProfileId: profile?.id ?? profileId,
    sessionId: null,
    title: profile ? profileTabTitle(profile) : profileId,
    chatId: null,
    boundCwd: cwd,
  };
  liveTabs.set(tabId, session);
  await switchTab(tabId);
  return tabId;
}

/** Shell metadata for a live PTY tab, used to quote explicit user commands safely. */
export function getTerminalTabShellProfile(tabId: string): ShellProfile | undefined {
  const tab = liveTabs.get(tabId);
  if (!tab) return undefined;
  return profiles.find((profile) => profile.id === tab.shellProfileId);
}

export async function closeTab(tabId: string): Promise<void> {
  const tab = liveTabs.get(tabId);
  if (!tab) return;
  await detachTerminalTab(tab, true);
  clearTabHistory(tabId);
  liveTabs.delete(tabId);

  const meta = getTerminalMetaCached();
  let nextActive = meta.activeTabId;
  if (nextActive === tabId) {
    const remaining = [...liveTabs.keys()];
    nextActive = remaining[0] ?? null;
  }

  if (liveTabs.size === 0) {
    await addTab();
    return;
  }

  renderTabBar(nextActive ?? null);
  if (nextActive) {
    await switchTab(nextActive);
  } else {
    await persistTabs(null);
  }
}

/** Whether tab bar wiring and restore have completed. */
export function isTerminalTabsInitialized(): boolean {
  return tabsInitialized;
}

/** Persist open PTY tab metadata before unload so reload restores the tab bar. */
export function flushTerminalTabsForUnload(): void {
  if (!tabsInitialized || liveTabs.size === 0) return;
  const activeId = getTerminalMetaCached().activeTabId ?? null;
  saveTerminalMetaKeepalive({
    tabs: sessionsToMeta(),
    activeTabId: activeId,
  });
}

/** Disconnect all tabs on unload; server PTYs stay alive for reconnect after reload. */
export async function detachAllTerminalTabs(): Promise<void> {
  for (const tab of liveTabs.values()) {
    await detachTerminalTab(tab, false);
  }
  liveTabs.clear();
  tabsInitialized = false;
  if (tabBarEl) tabBarEl.innerHTML = '';
}

/** Initialize tab UI and restore persisted tabs. */
export async function initTerminalTabs(
  tabBar: HTMLElement,
): Promise<void> {
  if (tabsInitialized) return;
  tabBarEl = tabBar;

  setTerminalSessionEndedHandler((tabId) => {
    const tab = liveTabs.get(tabId);
    if (!tab) return;
    tab.sessionId = null;
    const activeId = getTerminalMetaCached().activeTabId ?? null;
    void persistTabs(activeId);
  });

  try {
    const { profiles: list, defaultShellProfileId: defaultId } = await fetchShellProfiles();
    profiles = list;
    defaultShellProfileId = defaultId;
  } catch {
    profiles = [];
    defaultShellProfileId = undefined;
  }

  await loadTerminalMeta();
  const meta = getTerminalMetaCached();
  const saved = meta.tabs ?? [];

  if (saved.length > 0) {
    for (const row of saved) {
      liveTabs.set(row.id, metaToSession(row));
    }
    const active = meta.activeTabId ?? saved[0].id;
    renderTabBar(active);
    if (isVirtualTabId(active)) {
      await switchTab(active);
    } else if (liveTabs.has(active)) {
      await switchTab(active);
    } else {
      await switchTab(saved[0].id);
    }
  } else {
    await addTab(meta.defaultShellProfileId);
  }

  tabsInitialized = true;
}

export function onTerminalPanelResize(): void {
  fitTerminalXterm();
}

export function getActiveTerminalTabId(): string | null {
  return getTerminalMetaCached().activeTabId ?? null;
}
