import { isFileTreeServerAvailable } from './file-tree-server';
import { getFileTreeClipboard } from './file-tree-clipboard';
import { pasteTargetDirForPath } from './file-tree-path';
import { selectionForRow, type FileTreeSelectionEntry } from './file-tree-selection';
import { isMarkdownFilePath } from './file-markdown-path';
import { isExecutableOrchestratePlan } from '../chat/plans/plan-path';
import * as fileTreeOps from './file-tree-ops';
import { revealPathInSystemExplorer } from './reveal-in-system-explorer';
import { CAPTURE_MENU_KINDS, legacyCaptureMenuItems } from './issue-capture';
type FileTreeEntryKind = 'file' | 'dir';

export interface FileTreeMenuContext {
  path: string;
  kind: FileTreeEntryKind;
  /** Directory used for New file/folder and Paste (folder path or parent of file). */
  targetDir: string;
}

let menuEl: HTMLDivElement | null = null;
let dismissBound = false;

// ── Shell ────────────────────────────────────────────────────────────────────

function ensureMenuElement(): HTMLDivElement {
  if (menuEl) return menuEl;
  menuEl = document.createElement('div');
  menuEl.className = 'file-tree-context-menu';
  menuEl.setAttribute('role', 'menu');
  menuEl.hidden = true;
  document.body.appendChild(menuEl);
  return menuEl;
}

export function hideFileTreeContextMenu(): void {
  if (menuEl) menuEl.hidden = true;
}

function bindDismissOnce(): void {
  if (dismissBound) return;
  dismissBound = true;
  document.addEventListener('click', () => hideFileTreeContextMenu());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideFileTreeContextMenu();
  });
  const host = document.getElementById('fileTreeHost');
  if (host) {
    host.addEventListener('scroll', () => hideFileTreeContextMenu(), { passive: true });
  }
}

export interface FilePanelContextMenuItem {
  label: string;
  action?: () => void;
  disabled?: boolean;
  title?: string;
}

type MenuItemDef = FilePanelContextMenuItem;

// ── Items ────────────────────────────────────────────────────────────────────

/** Copy workspace-relative path to the system clipboard (files and folders). */
function buildCopyPathItem(path: string): MenuItemDef {
  return {
    label: 'Copy path',
    action: () => void fileTreeOps.copyWorkspacePathStringToClipboard(path),
  };
}

/** Shared “open in OS explorer” item for file and folder rows. */
function buildOpenInSystemExplorerItem(path: string, offline: boolean): MenuItemDef {
  return {
    label: 'Open in System Explorer',
    disabled: offline,
    title: offline ? 'Open Minnow to use this action' : undefined,
    action: () => void revealPathInSystemExplorer(path),
  };
}

/**
 * Cut / Copy / Paste / Rename / Delete for one row, retargeted at the whole tree
 * selection when that row is part of it. The labels carry the count so a batch is
 * never a surprise, and rename stays single-item because there is one name field.
 */
function buildEditItems(
  ctx: FileTreeMenuContext,
  offline: boolean,
  hasClipboard: boolean,
): MenuItemDef[] {
  const selection: FileTreeSelectionEntry[] = selectionForRow(ctx.path, ctx.kind);
  const paths = selection.map((entry) => entry.path);
  const filePaths = selection
    .filter((entry) => entry.kind === 'file')
    .map((entry) => entry.path);
  const many = selection.length > 1;
  const count = `${selection.length} items`;
  const pasteDisabled = offline || !hasClipboard;

  return [
    {
      label: many ? `Cut ${count}` : 'Cut',
      disabled: offline,
      action: () => fileTreeOps.cutPathsToClipboard(paths),
    },
    {
      label: many && filePaths.length > 0 ? `Copy ${filePaths.length} files` : 'Copy',
      disabled: offline || filePaths.length === 0,
      title: filePaths.length === 0 ? 'Copy is only available for files' : undefined,
      action: () => fileTreeOps.copyPathsToClipboard(filePaths),
    },
    {
      label: 'Paste',
      disabled: pasteDisabled,
      title: pasteDisabled && !hasClipboard ? 'Copy or cut a file first' : undefined,
      action: () => void fileTreeOps.pasteInto(ctx.targetDir),
    },
    {
      label: 'Rename…',
      disabled: offline || many,
      title: many ? 'Rename one item at a time' : undefined,
      action: () => void fileTreeOps.renamePath(ctx.path, ctx.kind),
    },
    {
      label: many ? `Delete ${count}` : 'Delete',
      disabled: offline,
      action: () => void fileTreeOps.deletePaths(selection),
    },
  ];
}

function renderMenuItems(items: MenuItemDef[]): void {
  const menu = ensureMenuElement();
  menu.innerHTML = '';
  for (const item of items) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'file-tree-context-menu__item';
    btn.setAttribute('role', 'menuitem');
    btn.textContent = item.label;
    if (item.disabled) {
      btn.disabled = true;
      btn.classList.add('file-tree-context-menu__item--disabled');
      if (item.title) btn.title = item.title;
    } else if (item.action) {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        hideFileTreeContextMenu();
        item.action!();
      });
    }
    menu.appendChild(btn);
  }
}

