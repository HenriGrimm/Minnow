import {
  browseWorkspaceFolders,
  createWorkspaceSubfolder,
  type WorkspaceBrowseEntry,
} from '../config/workspace-api';
import {
  registerChromePopover,
  unregisterChromePopover,
} from './preview-electron-visibility';
import { createIcon, type IconName } from './icon';
import { normalizeWorkspacePath } from '../lib/normalize-workspace-path';
import {
  closeOpenWorkspace,
  readOpenWorkspaceWindows,
  type OpenWorkspaceMap,
} from '../lib/open-workspace-windows';

export interface WorkspaceFolderPickerResult {
  cancelled: boolean;
  path: string | null;
}

const OVERLAY_ID = 'workspaceFolderPickerOverlay';
const DIALOG_ID = 'workspaceFolderPicker';

const ICON_FOLDER: IconName = 'folder';
const ICON_CHEVRON: IconName = 'chevronRight';
const ICON_UP: IconName = 'arrowUp';
const ICON_FOLDER_PLUS: IconName = 'addFolder';
const ICON_CLOSE: IconName = 'close';

let overlayEl: HTMLDivElement | null = null;
let dialogEl: HTMLDivElement | null = null;
let breadcrumbsEl: HTMLOListElement | null = null;
let listEl: HTMLUListElement | null = null;
let upBtn: HTMLButtonElement | null = null;
let newFolderBtn: HTMLButtonElement | null = null;
let closeBtn: HTMLButtonElement | null = null;
let newFolderPanel: HTMLDivElement | null = null;
let newFolderInput: HTMLInputElement | null = null;
let newFolderCreateBtn: HTMLButtonElement | null = null;
let newFolderCancelBtn: HTMLButtonElement | null = null;
let errorEl: HTMLElement | null = null;
let openBtn: HTMLButtonElement | null = null;
let cancelBtn: HTMLButtonElement | null = null;
let emptyEl: HTMLElement | null = null;
let selectionPathEl: HTMLElement | null = null;
let selectionWrapEl: HTMLElement | null = null;
let creatingFolder = false;

let currentPath = '';
let currentParent: string | null = null;
/**
 * Folders that already have a window, refreshed on every listing. A folder
 * opens in exactly one view, so a row for one of these offers to close it
 * rather than pretending it can be opened again.
 */
let openWorkspaces: OpenWorkspaceMap = new Map();
let selectedEntryPath: string | null = null;
let resolvePicker: ((result: WorkspaceFolderPickerResult) => void) | null = null;
let escapeHandler: ((e: KeyboardEvent) => void) | null = null;
let previousFocus: HTMLElement | null = null;
let shellListenersBound = false;
let chromePopoverRegistered = false;

const DEFAULT_TITLE = 'Open workspace';
const DEFAULT_CONFIRM_VERB = 'Open';
/** Verb on the confirm button; "Open" for workspaces, "Choose" for a plain folder. */
let confirmVerb = DEFAULT_CONFIRM_VERB;
/**
 * False when the picker is choosing an ordinary folder (a backup destination,
 * say) rather than a workspace: open-window badges and their Close buttons
 * mean nothing there.
 */
let pickingWorkspace = true;

/** True while the inline "New folder" name field is visible. */
function isNewFolderPanelVisible(): boolean {
  return Boolean(newFolderPanel && !newFolderPanel.hidden);
}

/** Whether the workspace folder picker modal is open. */
export function isWorkspaceFolderPickerOpen(): boolean {
  return resolvePicker !== null;
}

/** Delay single-click selection so double-click can drill down first. */
const PICKER_CLICK_DELAY_MS = 220;

/** Build a Uicons icon matching global `.icon-svg` styling. */
function createIconSvg(name: IconName, className = 'icon-svg'): HTMLElement {
  return createIcon(name, { className });
}

