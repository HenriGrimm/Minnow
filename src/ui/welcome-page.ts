import '../styles/workspace-welcome-page.css';

import {
  createWorkspaceSubfolder,
  fetchWorkspace,
  removeRecentWorkspace,
  type WorkspaceRecentItem,
} from '../config/workspace-api';
import { isDefaultWorkspace } from '../state/workspace';
import { detectLocalServer, getLocalServerAvailable } from '../tools/client';
import { isOsShellEnabled } from '../os/page-bridge';
import { executeWorkspaceSwitch } from './workspace-switch-guard';
import { normalizeWorkspacePath } from '../lib/normalize-workspace-path';
import {
  closeOpenWorkspace,
  onOpenWorkspacesChanged,
  readOpenWorkspaceWindows,
  type OpenWorkspaceMap,
} from '../lib/open-workspace-windows';
import { openWorkspaceFolderPicker } from './workspace-folder-picker';
import { setStatus } from './status';
import { MINNOW_GLYPH_HEADER_HTML } from './minnow-glyph';

/** Session-only parent for the create-project wizard (Change location). */
let wizardParentPath = '';

let staticBindingsDone = false;
let createPanelOpen = false;

// ── DOM helpers ──────────────────────────────────────────────────────────────

function getWelcomeRoot(): HTMLElement | null {
  return document.getElementById('welcomeView');
}

function getChatShell(): HTMLElement | null {
  return document.getElementById('appBody');
}

function getTopbar(): HTMLElement | null {
  return document.querySelector('header.topbar');
}

// ── Boot gates ───────────────────────────────────────────────────────────────

/** True for full-page routes that should not auto-open welcome on boot. */
export function isOtherFullPageHash(hash: string): boolean {
  return (
    hash.startsWith('#/settings') ||
    hash.startsWith('#/bugs') ||
    hash.startsWith('#/app/issues') ||
    hash.startsWith('#/benchmark') ||
    hash.startsWith('#/expert-lab') ||
    hash.startsWith('#/experts') ||
    hash.startsWith('#/app/') ||
    hash.startsWith('#/desktop') ||
    hash.startsWith('#/workspaces')
  );
}

/** Whether welcome should open when foregrounding the Code app (Minnow Shell). */
export function shouldPromptCodeWorkspaceWelcome(launchWorkspacePath?: string): boolean {
  if (isOsShellEnabled()) {
    return false;
  }
  if (launchWorkspacePath?.trim()) {
    return false;
  }
  return isDefaultWorkspace();
}

/** Whether welcome should open after init when workspace sync completes. */
export function shouldShowWelcomeOnBoot(): boolean {
  if (isOsShellEnabled()) return false;
  const hash = window.location.hash;
  if (hash.startsWith('#/welcome')) {
    return isDefaultWorkspace();
  }
  if (isOtherFullPageHash(hash)) {
    return false;
  }
  return isDefaultWorkspace() && (hash === '' || hash === '#/' || hash === '#');
}

/** Whether the welcome page is visible. */
export function isWelcomePageOpen(): boolean {
  return getWelcomeRoot()?.classList.contains('is-open') ?? false;
}

function setWelcomePending(pending: boolean): void {
  document.documentElement.classList.toggle('welcome-pending', pending);
}

// ── Workspace gate ───────────────────────────────────────────────────────────

/** Sync banner + disabled state for open/create controls (call after detectLocalServer). */
function syncServerAvailabilityUi(): void {
  const available = getLocalServerAvailable();
  const banner = document.getElementById('welcomeServerBanner');
  const openBtn = document.getElementById('btnWelcomeOpenProject') as HTMLButtonElement | null;
  const createBtn = document.getElementById('btnWelcomeCreateProject') as HTMLButtonElement | null;
  const submitBtn = document.getElementById('btnWelcomeCreateSubmit') as HTMLButtonElement | null;
  const changeParentBtn = document.getElementById(
    'btnWelcomeChangeParent',
  ) as HTMLButtonElement | null;

  if (banner) {
    banner.classList.toggle('hidden', available);
  }
  for (const btn of [openBtn, createBtn, submitBtn, changeParentBtn]) {
    if (btn) {
      btn.disabled = !available;
    }
  }
}

