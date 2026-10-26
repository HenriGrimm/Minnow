import {
  fetchWorkspace,
  removeRecentWorkspace,
  type WorkspaceRecentItem,
} from '../config/workspace-api';
import { getWorkspaceRecentItems, setWorkspaceFromServer } from '../state/workspace';
import { normalizeWorkspacePath } from '../lib/normalize-workspace-path';
import {
  closeOpenWorkspace,
  readOpenWorkspaceWindows,
  type OpenWorkspaceMap,
} from '../lib/open-workspace-windows';
import { markPreviewOccluder, unmarkPreviewOccluder } from './preview-occlusion';
export type WorkspaceMenuStatusState = 'ok' | 'err' | 'spin';

/** Injectable deps so tests avoid importing tools/config or status chains. */
export interface WorkspaceMenuDeps {
  isServerAvailable: () => boolean;
  reportStatus: (state: WorkspaceMenuStatusState, msg: string) => void;
}

let menuDeps: WorkspaceMenuDeps = {
  isServerAvailable: () => false,
  reportStatus: () => {},
};

/** Wire server detection and status from workspace-button at init. */
export function setWorkspaceMenuDeps(partial: Partial<WorkspaceMenuDeps>): void {
  menuDeps = { ...menuDeps, ...partial };
}

let menuEl: HTMLUListElement | null = null;
let anchorBtn: HTMLButtonElement | null = null;
let menuOpen = false;
let outsidePointerHandler: ((e: PointerEvent) => void) | null = null;
let escapeHandler: ((e: KeyboardEvent) => void) | null = null;

export type WorkspaceSelectHandler = (absPath: string) => Promise<void>;
export type OpenNewWorkspaceHandler = () => Promise<void>;

let onSelectWorkspace: WorkspaceSelectHandler | null = null;
let onOpenNew: OpenNewWorkspaceHandler | null = null;

/**
 * Folders that already have a window, normalized. Only Electron can hold more
 * than one view; elsewhere this is always empty and the per-row action is
 * omitted entirely.
 */
let openWorkspaces: OpenWorkspaceMap = new Map();

async function refreshOpenWorkspaces(): Promise<void> {
  openWorkspaces = await readOpenWorkspaceWindows();
}

/** Close the window holding a folder, then repaint the menu. */
async function closeOpenWorkspaceRow(item: WorkspaceRecentItem): Promise<void> {
  const result = await closeOpenWorkspace(item.path);
  if (!result.ok) {
    menuDeps.reportStatus('err', result.error);
    return;
  }
  menuDeps.reportStatus(
    'ok',
    result.closed ? `Closed ${item.label}` : `${item.label} was not open`,
  );
  await renderMenuList();
}

/**
 * Open a folder in its own window, or focus the window that already has it —
 * a folder opens in exactly one view.
 */
async function openRecentInNewWindow(item: WorkspaceRecentItem): Promise<void> {
  const openWorkspace = window.minnow?.window?.openWorkspace;
  if (!openWorkspace) return;
  closeWorkspaceMenu();
  const result = await openWorkspace(item.path);
  if (!result.ok) {
    menuDeps.reportStatus('err', result.error);
    return;
  }
  menuDeps.reportStatus(
    'ok',
    result.focused ? `Focused the window on ${item.label}` : `Opened ${item.label} in a new window`,
  );
}

/** Wire callbacks from workspace-button (shared post-switch refresh). */
export function configureWorkspaceRecentMenu(handlers: {
  onSelectWorkspace: WorkspaceSelectHandler;
  onOpenNew: OpenNewWorkspaceHandler;
}): void {
  onSelectWorkspace = handlers.onSelectWorkspace;
  onOpenNew = handlers.onOpenNew;
}

function ensureMenu(): HTMLUListElement {
  if (menuEl) return menuEl;

  menuEl = document.createElement('ul');
  menuEl.id = 'workspaceMenu';
  menuEl.className = 'workspace-menu hidden';
  menuEl.setAttribute('role', 'menu');
  document.body.appendChild(menuEl);
  return menuEl;
}

/** Position the menu below the anchor, right-aligned so it opens left (top-right control). */
function positionMenu(btn: HTMLButtonElement, menu: HTMLElement): void {
  const rect = btn.getBoundingClientRect();
  const margin = 8;
  menu.style.top = `${rect.bottom + 4}px`;
  menu.style.right = 'auto';

  const menuWidth = menu.offsetWidth || menu.getBoundingClientRect().width;
  let left = rect.right - menuWidth;
  left = Math.max(margin, Math.min(left, window.innerWidth - menuWidth - margin));
  menu.style.left = `${left}px`;
}

function setAnchorExpanded(expanded: boolean): void {
  if (!anchorBtn) return;
  anchorBtn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
}