function folderDisplayName(absPath: string): string {
  const normalized = absPath.replace(/\\/g, '/').replace(/\/+$/, '');
  const parts = normalized.split('/').filter(Boolean);
  const last = parts[parts.length - 1];
  if (last) {
    return last;
  }
  if (/^[A-Za-z]:$/.test(normalized)) {
    return `${normalized.toUpperCase()}\\`;
  }
  return absPath || 'Folder';
}

/** Split an absolute path into clickable breadcrumb segments. */
function pathToSegments(absPath: string): { label: string; path: string }[] {
  const trimmed = absPath.trim();
  if (!trimmed) {
    return [];
  }

  const isWin = /^[A-Za-z]:/.test(trimmed);
  const isAbsoluteUnix = !isWin && trimmed.startsWith('/');
  const sep = isWin ? '\\' : '/';
  const parts = trimmed.replace(/\\/g, '/').split('/').filter(Boolean);
  const segments: { label: string; path: string }[] = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (i === 0 && /^[A-Za-z]:$/.test(part)) {
      segments.push({ label: part, path: `${part}${sep}` });
      continue;
    }

    const prevPath = segments[i - 1]?.path ?? '';
    const path =
      i === 0
        ? isAbsoluteUnix
          ? `/${part}`
          : part
        : `${prevPath.replace(new RegExp(`${sep.replace('\\', '\\\\')}+$`), '')}${sep}${part}`;
    segments.push({ label: part, path });
  }

  return segments;
}

function clearRowSelection(): void {
  if (!listEl) {
    return;
  }
  for (const row of listEl.querySelectorAll('.workspace-picker__row')) {
    row.setAttribute('aria-selected', 'false');
  }
}

function updateSelectionDisplay(): void {
  if (!selectionPathEl || !selectionWrapEl || !openBtn) {
    return;
  }

  const chosen = selectedEntryPath ?? (currentPath.trim() || null);
  if (!chosen) {
    selectionWrapEl.hidden = true;
    openBtn.textContent = `${confirmVerb} folder`;
    return;
  }

  selectionWrapEl.hidden = false;
  selectionPathEl.textContent = chosen;
  selectionPathEl.title = chosen;
  openBtn.textContent = `${confirmVerb} ${folderDisplayName(chosen)}`;
}

function selectRow(path: string, btn: HTMLButtonElement): void {
  selectedEntryPath = path;
  clearRowSelection();
  btn.setAttribute('aria-selected', 'true');
  updateToolbar();
  updateSelectionDisplay();
}

/** Single click selects; double click drills without firing a late select. */
function wireRowActivation(
  btn: HTMLButtonElement,
  path: string,
  onDrill?: () => void,
): void {
  let clickTimer: ReturnType<typeof setTimeout> | null = null;

  btn.addEventListener('dblclick', (event) => {
    event.preventDefault();
    if (clickTimer) {
      clearTimeout(clickTimer);
      clickTimer = null;
    }
    if (onDrill) {
      onDrill();
    }
  });

  btn.addEventListener('click', () => {
    if (clickTimer) {
      clearTimeout(clickTimer);
    }
    clickTimer = setTimeout(() => {
      clickTimer = null;
      selectRow(path, btn);
    }, PICKER_CLICK_DELAY_MS);
  });
}

function createFolderIcon(): HTMLElement {
  return createIconSvg(ICON_FOLDER, 'icon-svg workspace-picker__folder-icon');
}

function createChildFolderRow(entry: WorkspaceBrowseEntry): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'workspace-picker__item';
  li.setAttribute('role', 'presentation');

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'workspace-picker__row';
  btn.setAttribute('role', 'option');
  btn.title = entry.path;

  const icon = createFolderIcon();
  const name = document.createElement('span');
  name.className = 'workspace-picker__name';
  name.textContent = entry.name;

  const chevron = createIconSvg(ICON_CHEVRON, 'icon-svg workspace-picker__chevron');
  chevron.setAttribute('aria-hidden', 'true');

  btn.appendChild(icon);
  btn.appendChild(name);
  btn.appendChild(chevron);
  wireRowActivation(btn, entry.path, () => {
    void loadListing(entry.path);
  });
  li.appendChild(btn);
  decorateOpenWorkspaceRow(li, btn, entry.path);
  return li;
}