/** Refresh welcome server banner/buttons when tool-server ping result changes. */
export function onWelcomeServerAvailabilityChanged(): void {
  if (!isWelcomePageOpen()) {
    return;
  }
  syncServerAvailabilityUi();
}

function updateParentPathLabel(): void {
  const el = document.getElementById('welcomeParentPath');
  if (el) {
    el.textContent = wizardParentPath.trim() || '…';
    el.title = wizardParentPath;
  }
}

function showCreateError(message: string | null): void {
  const el = document.getElementById('welcomeCreateError');
  if (!el) {
    return;
  }
  if (!message) {
    el.textContent = '';
    el.classList.add('hidden');
    return;
  }
  el.textContent = message;
  el.classList.remove('hidden');
}

let gateSwitchMode = false;

async function setWorkspaceGateOpening(opening: boolean): Promise<void> {
  if (!isOsShellEnabled()) return;
  const gate = await import('../os/workspace-gate');
  gate.markWorkspaceGateOpening(opening);
}

async function completeWorkspaceActivation(): Promise<void> {
  if (isOsShellEnabled()) {
    const gate = await import('../os/workspace-gate');
    if (gateSwitchMode) {
      gateSwitchMode = false;
      await gate.finishWorkspaceGateSwitch();
      return;
    }
    await setWorkspaceGateOpening(true);
    await gate.onWorkspaceGateChosen();
    return;
  }
  closeWelcome();
}

/** Refresh gate UI after open (server banner, recents). */
export function refreshWorkspaceGateUi(): void {
  syncServerAvailabilityUi();
  void detectLocalServer().then(() => {
    syncServerAvailabilityUi();
    void loadWizardParentFromServer().then(() => renderRecentsList());
  });
  showCreatePanel(false);
}

/** Menubar workspace switch — Code already booted; use fast gate close path. */
export function onWorkspaceGateOpenedForSwitch(): void {
  gateSwitchMode = true;
}

/** Boot / route gate — cold pick uses hold-until-paint path. */
export function resetWorkspaceGateSwitchMode(): void {
  gateSwitchMode = false;
}

// ── Create wizard ────────────────────────────────────────────────────────────

function showCreatePanel(show: boolean): void {
  createPanelOpen = show;
  const panel = document.getElementById('welcomeCreatePanel');
  const actions = document.querySelector('.welcome-page__actions');
  if (panel) {
    panel.classList.toggle('hidden', !show);
  }
  if (actions instanceof HTMLElement) {
    actions.classList.toggle('hidden', show);
  }
  if (show) {
    const input = document.getElementById('welcomeProjectName') as HTMLInputElement | null;
    showCreateError(null);
    if (input) {
      input.value = '';
      input.focus();
    }
  }
}

/** Validate a single-segment folder name (mirrors server/workspace/browse.js). */
export function validateProjectFolderName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) {
    return 'Enter a project name';
  }
  if (trimmed === '.' || trimmed === '..') {
    return 'Invalid project name';
  }
  if (/[\\/:*?"<>|]/.test(trimmed)) {
    return 'Name contains invalid characters';
  }
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(trimmed)) {
    return 'Invalid project name';
  }
  return null;
}

async function loadWizardParentFromServer(): Promise<void> {
  const info = await fetchWorkspace();
  if (info?.newProjectParent?.trim()) {
    wizardParentPath = info.newProjectParent.trim();
  }
  updateParentPathLabel();
}

// ── Recents ──────────────────────────────────────────────────────────────────

const SANDBOX_HINT = "Minnow's folder when you don't have a project.";

interface RecentRowOptions {
  pinned?: boolean;
  hint?: string;
  glyphHtml?: string;
}

function appendTrailingActions(li: HTMLLIElement, item: WorkspaceRecentItem, pinned: boolean): HTMLDivElement {
  const actions = document.createElement('div');
  actions.className = 'welcome-page__recents-actions';

  // Only Electron can hold more than one view; the browser has nothing to open.
  if (item.exists && window.minnow?.window?.openWorkspace) {
    const newWindowBtn = document.createElement('button');
    newWindowBtn.type = 'button';
    newWindowBtn.className = 'welcome-page__recents-new-window';
    newWindowBtn.textContent = 'New window';
    newWindowBtn.title = `Open ${item.label} in a new window`;
    newWindowBtn.setAttribute('aria-label', `Open ${item.label} in a new window`);
    newWindowBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      void openRecentWorkspaceInNewWindow(item.path);
    });
    actions.appendChild(newWindowBtn);
  }

  // Sandbox is pinned; it cannot be removed from the list.
  if (!pinned) {
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'welcome-page__recents-remove';
    removeBtn.textContent = 'Remove';
    removeBtn.setAttribute('aria-label', `Remove ${item.label} from recent workspaces`);
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      void (async () => {
        try {
          await removeRecentWorkspace(item.path);
          await renderRecentsList();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          setStatus('err', message);
        }
      })();
    });
    actions.appendChild(removeBtn);
  }

  li.appendChild(actions);
  return actions;
}