function positionMenu(clientX: number, clientY: number): void {
  const menu = ensureMenuElement();
  menu.hidden = false;
  const margin = 8;
  const rect = menu.getBoundingClientRect();
  let left = clientX;
  let top = clientY;
  if (left + rect.width > window.innerWidth - margin) {
    left = Math.max(margin, window.innerWidth - rect.width - margin);
  }
  if (top + rect.height > window.innerHeight - margin) {
    top = Math.max(margin, window.innerHeight - rect.height - margin);
  }
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function serverCrudEnabled(): boolean {
  return isFileTreeServerAvailable();
}

/** Build context-menu items for a file row (exported for tests). */
export function buildFileMenuItems(ctx: FileTreeMenuContext): MenuItemDef[] {
  const hasClipboard = Boolean(getFileTreeClipboard()?.paths.length);
  const offline = !serverCrudEnabled();
  const isMarkdown = isMarkdownFilePath(ctx.path);
  const isHtml = ctx.kind === 'file' && /\.html?$/i.test(ctx.path);
  const isPlan = ctx.kind === 'file' && isExecutableOrchestratePlan(ctx.path);

  const openItems: MenuItemDef[] = isMarkdown
    ? [
        {
          label: 'Open',
          disabled: offline,
          action: () =>
            void import('./file-viewer').then((m) => m.openFileInViewer(ctx.path)),
        },
        {
          label: 'Open as code',
          disabled: offline,
          action: () =>
            void import('./file-viewer').then((m) =>
              m.openFileInViewer(ctx.path, { asCode: true }),
            ),
        },
      ]
    : [
        {
          label: 'Open',
          disabled: offline,
          action: () =>
            void import('./file-viewer').then((m) => m.openFileInViewer(ctx.path)),
        },
      ];

  const previewItem: MenuItemDef[] = isHtml
    ? [
        {
          label: 'Open in preview',
          disabled: offline,
          action: () =>
            void import('./preview-panel').then((m) => m.openWorkspacePathInPreview(ctx.path)),
        },
      ]
    : [];

  const orchestrateItem: MenuItemDef[] = isPlan
    ? [
        {
          label: 'Open in orchestrator',
          disabled: offline,
          action: () =>
            void import('./orchestrate-launch').then((m) => m.launchBoardFromPlan(ctx.path)),
        },
      ]
    : [];

  return [
    ...openItems,
    ...previewItem,
    ...orchestrateItem,
    ...legacyCaptureMenuItems({ kind: CAPTURE_MENU_KINDS.file, path: ctx.path }),
    buildOpenInSystemExplorerItem(ctx.path, offline),
    buildCopyPathItem(ctx.path),
    ...buildEditItems(ctx, offline, hasClipboard),
  ];
}

/** Build context-menu items for a folder row (exported for tests). */
export function buildFolderMenuItems(ctx: FileTreeMenuContext): MenuItemDef[] {
  const hasClipboard = Boolean(getFileTreeClipboard()?.paths.length);
  const offline = !serverCrudEnabled();
  const disabled = offline;

  return [
    {
      label: 'New File…',
      disabled,
      action: () => fileTreeOps.createFileInDir(ctx.targetDir),
    },
    {
      label: 'New Folder…',
      disabled,
      action: () => fileTreeOps.createFolderInDir(ctx.targetDir),
    },
    buildOpenInSystemExplorerItem(ctx.path, offline),
    buildCopyPathItem(ctx.path),
    ...buildEditItems(ctx, offline, hasClipboard),
  ];
}

function buildBackgroundMenuItems(targetDir: string): MenuItemDef[] {
  const offline = !serverCrudEnabled();
  return [
    {
      label: 'New File…',
      disabled: offline,
      action: () => fileTreeOps.createFileInDir(targetDir),
    },
    {
      label: 'New Folder…',
      disabled: offline,
      action: () => fileTreeOps.createFolderInDir(targetDir),
    },
  ];
}

// ── Show ─────────────────────────────────────────────────────────────────────

/** Show a file-panel context menu at viewport coordinates (tree or viewer). */
export function showFilePanelContextMenu(
  items: FilePanelContextMenuItem[],
  clientX: number,
  clientY: number,
): void {
  bindDismissOnce();
  renderMenuItems(items);
  positionMenu(clientX, clientY);
}

/** Show context menu for a file or folder row. */
export function showFileTreeRowContextMenu(
  ctx: FileTreeMenuContext,
  clientX: number,
  clientY: number,
): void {
  bindDismissOnce();
  const items =
    ctx.kind === 'file' ? buildFileMenuItems(ctx) : buildFolderMenuItems(ctx);
  renderMenuItems(items);
  positionMenu(clientX, clientY);
}

/** Show context menu on empty tree background (new file/folder at root). */
export function showFileTreeBackgroundContextMenu(
  targetDir: string,
  clientX: number,
  clientY: number,
): void {
  if (!serverCrudEnabled()) return;
  bindDismissOnce();
  renderMenuItems(buildBackgroundMenuItems(targetDir));
  positionMenu(clientX, clientY);
}

/** Build menu context from row path and kind. */
export function buildMenuContext(path: string, kind: FileTreeEntryKind): FileTreeMenuContext {
  return {
    path,
    kind,
    targetDir: pasteTargetDirForPath(path, kind),
  };
}