/**
 * Flag a folder that already has a window and offer to close it. Opening it
 * again is not on the table — that is the one-view-per-folder rule — so the
 * useful action here is releasing the window that holds it.
 */
function decorateOpenWorkspaceRow(
  li: HTMLLIElement,
  btn: HTMLButtonElement,
  absPath: string,
): void {
  const openWindow = openWorkspaces.get(normalizeWorkspacePath(absPath));
  if (!openWindow) return;

  li.dataset.openInWindow = 'true';
  const backgrounded = openWindow.visible === false;
  if (backgrounded) li.dataset.workspaceBackgrounded = 'true';

  const badge = document.createElement('span');
  badge.className = 'workspace-picker__open-badge';
  badge.textContent = backgrounded ? 'Background' : 'Open';
  btn.insertBefore(badge, btn.querySelector('.workspace-picker__chevron'));
  btn.title = backgrounded
    ? `${absPath} — running in the background`
    : `${absPath} — already open in another window`;

  if (!window.minnow?.window?.closeWorkspace) return;
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'workspace-picker__close-workspace';
  closeBtn.textContent = 'Close';
  closeBtn.title = `Close the window on ${folderDisplayName(absPath)}`;
  closeBtn.setAttribute('aria-label', `Close the window on ${folderDisplayName(absPath)}`);
  closeBtn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    void (async () => {
      closeBtn.disabled = true;
      const result = await closeOpenWorkspace(absPath);
      if (!result.ok) {
        closeBtn.disabled = false;
        showPickerError(result.error);
        return;
      }
      await loadListing(currentPath);
    })();
  });
  li.appendChild(closeBtn);
}

function createQuickLocationRow(entry: WorkspaceBrowseEntry): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'workspace-picker__item workspace-picker__item--location';
  li.setAttribute('role', 'presentation');

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'workspace-picker__row workspace-picker__row--location';
  btn.setAttribute('role', 'option');
  btn.title = entry.path;

  const icon = createFolderIcon();
  const labelWrap = document.createElement('span');
  labelWrap.className = 'workspace-picker__label-wrap';

  const name = document.createElement('span');
  name.className = 'workspace-picker__name';
  name.textContent = entry.name;

  const meta = document.createElement('span');
  meta.className = 'workspace-picker__meta';
  meta.textContent = entry.path;

  labelWrap.appendChild(name);
  labelWrap.appendChild(meta);

  const chevron = createIconSvg(ICON_CHEVRON, 'icon-svg workspace-picker__chevron');
  chevron.setAttribute('aria-hidden', 'true');

  btn.appendChild(icon);
  btn.appendChild(labelWrap);
  btn.appendChild(chevron);
  wireRowActivation(btn, entry.path, () => {
    void loadListing(entry.path);
  });
  li.appendChild(btn);
  decorateOpenWorkspaceRow(li, btn, entry.path);
  return li;
}