function createRecentRow(item: WorkspaceRecentItem, options: RecentRowOptions = {}): HTMLLIElement {
  const li = document.createElement('li');
  li.setAttribute('role', 'listitem');
  li.className = 'welcome-page__recents-item';
  if (options.pinned) li.dataset.pinned = 'true';

  const copy = document.createElement('span');
  copy.className = 'welcome-page__recents-copy';

  const label = document.createElement('span');
  label.className = 'welcome-page__recents-label';
  label.textContent = item.label;
  copy.appendChild(label);

  if (options.hint) {
    const hint = document.createElement('span');
    hint.className = 'welcome-page__recents-hint';
    hint.textContent = options.hint;
    copy.appendChild(hint);
  } else {
    const pathLine = document.createElement('span');
    pathLine.className = 'welcome-page__recents-path';
    pathLine.textContent = item.path;
    pathLine.title = item.path;
    copy.appendChild(pathLine);
  }

  if (!item.exists) {
    const row = document.createElement('div');
    row.className = 'welcome-page__recents-row welcome-page__recents-row--missing';
    if (options.glyphHtml) {
      const glyph = document.createElement('span');
      glyph.className = 'welcome-page__recents-glyph';
      glyph.setAttribute('aria-hidden', 'true');
      glyph.innerHTML = options.glyphHtml;
      row.appendChild(glyph);
    }
    row.appendChild(copy);
    li.appendChild(row);
    appendTrailingActions(li, item, Boolean(options.pinned));
    return li;
  }

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'welcome-page__recents-row';
  btn.title = item.path;

  if (options.glyphHtml) {
    const glyph = document.createElement('span');
    glyph.className = 'welcome-page__recents-glyph';
    glyph.setAttribute('aria-hidden', 'true');
    glyph.innerHTML = options.glyphHtml;
    btn.appendChild(glyph);
  }

  btn.appendChild(copy);
  btn.addEventListener('click', () => {
    void activateRecentWorkspace(item.path);
  });

  li.appendChild(btn);
  appendTrailingActions(li, item, Boolean(options.pinned));
  return li;
}

/**
 * Open a folder in its own window — or focus the window that already has it,
 * since a folder opens in exactly one view.
 */
async function openRecentWorkspaceInNewWindow(absPath: string): Promise<void> {
  const openWorkspace = window.minnow?.window?.openWorkspace;
  if (!openWorkspace) return;
  if (!getLocalServerAvailable()) {
    setStatus('err', 'Workspace requires Minnow running locally');
    return;
  }
  const result = await openWorkspace(absPath);
  if (!result.ok) {
    setStatus('err', result.error);
    return;
  }
  setStatus('ok', result.focused ? 'Focused the window already on that folder' : 'Opened a new window');
  await renderRecentsList();
}

/** Close the window holding a folder, then repaint the row that offered it. */
async function closeRecentWorkspaceWindow(item: WorkspaceRecentItem): Promise<void> {
  const result = await closeOpenWorkspace(item.path);
  if (!result.ok) {
    setStatus('err', result.error);
    return;
  }
  setStatus('ok', result.closed ? `Closed ${item.label}` : `${item.label} was not open`);
  await renderRecentsList();
}

/**
 * Mark a row whose folder already has a window, and offer to close it. Without
 * the close action the only way to release a backgrounded workspace was to quit
 * Minnow, which is how they piled up.
 */