function detachGlobalListeners(): void {
  if (outsidePointerHandler) {
    document.removeEventListener('pointerdown', outsidePointerHandler, true);
    outsidePointerHandler = null;
  }
  if (escapeHandler) {
    document.removeEventListener('keydown', escapeHandler, true);
    escapeHandler = null;
  }
}

/** Close the popover and clear listeners. */
export function closeWorkspaceMenu(): void {
  if (!menuOpen) return;
  menuOpen = false;
  if (menuEl) unmarkPreviewOccluder(menuEl);
  detachGlobalListeners();
  if (menuEl) menuEl.classList.add('hidden');
  setAnchorExpanded(false);
}

/** Whether the recent workspaces menu is open. */
export function isWorkspaceMenuOpen(): boolean {
  return menuOpen;
}

function attachGlobalListeners(): void {
  outsidePointerHandler = (e: PointerEvent) => {
    const target = e.target as Node | null;
    if (!menuEl || !anchorBtn) return;
    // The folder-name label toggles the menu too; let its click close it instead.
    const control = anchorBtn.closest('.workspace-control') ?? anchorBtn;
    if (menuEl.contains(target) || control.contains(target)) return;
    closeWorkspaceMenu();
  };
  document.addEventListener('pointerdown', outsidePointerHandler, true);

  escapeHandler = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    closeWorkspaceMenu();
  };
  document.addEventListener('keydown', escapeHandler, true);
}

function createRecentRow(item: WorkspaceRecentItem): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'workspace-menu__item';
  li.setAttribute('role', 'menuitem');
  if (!item.exists) {
    li.classList.add('workspace-menu__item--disabled');
    li.setAttribute('aria-disabled', 'true');
  }
  if (item.isCurrent) {
    li.setAttribute('aria-current', 'true');
  }

  const check = document.createElement('span');
  check.className = 'workspace-menu__check';
  check.textContent = item.isCurrent ? '✓' : '';
  check.setAttribute('aria-hidden', 'true');

  const label = document.createElement('span');
  label.className = 'workspace-menu__label';
  label.textContent = item.label;

  const pathLine = document.createElement('span');
  pathLine.className = 'workspace-menu__path';
  pathLine.textContent = item.path;
  li.title = item.path;

  li.appendChild(check);
  li.appendChild(label);
  li.appendChild(pathLine);

  const openWindow = openWorkspaces.get(normalizeWorkspacePath(item.path));
  const alreadyOpen = Boolean(openWindow);
  const backgrounded = openWindow?.visible === false;
  if (alreadyOpen) {
    li.dataset.openInWindow = 'true';
    if (backgrounded) li.dataset.workspaceBackgrounded = 'true';
    li.title = backgrounded
      ? `${item.path} — running in the background`
      : `${item.path} — already open in another window`;
    const badge = document.createElement('span');
    badge.className = 'workspace-menu__open-badge';
    badge.textContent = backgrounded ? 'Background' : 'Open';
    li.appendChild(badge);
  }

  if (!item.exists) {
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'workspace-menu__remove';
    removeBtn.setAttribute('aria-label', `Remove ${item.label} from recent workspaces`);
    removeBtn.textContent = '×';
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      void (async () => {
        try {
          await removeRecentWorkspace(item.path);
          await renderMenuList();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          menuDeps.reportStatus('err', message);
        }
      })();
    });
    li.appendChild(removeBtn);

    li.addEventListener('click', () => {
      menuDeps.reportStatus('err', 'Workspace folder no longer exists');
    });
    return li;
  }

  // Nothing to offer on the row for this window's own folder.
  if (window.minnow?.window?.openWorkspace && !item.isCurrent) {
    const newWindowBtn = document.createElement('button');
    newWindowBtn.type = 'button';
    newWindowBtn.className = 'workspace-menu__new-window';
    newWindowBtn.textContent = alreadyOpen ? '→' : '⧉';
    const action = alreadyOpen
      ? `Focus the window already on ${item.label}`
      : `Open ${item.label} in a new window`;
    newWindowBtn.title = action;
    newWindowBtn.setAttribute('aria-label', action);
    newWindowBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      void openRecentInNewWindow(item);
    });
    li.appendChild(newWindowBtn);
  }

  // A window can only be released from outside itself, so the row that reports
  // a folder as open is also the place that closes it.
  if (alreadyOpen && !item.isCurrent && window.minnow?.window?.closeWorkspace) {
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'workspace-menu__close-workspace';
    closeBtn.textContent = '×';
    const closeLabel = `Close the window on ${item.label}`;
    closeBtn.title = closeLabel;
    closeBtn.setAttribute('aria-label', closeLabel);
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      void closeOpenWorkspaceRow(item);
    });
    li.appendChild(closeBtn);
  }

  li.addEventListener('click', () => {
    if (item.isCurrent) {
      closeWorkspaceMenu();
      return;
    }
    // A folder open elsewhere is focused, never switched into this window —
    // two views on one folder would fight over the same sessions.db rows.
    if (alreadyOpen) {
      void openRecentInNewWindow(item);
      return;
    }
    void selectRecentWorkspace(item.path);
  });

  return li;
}