function updateBreadcrumbs(): void {
  if (!breadcrumbsEl) {
    return;
  }

  breadcrumbsEl.innerHTML = '';

  if (!currentPath.trim()) {
    const item = document.createElement('li');
    item.className = 'workspace-picker__crumb workspace-picker__crumb--current';
    item.textContent = 'Quick locations';
    item.setAttribute('aria-current', 'location');
    breadcrumbsEl.appendChild(item);
    return;
  }

  const segments = pathToSegments(currentPath);
  for (let i = 0; i < segments.length; i++) {
    const { label, path } = segments[i];
    const item = document.createElement('li');
    item.className = 'workspace-picker__crumb';

    if (i === segments.length - 1) {
      item.classList.add('workspace-picker__crumb--current');
      item.textContent = label;
      item.setAttribute('aria-current', 'location');
    } else {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'workspace-picker__crumb-btn';
      btn.textContent = label;
      btn.title = path;
      btn.addEventListener('click', () => {
        void loadListing(path);
      });
      item.appendChild(btn);
    }

    breadcrumbsEl.appendChild(item);

    if (i < segments.length - 1) {
      const sep = document.createElement('li');
      sep.className = 'workspace-picker__crumb-sep';
      sep.setAttribute('aria-hidden', 'true');
      sep.appendChild(createIconSvg(ICON_CHEVRON, 'icon-svg workspace-picker__crumb-sep-icon'));
      breadcrumbsEl.appendChild(sep);
    }
  }
}

function bindShellRefs(root: HTMLDivElement): void {
  overlayEl = root;
  dialogEl = root.querySelector(`#${DIALOG_ID}`) as HTMLDivElement | null;
  breadcrumbsEl = root.querySelector('[data-ws-picker-breadcrumbs]');
  listEl = root.querySelector('[data-ws-picker-list]');
  upBtn = root.querySelector('[data-ws-picker-up]');
  newFolderBtn = root.querySelector('[data-ws-picker-new-folder]');
  closeBtn = root.querySelector('[data-ws-picker-close]');
  newFolderPanel = root.querySelector('[data-ws-picker-new-folder-panel]');
  newFolderInput = root.querySelector('[data-ws-picker-new-folder-input]');
  newFolderCreateBtn = root.querySelector('[data-ws-picker-new-folder-create]');
  newFolderCancelBtn = root.querySelector('[data-ws-picker-new-folder-cancel]');
  errorEl = root.querySelector('[data-ws-picker-error]');
  openBtn = root.querySelector('[data-ws-picker-open]');
  cancelBtn = root.querySelector('[data-ws-picker-cancel]');
  emptyEl = root.querySelector('[data-ws-picker-empty]');
  selectionPathEl = root.querySelector('[data-ws-picker-selection-path]');
  selectionWrapEl = root.querySelector('[data-ws-picker-selection]');
}

/** Defer focus until after the activating click finishes (Electron-safe). */
function focusNewFolderInput(): void {
  if (!newFolderInput) {
    return;
  }
  requestAnimationFrame(() => {
    if (!newFolderInput || !isNewFolderPanelVisible()) {
      return;
    }
    newFolderInput.focus();
    newFolderInput.select();
  });
}

function wireShellListeners(): void {
  if (shellListenersBound || !overlayEl) {
    return;
  }
  shellListenersBound = true;

  closeBtn?.appendChild(createIconSvg(ICON_CLOSE));
  upBtn?.appendChild(createIconSvg(ICON_UP));
  if (newFolderBtn && !newFolderBtn.querySelector('.icon-svg')) {
    newFolderBtn.appendChild(createIconSvg(ICON_FOLDER_PLUS));
  }

  overlayEl.addEventListener('click', (event) => {
    if (event.target === overlayEl) {
      finishPicker({ cancelled: true, path: null });
    }
  });

  const cancel = () => finishPicker({ cancelled: true, path: null });

  cancelBtn?.addEventListener('click', cancel);
  closeBtn?.addEventListener('click', cancel);

  openBtn?.addEventListener('click', () => {
    const chosen = selectedEntryPath ?? (currentPath.trim() || null);
    if (!chosen) {
      return;
    }
    finishPicker({ cancelled: false, path: chosen });
  });

  upBtn?.addEventListener('click', () => {
    hideNewFolderPanel();
    if (!currentParent) {
      void loadListing('');
      return;
    }
    void loadListing(currentParent);
  });

  newFolderBtn?.addEventListener('click', () => {
    showNewFolderPanel();
  });

  newFolderCancelBtn?.addEventListener('click', () => {
    hideNewFolderPanel();
  });

  newFolderCreateBtn?.addEventListener('click', () => {
    void submitNewFolder();
  });

  newFolderInput?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void submitNewFolder();
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      hideNewFolderPanel();
    }
  });

  for (const eventName of ['mousedown', 'click', 'dblclick'] as const) {
    newFolderInput?.addEventListener(eventName, (event) => {
      event.stopPropagation();
    });
  }

  dialogEl?.addEventListener('focusin', (event) => {
    if (!isNewFolderPanelVisible() || !newFolderInput) {
      return;
    }
    const target = event.target;
    if (target === newFolderInput) {
      return;
    }
    if (target instanceof HTMLElement && newFolderPanel?.contains(target)) {
      return;
    }
    focusNewFolderInput();
  });
}