function decorateOpenRecentRow(
  row: HTMLLIElement,
  item: WorkspaceRecentItem,
  openElsewhere: OpenWorkspaceMap,
): void {
  const openWindow = openElsewhere.get(normalizeWorkspacePath(item.path));
  if (!openWindow) return;

  row.dataset.openInWindow = 'true';
  const backgrounded = openWindow.visible === false;
  if (backgrounded) row.dataset.workspaceBackgrounded = 'true';

  const stateLabel = backgrounded ? 'Running in background' : 'Open';
  const button = row.querySelector('button.welcome-page__recents-row');
  if (button instanceof HTMLElement) {
    button.title = backgrounded
      ? `${item.path} — running in the background`
      : `${item.path} — already open in another window`;
    const badge = document.createElement('span');
    badge.className = 'welcome-page__recents-badge';
    badge.textContent = stateLabel;
    button.appendChild(badge);
  }

  const newWindowBtn = row.querySelector('button.welcome-page__recents-new-window');
  if (newWindowBtn instanceof HTMLElement) {
    const focusLabel = backgrounded
      ? `Show the window running ${item.label}`
      : `Focus the window already on ${item.label}`;
    newWindowBtn.textContent = backgrounded ? 'Show' : 'Focus';
    newWindowBtn.title = focusLabel;
    newWindowBtn.setAttribute('aria-label', focusLabel);
  }

  if (!window.minnow?.window?.closeWorkspace) return;
  const actions = row.querySelector('.welcome-page__recents-actions');
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'welcome-page__recents-close';
  closeBtn.textContent = 'Close';
  closeBtn.title = `Close ${item.label} and stop its chats and agents`;
  closeBtn.setAttribute('aria-label', `Close the window on ${item.label}`);
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    void closeRecentWorkspaceWindow(item);
  });
  if (actions instanceof HTMLElement) {
    const removeBtn = actions.querySelector('.welcome-page__recents-remove');
    if (removeBtn) {
      actions.insertBefore(closeBtn, removeBtn);
    } else {
      actions.appendChild(closeBtn);
    }
  } else {
    row.appendChild(closeBtn);
  }
}

async function renderRecentsList(): Promise<void> {
  const list = document.getElementById('welcomeRecentsList');
  const empty = document.getElementById('welcomeRecentsEmpty');
  const pinnedList = document.getElementById('welcomePinnedList');
  if (!list) {
    return;
  }

  const info = await fetchWorkspace();
  const recent = info?.recent ?? [];
  const sandbox = info?.sandbox;
  const openElsewhere = await readOpenWorkspaceWindows();

  if (pinnedList) {
    pinnedList.innerHTML = '';
    if (sandbox) {
      const row = createRecentRow(sandbox, {
        pinned: true,
        hint: SANDBOX_HINT,
        glyphHtml: MINNOW_GLYPH_HEADER_HTML,
      });
      decorateOpenRecentRow(row, sandbox, openElsewhere);
      pinnedList.appendChild(row);
    }
  }

  list.innerHTML = '';
  for (const item of recent) {
    const row = createRecentRow(item);
    decorateOpenRecentRow(row, item, openElsewhere);
    list.appendChild(row);
  }

  if (empty) {
    empty.classList.toggle('hidden', recent.length > 0);
  }
}

async function activateRecentWorkspace(absPath: string): Promise<void> {
  if (!getLocalServerAvailable()) {
    setStatus('err', 'Workspace requires Minnow running locally');
    return;
  }

  // A folder already open somewhere just gets focused — two views on one folder
  // would fight over the same `sessions.db` rows.
  const openWorkspace = window.minnow?.window?.openWorkspace;
  const openWindows = await readOpenWorkspaceWindows();
  if (openWorkspace && openWindows.has(normalizeWorkspacePath(absPath))) {
    const result = await openWorkspace(absPath);
    if (!result.ok) setStatus('err', result.error);
    else setStatus('ok', 'Focused the window already on that folder');
    return;
  }

  setStatus('spin', 'Switching workspace…');
  try {
    const info = await executeWorkspaceSwitch(absPath);
    if (!info) {
      setStatus('ok', 'Workspace unchanged');
      return;
    }
    await setWorkspaceGateOpening(true);
    await completeWorkspaceActivation();
    setStatus('ok', `Workspace: ${info.label}`);
  } catch (err) {
    await setWorkspaceGateOpening(false);
    const message = err instanceof Error ? err.message : String(err);
    setStatus('err', message);
  }
}

// ── Open project ─────────────────────────────────────────────────────────────