async function selectRecentWorkspace(absPath: string): Promise<void> {
  closeWorkspaceMenu();
  if (!onSelectWorkspace) return;
  menuDeps.reportStatus('spin', 'Switching workspace…');
  try {
    await onSelectWorkspace(absPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    menuDeps.reportStatus('err', message);
  }
}

/** Paint MRU rows plus footer actions into the menu element. */
function paintWorkspaceMenuList(menu: HTMLUListElement, recent: WorkspaceRecentItem[]): void {
  menu.innerHTML = '';

  for (const item of recent) {
    menu.appendChild(createRecentRow(item));
  }

  const divider = document.createElement('li');
  divider.className = 'workspace-menu__divider';
  divider.setAttribute('role', 'separator');
  menu.appendChild(divider);

  const openLi = document.createElement('li');
  openLi.setAttribute('role', 'none');
  const openBtn = document.createElement('button');
  openBtn.type = 'button';
  openBtn.className = 'workspace-menu__action';
  openBtn.setAttribute('role', 'menuitem');
  openBtn.textContent = 'Open new workspace…';
  openBtn.addEventListener('click', () => {
    closeWorkspaceMenu();
    void onOpenNew?.();
  });
  openLi.appendChild(openBtn);
  menu.appendChild(openLi);

  const newWindow = window.minnow?.window?.newWindow;
  if (!newWindow) return;
  const newWindowLi = document.createElement('li');
  newWindowLi.setAttribute('role', 'none');
  const newWindowBtn = document.createElement('button');
  newWindowBtn.type = 'button';
  newWindowBtn.className = 'workspace-menu__action';
  newWindowBtn.setAttribute('role', 'menuitem');
  newWindowBtn.textContent = 'New window';
  newWindowBtn.addEventListener('click', () => {
    closeWorkspaceMenu();
    void (async () => {
      const result = await newWindow();
      if (!result.ok) menuDeps.reportStatus('err', result.error);
    })();
  });
  newWindowLi.appendChild(newWindowBtn);
  menu.appendChild(newWindowLi);
}

/** Re-fetch workspace and paint MRU rows. */
export async function renderMenuList(): Promise<void> {
  const menu = ensureMenu();
  const cached = getWorkspaceRecentItems();
  if (cached.length > 0) {
    paintWorkspaceMenuList(menu, [...cached]);
  }

  await refreshOpenWorkspaces();
  const info = await fetchWorkspace();
  if (info) {
    setWorkspaceFromServer(info);
  }
  const recent = info?.recent ?? [...cached];
  paintWorkspaceMenuList(menu, [...recent]);
}

/** Open or close the menu for tests and the top bar button. */
export async function toggleWorkspaceMenu(btn: HTMLButtonElement): Promise<void> {
  if (!menuDeps.isServerAvailable()) {
    menuDeps.reportStatus('err', 'Workspace requires Minnow running locally');
    return;
  }

  if (menuOpen) {
    closeWorkspaceMenu();
    return;
  }

  anchorBtn = btn;
  const menu = ensureMenu();
  const cached = getWorkspaceRecentItems();
  if (cached.length > 0) {
    paintWorkspaceMenuList(menu, [...cached]);
    menu.classList.remove('hidden');
    positionMenu(btn, menu);
    menuOpen = true;
    markPreviewOccluder(menu, 'menu');
    setAnchorExpanded(true);
    attachGlobalListeners();
    void renderMenuList();
    return;
  }

  await renderMenuList();
  menu.classList.remove('hidden');
  positionMenu(btn, menu);
  menuOpen = true;
  markPreviewOccluder(menu, 'menu');
  setAnchorExpanded(true);
  attachGlobalListeners();
}

/** Test helper — render list into menu without opening. */
export async function renderWorkspaceMenuForTest(container?: HTMLElement): Promise<void> {
  if (container) {
    menuEl = container as HTMLUListElement;
    menuEl.className = 'workspace-menu';
    menuEl.setAttribute('role', 'menu');
  }
  await renderMenuList();
}

/** Reset module singletons between workspace menu tests. */
export function resetWorkspaceMenuForTests(): void {
  openWorkspaces = new Map();
  closeWorkspaceMenu();
  detachGlobalListeners();
  menuEl = null;
  anchorBtn = null;
  menuOpen = false;
  outsidePointerHandler = null;
  escapeHandler = null;
}