function ensureShell(): void {
  if (overlayEl && dialogEl && shellListenersBound) {
    return;
  }

  const existing = document.getElementById(OVERLAY_ID);
  if (existing instanceof HTMLDivElement) {
    bindShellRefs(existing);
    wireShellListeners();
    return;
  }

  overlayEl = document.createElement('div');
  overlayEl.id = OVERLAY_ID;
  overlayEl.className = 'workspace-picker-overlay hidden';
  overlayEl.hidden = true;
  overlayEl.innerHTML = `
    <div
      id="${DIALOG_ID}"
      class="workspace-picker"
      role="dialog"
      aria-modal="true"
      aria-labelledby="workspaceFolderPickerTitle"
      tabindex="-1"
    >
      <header class="workspace-picker__header">
        <h2 id="workspaceFolderPickerTitle" class="workspace-picker__title">Open workspace</h2>
        <button
          type="button"
          class="icon-btn workspace-picker__close"
          data-ws-picker-close
          aria-label="Close"
        ></button>
      </header>

      <div class="workspace-picker__nav">
        <ol
          class="workspace-picker__breadcrumbs"
          data-ws-picker-breadcrumbs
          aria-label="Folder path"
        ></ol>
        <div class="workspace-picker__nav-actions">
          <button
            type="button"
            class="icon-btn workspace-picker__nav-btn"
            data-ws-picker-up
            aria-label="Go to parent folder"
            title="Up"
          ></button>
          <button
            type="button"
            class="icon-btn workspace-picker__nav-btn"
            data-ws-picker-new-folder
            aria-label="New folder"
            title="New folder"
          ></button>
        </div>
      </div>

      <div class="workspace-picker__new-folder-panel hidden" data-ws-picker-new-folder-panel hidden>
        <label class="workspace-picker__new-folder-label" for="workspacePickerNewFolderInput">
          Folder name
        </label>
        <div class="workspace-picker__new-folder-row">
          <input
            id="workspacePickerNewFolderInput"
            type="text"
            class="workspace-picker__new-folder-input"
            data-ws-picker-new-folder-input
            autocomplete="off"
            spellcheck="false"
            maxlength="255"
          />
          <button
            type="button"
            class="workspace-picker__btn workspace-picker__btn--primary workspace-picker__new-folder-create"
            data-ws-picker-new-folder-create
          >
            Create
          </button>
          <button
            type="button"
            class="workspace-picker__btn"
            data-ws-picker-new-folder-cancel
          >
            Cancel
          </button>
        </div>
      </div>

      <p class="workspace-picker__error hidden" data-ws-picker-error role="alert" hidden></p>

      <div class="workspace-picker__body">
        <ul class="workspace-picker__list" data-ws-picker-list role="listbox" aria-label="Folders"></ul>
        <p class="workspace-picker__empty hidden" data-ws-picker-empty hidden>No subfolders</p>
      </div>

      <footer class="workspace-picker__footer">
        <div class="workspace-picker__selection" data-ws-picker-selection hidden>
          <span class="workspace-picker__selection-label">Selected</span>
          <span class="workspace-picker__selection-path" data-ws-picker-selection-path></span>
        </div>
        <div class="workspace-picker__footer-actions">
          <button type="button" class="workspace-picker__btn" data-ws-picker-cancel>Cancel</button>
          <button type="button" class="workspace-picker__btn workspace-picker__btn--primary" data-ws-picker-open>
            Open folder
          </button>
        </div>
      </footer>
    </div>
  `;

  document.body.appendChild(overlayEl);
  bindShellRefs(overlayEl);
  wireShellListeners();
}