async function onOpenProject(): Promise<void> {
  if (!getLocalServerAvailable()) {
    setStatus('err', 'Workspace requires Minnow running locally');
    return;
  }

  setStatus('spin', 'Choose workspace folder…');
  await setWorkspaceGateOpening(true);
  try {
    const result = await openWorkspaceFolderPicker();
    if (result.cancelled) {
      await setWorkspaceGateOpening(false);
      setStatus('ok', 'Workspace unchanged');
      return;
    }
    if (!result.path) {
      await setWorkspaceGateOpening(false);
      setStatus('err', 'No folder selected');
      return;
    }
    await setWorkspaceGateOpening(false);
    const info = await executeWorkspaceSwitch(result.path);
    if (!info) {
      setStatus('ok', 'Workspace unchanged');
      return;
    }
    await setWorkspaceGateOpening(true);
    await completeWorkspaceActivation();
    setStatus('ok', `Workspace: ${info.label}`);
  } catch (err) {
    await setWorkspaceGateOpening(false);
    const message = err instanceof Error ? err.message : String(err);
    setStatus('err', message);
  }
}

async function onChangeWizardParent(): Promise<void> {
  if (!getLocalServerAvailable()) {
    return;
  }
  const result = await openWorkspaceFolderPicker({
    initialPath: wizardParentPath || undefined,
  });
  if (!result.cancelled && result.path) {
    wizardParentPath = result.path;
    updateParentPathLabel();
  }
}

async function onCreateProjectSubmit(): Promise<void> {
  if (!getLocalServerAvailable()) {
    setStatus('err', 'Workspace requires Minnow running locally');
    return;
  }

  const input = document.getElementById('welcomeProjectName') as HTMLInputElement | null;
  const name = input?.value ?? '';
  const validationError = validateProjectFolderName(name);
  if (validationError) {
    showCreateError(validationError);
    input?.focus();
    return;
  }

  const parent = wizardParentPath.trim();
  if (!parent) {
    showCreateError('Choose a parent folder first');
    return;
  }

  const submitBtn = document.getElementById('btnWelcomeCreateSubmit') as HTMLButtonElement | null;
  if (submitBtn) {
    submitBtn.disabled = true;
  }
  showCreateError(null);
  setStatus('spin', 'Creating project…');

  try {
    const created = await createWorkspaceSubfolder(parent, name.trim());
    const info = await executeWorkspaceSwitch(created.path);
    if (!info) {
      setStatus('ok', 'Workspace unchanged');
      return;
    }
    showCreatePanel(false);
    await setWorkspaceGateOpening(true);
    await completeWorkspaceActivation();
  } catch (err) {
    await setWorkspaceGateOpening(false);
    const message = err instanceof Error ? err.message : String(err);
    showCreateError(message);
    setStatus('err', message);
  } finally {
    if (submitBtn) {
      submitBtn.disabled = !getLocalServerAvailable();
    }
  }
}

// ── Page lifecycle ───────────────────────────────────────────────────────────

function closePeerFullPageViews(): void {
  void import('./settings-page').then((m) => {
    if (document.getElementById('settingsView')?.classList.contains('is-open')) {
      m.closeSettings();
    }
  });
  void import('./benchmark-page').then((m) => {
    const benchmarkRoot = document.getElementById('benchmarkView');
    if (benchmarkRoot?.classList.contains('is-open')) {
      m.closeBenchmark();
    }
  });
  void import('./experts/experts-hub').then((m) => {
    if (m.isExpertsPageOpen()) {
      m.closeExpertLab();
    }
  });
}

/** Show welcome and hide the main chat shell. */
export function openWelcome(options?: { skipHash?: boolean }): void {
  if (isOsShellEnabled()) {
    void import('../os/workspace-gate').then((m) => m.openWorkspaceGate());
    return;
  }

  if (!isDefaultWorkspace()) {
    closeWelcome({ skipHash: true });
    return;
  }

  const root = getWelcomeRoot();
  const shell = getChatShell();
  if (!root || !shell) {
    return;
  }

  closePeerFullPageViews();

  root.hidden = false;
  root.classList.add('is-open');
  shell.classList.add('hidden');
  const topbar = getTopbar();
  if (isOsShellEnabled()) {
    root.classList.add('welcome-page--os-overlay');
  } else {
    topbar?.classList.add('topbar--welcome');
  }
  setWelcomePending(false);

  syncServerAvailabilityUi();
  void detectLocalServer().then(() => {
    syncServerAvailabilityUi();
    void loadWizardParentFromServer().then(() => renderRecentsList());
  });
  showCreatePanel(false);

  const nextHash = '#/welcome';
  if (!options?.skipHash && !isOsShellEnabled() && window.location.hash !== nextHash) {
    window.location.hash = nextHash;
  }
}

/** Hide welcome and show the chat shell. */
export function closeWelcome(options?: { skipHash?: boolean }): void {
  const root = getWelcomeRoot();
  const shell = getChatShell();
  if (!root || !shell) {
    return;
  }

  root.classList.remove('is-open');
  root.hidden = true;
  root.classList.remove('welcome-page--os-overlay');
  shell.classList.remove('hidden');
  const topbar = getTopbar();
  topbar?.classList.remove('topbar--welcome');
  if (!isOsShellEnabled()) {
    topbar?.classList.remove('hidden');
  }
  setWelcomePending(false);
  showCreatePanel(false);

  if (!options?.skipHash && !isOsShellEnabled() && window.location.hash.startsWith('#/welcome')) {
    window.location.hash = '#/';
  }

  void import('./preview-electron-visibility').then((m) =>
    m.syncElectronPreviewHostVisibility(),
  );
}

function onHashChange(): void {
  const hash = window.location.hash;

  if (hash.startsWith('#/welcome')) {
    if (!isDefaultWorkspace()) {
      closeWelcome({ skipHash: true });
      if (hash.startsWith('#/welcome')) {
        window.location.hash = '#/';
      }
      return;
    }
    openWelcome({ skipHash: true });
    return;
  }

  if (isWelcomePageOpen() && !isOtherFullPageHash(hash)) {
    closeWelcome({ skipHash: true });
    return;
  }

  const isHomeHash = hash === '' || hash === '#/' || hash === '#';
  if (isHomeHash && isDefaultWorkspace() && !isWelcomePageOpen()) {
    openWelcome({ skipHash: true });
  }
}

function bindStaticControls(): void {
  if (staticBindingsDone) {
    return;
  }
  staticBindingsDone = true;

  document
    .getElementById('btnWelcomeOpenProject')
    ?.addEventListener('click', () => void onOpenProject());

  document.getElementById('btnWelcomeCreateProject')?.addEventListener('click', () => {
    void loadWizardParentFromServer().then(() => showCreatePanel(true));
  });

  document.getElementById('btnWelcomeCreateCancel')?.addEventListener('click', () => {
    showCreatePanel(false);
  });

  document
    .getElementById('btnWelcomeCreateSubmit')
    ?.addEventListener('click', () => void onCreateProjectSubmit());

  document
    .getElementById('btnWelcomeChangeParent')
    ?.addEventListener('click', () => void onChangeWizardParent());

  const projectInput = document.getElementById('welcomeProjectName');
  projectInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && createPanelOpen) {
      e.preventDefault();
      void onCreateProjectSubmit();
    }
  });
}

/** Wire welcome UI, hash routing, and boot gate helpers. */
export function initWelcomePage(): void {
  bindStaticControls();
  window.addEventListener('hashchange', onHashChange);

  // Another window opening or closing changes what these rows should offer.
  onOpenWorkspacesChanged(() => {
    if (document.getElementById('welcomeRecentsList')) void renderRecentsList();
  });

  if (window.location.hash.startsWith('#/welcome')) {
    if (isDefaultWorkspace()) {
      openWelcome({ skipHash: true });
    } else {
      closeWelcome({ skipHash: true });
      window.location.hash = '#/';
    }
  }
}

/** Call before workspace sync on boot to avoid flashing the chat shell. */
export function markWelcomePendingIfNeeded(): void {
  const hash = window.location.hash;
  if (isOtherFullPageHash(hash)) {
    return;
  }
  if (hash === '' || hash === '#/' || hash === '#' || hash.startsWith('#/welcome')) {
    setWelcomePending(true);
  }
}

/** Test helper — paint the recents list into an existing `#welcomeRecentsList`. */
export async function renderWelcomeRecentsForTest(): Promise<void> {
  await renderRecentsList();
}

/** Test helper — reset session dismiss and wizard parent. */
export function resetWelcomeStateForTests(): void {
  wizardParentPath = '';
  createPanelOpen = false;
  gateSwitchMode = false;
}