function clearPickerError(): void {
  if (!errorEl) {
    return;
  }
  errorEl.textContent = '';
  errorEl.hidden = true;
  errorEl.classList.add('hidden');
}

function showPickerError(message: string): void {
  if (!errorEl) {
    return;
  }
  errorEl.textContent = message;
  errorEl.hidden = false;
  errorEl.classList.remove('hidden');
}

function showNewFolderPanel(): void {
  if (!newFolderPanel || !newFolderInput || !currentPath.trim()) {
    return;
  }
  clearPickerError();
  newFolderPanel.hidden = false;
  newFolderPanel.classList.remove('hidden');
  newFolderInput.value = 'New folder';
  focusNewFolderInput();
}

function hideNewFolderPanel(): void {
  if (!newFolderPanel || !newFolderInput) {
    return;
  }
  newFolderPanel.hidden = true;
  newFolderPanel.classList.add('hidden');
  newFolderInput.value = '';
  clearPickerError();
}

async function submitNewFolder(): Promise<void> {
  if (creatingFolder || !newFolderInput || !currentPath.trim()) {
    return;
  }
  const name = newFolderInput.value.trim();
  if (!name) {
    showPickerError('Enter a folder name');
    newFolderInput.focus();
    return;
  }

  creatingFolder = true;
  if (newFolderCreateBtn) {
    newFolderCreateBtn.disabled = true;
  }
  clearPickerError();

  try {
    const created = await createWorkspaceSubfolder(currentPath, name);
    hideNewFolderPanel();
    await loadListing(currentPath);
    selectedEntryPath = created.path;
    if (listEl) {
      clearRowSelection();
      for (const row of listEl.querySelectorAll('.workspace-picker__row')) {
        if (row instanceof HTMLButtonElement && row.title === created.path) {
          row.setAttribute('aria-selected', 'true');
          break;
        }
      }
    }
    updateToolbar();
    updateSelectionDisplay();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    showPickerError(message);
    newFolderInput.focus();
  } finally {
    creatingFolder = false;
    if (newFolderCreateBtn) {
      newFolderCreateBtn.disabled = false;
    }
  }
}

function updateToolbar(): void {
  if (!upBtn || !openBtn) {
    return;
  }
  const atRoots = !currentPath.trim();
  upBtn.disabled = atRoots && currentParent === null;
  if (newFolderBtn) {
    newFolderBtn.disabled = atRoots || creatingFolder;
  }
  const canOpen = Boolean(currentPath.trim() || selectedEntryPath);
  openBtn.disabled = !canOpen;
}

function renderEntries(entries: WorkspaceBrowseEntry[]): void {
  if (!listEl || !emptyEl) {
    return;
  }
  listEl.innerHTML = '';

  const inDirectory = Boolean(currentPath.trim());
  const hasChildren = entries.length > 0;

  if (inDirectory) {
    selectedEntryPath = currentPath;
  } else {
    selectedEntryPath = null;
  }

  for (const entry of entries) {
    listEl.appendChild(
      inDirectory ? createChildFolderRow(entry) : createQuickLocationRow(entry),
    );
  }

  if (!inDirectory && !hasChildren) {
    emptyEl.textContent = 'No locations available';
    emptyEl.hidden = false;
    emptyEl.classList.remove('hidden');
    updateToolbar();
    updateSelectionDisplay();
    return;
  }

  if (inDirectory && !hasChildren) {
    emptyEl.textContent = 'No subfolders in this directory';
    emptyEl.hidden = false;
    emptyEl.classList.remove('hidden');
  } else {
    emptyEl.hidden = true;
    emptyEl.classList.add('hidden');
  }

  updateToolbar();
  updateSelectionDisplay();
}

async function loadListing(browsePath: string): Promise<void> {
  hideNewFolderPanel();
  const [listing, open] = await Promise.all([
    browseWorkspaceFolders(browsePath),
    pickingWorkspace ? readOpenWorkspaceWindows() : Promise.resolve(new Map() as OpenWorkspaceMap),
  ]);
  openWorkspaces = open;
  currentPath = listing.path ?? '';
  currentParent = listing.parent ?? null;
  selectedEntryPath = null;
  updateBreadcrumbs();
  renderEntries(listing.entries ?? []);
}

function detachEscape(): void {
  if (escapeHandler) {
    document.removeEventListener('keydown', escapeHandler, true);
    escapeHandler = null;
  }
}

function showOverlay(): void {
  if (!overlayEl || !dialogEl) {
    return;
  }
  registerChromePopover();
  chromePopoverRegistered = true;
  overlayEl.hidden = false;
  overlayEl.classList.remove('hidden');
  if (!isNewFolderPanelVisible()) {
    dialogEl.focus();
  } else {
    focusNewFolderInput();
  }
}

function hideOverlay(): void {
  if (!overlayEl) {
    return;
  }
  overlayEl.hidden = true;
  overlayEl.classList.add('hidden');
}

function finishPicker(result: WorkspaceFolderPickerResult): void {
  detachEscape();
  hideNewFolderPanel();
  hideOverlay();
  if (chromePopoverRegistered) {
    unregisterChromePopover();
    chromePopoverRegistered = false;
  }
  const resolve = resolvePicker;
  resolvePicker = null;
  previousFocus?.focus();
  previousFocus = null;
  resolve?.(result);
}

/**
 * Open the in-app folder browser. Resolves when the user picks a folder or cancels.
 *
 * `title` and `confirmVerb` reuse the browser for folders that are not
 * workspaces; giving a `title` also drops the open-window badges. `elevated`
 * lifts it above the setup wizard, which covers the normal overlay layer.
 */
export function openWorkspaceFolderPicker(options?: {
  initialPath?: string;
  title?: string;
  confirmVerb?: string;
  elevated?: boolean;
}): Promise<WorkspaceFolderPickerResult> {
  ensureShell();
  if (resolvePicker) {
    return Promise.resolve({ cancelled: true, path: null });
  }

  pickingWorkspace = !options?.title;
  confirmVerb = options?.confirmVerb?.trim() || DEFAULT_CONFIRM_VERB;
  const titleEl = document.getElementById('workspaceFolderPickerTitle');
  if (titleEl) titleEl.textContent = options?.title?.trim() || DEFAULT_TITLE;
  overlayEl?.classList.toggle('workspace-picker-overlay--elevated', options?.elevated === true);

  previousFocus =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;

  return new Promise((resolve) => {
    resolvePicker = resolve;
    const startPath = options?.initialPath?.trim() ?? '';
    void loadListing(startPath)
      .catch(() => loadListing(''))
      .then(() => {
        showOverlay();
      });

    escapeHandler = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }
      if (isNewFolderPanelVisible()) {
        event.preventDefault();
        event.stopPropagation();
        hideNewFolderPanel();
        return;
      }
      event.preventDefault();
      finishPicker({ cancelled: true, path: null });
    };
    document.addEventListener('keydown', escapeHandler, true);
  });
}

/** Test helper — reset module singletons. */
export function resetWorkspaceFolderPickerForTests(): void {
  finishPicker({ cancelled: true, path: null });
  document.getElementById(OVERLAY_ID)?.remove();
  overlayEl = null;
  dialogEl = null;
  breadcrumbsEl = null;
  listEl = null;
  shellListenersBound = false;
  openWorkspaces = new Map();
}
