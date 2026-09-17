import { WORKSPACE_FILE_MIME } from '../attachments/workspace-ref';
import {
  beginCaptureDrag,
  capturePayloadFromDataTransfer,
  endCaptureDrag,
} from './capture-drag';
import { startNativeWorkspaceDrag } from '../attachments/native-file-drag';
import { parseListDirectoryResult, type ParsedListing } from '../lib/list-directory-parse';
import {
  invalidateCachedDirectoryListings,
  invalidateCachedDirectoryListingsForCurrentWorkspace,
} from '../tools/result-cache';
import { getFilePanelState, patchFilePanelState } from '../state/file-panel';
import { getWorkspacePath } from '../state/workspace';
import {
  buildFileTreeToolContext,
  fileTreeListingRootsEqual,
  getFileTreeListingWorkspaceRoot,
  getFileTreeSidebarTitleSuffix,
  resolveFileTreeListingRoot,
  setFileTreeListingWorkspaceRoot,
} from './file-tree-listing-root';
import { isFileTreeServerAvailable } from './file-tree-server';
import {
  basenameOf,
  ensureWorkspaceIndex,
  filterPaths,
  getFilterQuery,
  invalidateFileTreeIndex,
  sortFilteredPaths,
} from './file-tree-filter';
import {
  joinTreePath,
  normalizeTreePath,
} from './file-tree-path';
import {
  buildMenuContext,
  hideFileTreeContextMenu,
  showFileTreeBackgroundContextMenu,
  showFileTreeRowContextMenu,
} from './file-tree-context-menu';
import { getFileTreeClipboard } from './file-tree-clipboard';
import { pasteTargetDirForPath } from './file-tree-path';
type FileTreeEntryKind = 'file' | 'dir';
import {
  dirRowPaddingLeftPx,
  FILE_TREE_DIR_BASE_PADDING_PX,
  fileRowPaddingLeftPx,
} from './file-tree-indent';
import { isFileViewerEditorFocused } from './file-viewer-focus';
import {
  createFileTypeIconElement,
  createFolderTypeIconElement,
} from './file-type-icons';
import * as fileTreeOps from './file-tree-ops';

export {
  FILE_TREE_DEPTH_INDENT_PX,
  FILE_TREE_DIR_BASE_PADDING_PX,
  FILE_TREE_FILE_BASE_PADDING_PX,
} from './file-tree-indent';

const listingCache = new Map<string, ParsedListing>();
const loadingDirs = new Set<string>();

/**
 * Root refreshes currently in flight. `renderFileTree` paints "Loading project…"
 * whenever the root listing is missing, so a render that lands after the last
 * refresh finished used to leave that placeholder up for good — the tree looked
 * permanently stuck while the sibling window rendered fine. Anything above zero
 * means a refresh is still coming; zero means nobody is going to fill the cache
 * unless this render asks for it.
 */
let rootRefreshesInFlight = 0;

/** Git status letters keyed by repo-relative path (MIN-198 file tree badges). */
let gitStatusMap = new Map<string, string>();
let gitStatusPollTimer: ReturnType<typeof setTimeout> | undefined;
let gitStatusPollCwd: string | undefined;
let gitStatusPollDebounce: ReturnType<typeof setTimeout> | undefined;
let gitStatusPollInFlight = false;

// ── Git status ───────────────────────────────────────────────────────────────

/** Update git badge map; patch visible rows in place when possible. */
export function setFileTreeGitStatus(map: Map<string, string>): void {
  const prev = gitStatusMap;
  gitStatusMap = map;

  const changed = new Set<string>();
  for (const [path, status] of map) {
    if (prev.get(path) !== status) changed.add(path);
  }
  for (const path of prev.keys()) {
    if (!map.has(path)) changed.add(path);
  }
  if (changed.size === 0) return;

  let needsFullRender = false;
  for (const path of changed) {
    const row = document.querySelector<HTMLElement>(
      `[data-path="${CSS.escape(path)}"]`,
    );
    if (!row) {
      needsFullRender = true;
      break;
    }
    patchGitBadgeOnRow(row, path);
  }

  if (needsFullRender) {
    renderFileTree();
  }
}

/** Git poll timers must not block `node --test` process exit (happy-dom uses Node timers). */
function unrefPollTimerIfSupported(timer: ReturnType<typeof setTimeout> | null | undefined): void {
  if (timer != null && typeof timer === 'object' && 'unref' in timer) {
    (timer as { unref: () => void }).unref();
  }
}

/** Poll git status every 5s and refresh file tree badges. */
export function startFileTreeGitStatusPoll(cwd?: string): void {
  if (typeof window === 'undefined') return;
  const normalizedCwd = cwd?.trim() || undefined;
  if (normalizedCwd === gitStatusPollCwd && gitStatusPollTimer !== undefined) {
    return;
  }
  gitStatusPollCwd = normalizedCwd;
  if (gitStatusPollTimer !== undefined) {
    clearInterval(gitStatusPollTimer);
  }
  if (gitStatusPollDebounce !== undefined) {
    clearTimeout(gitStatusPollDebounce);
  }
  gitStatusPollDebounce = setTimeout(() => {
    gitStatusPollDebounce = undefined;
    void pollFileTreeGitStatus();
  }, 200);
  unrefPollTimerIfSupported(gitStatusPollDebounce);
  gitStatusPollTimer = setInterval(() => {
    void pollFileTreeGitStatus();
  }, 5000);
  unrefPollTimerIfSupported(gitStatusPollTimer);
}

/** Stop git status polling (tests — open interval blocks node --test between files). */
export function stopFileTreeGitStatusPollForTests(): void {
  if (gitStatusPollDebounce !== undefined) {
    clearTimeout(gitStatusPollDebounce);
    gitStatusPollDebounce = undefined;
  }
  if (gitStatusPollTimer !== undefined) {
    clearInterval(gitStatusPollTimer);
    gitStatusPollTimer = undefined;
  }
  gitStatusPollCwd = undefined;
  gitStatusPollInFlight = false;
}

async function pollFileTreeGitStatus(): Promise<void> {
  if (gitStatusPollInFlight) return;
  gitStatusPollInFlight = true;
  try {
    const { gitStatus } = await import('../state/git-api');
    const { getWorkspacePath } = await import('../state/workspace');
    const ws = getWorkspacePath().trim();
    const cwdArg =
      gitStatusPollCwd && ws && gitStatusPollCwd.replace(/\\/g, '/') !== ws.replace(/\\/g, '/')
        ? gitStatusPollCwd
        : undefined;

    const result = await gitStatus(cwdArg);
    if (!result.ok) {
      setFileTreeGitStatus(new Map());
      if (!isFileTreeServerAvailable() && gitStatusPollTimer !== undefined) {
        clearInterval(gitStatusPollTimer);
        gitStatusPollTimer = undefined;
      }
      return;
    }

    const map = new Map<string, string>();
    for (const bucket of [result.staged, result.unstaged, result.untracked]) {
      for (const entry of bucket ?? []) {
        map.set(entry.path.replace(/\\/g, '/'), entry.status);
      }
    }
    setFileTreeGitStatus(map);
  } catch {
  } finally {
    gitStatusPollInFlight = false;
  }
}

function appendGitBadge(row: HTMLElement, fullPath: string): void {
  const status = gitStatusMap.get(fullPath.replace(/\\/g, '/'));
  if (!status) return;

  const badge = document.createElement('span');
  badge.className = `file-tree-git-badge file-tree-git-badge--${status === '?' ? 'untracked' : 'changed'}`;
  badge.textContent = status === '?' ? '?' : status.slice(0, 1).toUpperCase();
  badge.title = `Git: ${status}`;
  row.appendChild(badge);
}

/** Replace or remove the git badge on one rendered file row. */
function patchGitBadgeOnRow(row: HTMLElement, fullPath: string): void {
  row.querySelector('.file-tree-git-badge')?.remove();
  appendGitBadge(row, fullPath);
}

let crudBound = false;
let focusedTreePath: string | null = null;
let focusedTreeKind: FileTreeEntryKind | null = null;

// ── Cache ────────────────────────────────────────────────────────────────────

function isExpanded(path: string): boolean {
  return getFilePanelState().expandedDirs.includes(path);
}

export {
  buildFileTreeToolContext,
  getFileTreeListingWorkspaceRoot,
  getFileTreeSidebarTitleSuffix,
} from './file-tree-listing-root';

async function fetchListing(relativePath: string): Promise<ParsedListing | { error: string }> {
  const cached = listingCache.get(relativePath);
  if (cached) return cached;

  const { executeTool } = await import('../tools/client');
  const raw = (
    await executeTool('list_directory', { path: relativePath }, buildFileTreeToolContext())
  ).content;
  const parsed = parseListDirectoryResult(raw);
  if ('error' in parsed) {
    return parsed;
  }
  listingCache.set(relativePath, parsed);
  return parsed;
}

function setExpanded(path: string, open: boolean): void {
  const state = getFilePanelState();
  let next = [...state.expandedDirs];
  if (open && !next.includes(path)) {
    next.push(path);
  } else if (!open) {
    next = next.filter((p) => p !== path);
  }
  patchFilePanelState({ expandedDirs: next });
}

function invalidateListingCacheScopes(...roots: (string | undefined)[]): void {
  const main = getWorkspacePath().trim();
  const seen = new Set<string>();
  for (const root of roots) {
    const scope = root?.trim() || main;
    if (!scope || seen.has(scope)) continue;
    seen.add(scope);
    invalidateCachedDirectoryListings(scope);
  }
}

export function invalidateFileTreeCache(): void {
  listingCache.clear();
  invalidateFileTreeIndex();
  invalidateListingCacheScopes(
    getFileTreeListingWorkspaceRoot(),
    getWorkspacePath().trim() || undefined,
  );
  if (!getFileTreeListingWorkspaceRoot()) {
    invalidateCachedDirectoryListingsForCurrentWorkspace();
  }
}

export { affectedDirsFromTool } from './file-tree-invalidation';

/** Drop cached listings for specific directories only (not the whole tree). */
export function invalidateListingCacheForDirs(dirs: string[]): void {
  const unique = [...new Set(dirs.map((d) => normalizeTreePath(d)))];
  for (const dir of unique) {
    listingCache.delete(dir);
  }
  invalidateFileTreeIndex();
}

/** Depth of a directory relative to the tree root (0 = root listing). */
function treeDepthForDir(dir: string, treeRoot: string): number {
  const normalizedDir = normalizeTreePath(dir);
  const normalizedRoot = normalizeTreePath(treeRoot);
  if (normalizedDir === normalizedRoot || normalizedDir === '.') return 0;
  const prefix = normalizedRoot === '.' ? '' : `${normalizedRoot}/`;
  const relative = normalizedDir.startsWith(prefix)
    ? normalizedDir.slice(prefix.length)
    : normalizedDir;
  return relative.split('/').filter(Boolean).length;
}

/** Re-render one expanded directory's children container without rebuilding the whole tree. */
function patchDirChildren(dir: string, treeRoot: string): void {
  const host = document.getElementById('fileTreeHost');
  if (!host) return;

  const normalizedDir = normalizeTreePath(dir);
  const normalizedRoot = normalizeTreePath(treeRoot);

  if (normalizedDir === normalizedRoot || normalizedDir === '.') {
    renderFileTree();
    return;
  }

  const container = host.querySelector<HTMLElement>(
    `[data-tree-dir="${CSS.escape(normalizedDir)}"]`,
  );
  if (!container) return;

  container.innerHTML = '';
  renderSubtree(container, normalizedDir, treeDepthForDir(normalizedDir, treeRoot));
}

function captureFileTreeScrollTop(): number {
  const host = document.getElementById('fileTreeHost');
  return host?.scrollTop ?? 0;
}

function restoreFileTreeScrollTop(scrollTop: number): void {
  const host = document.getElementById('fileTreeHost');
  if (host) host.scrollTop = scrollTop;
}

function restoreFocusedTreeRow(): void {
  if (!focusedTreePath || !focusedTreeKind) return;
  const row = document.querySelector<HTMLElement>(
    `[data-path="${CSS.escape(focusedTreePath)}"]`,
  );
  if (row) {
    row.classList.add('file-tree-row--focused');
  }
}

// ── Refresh ──────────────────────────────────────────────────────────────────

/** Re-fetch and patch only the given directory listings (VS Code-style incremental refresh). */
export async function refreshDirectories(dirs: string[]): Promise<void> {
  if (!isFileTreeServerAvailable()) {
    renderFileTree();
    return;
  }

  if (getFilterQuery().trim()) {
    invalidateFileTreeIndex();
    renderFileTree();
    return;
  }

  const uniqueDirs = [...new Set(dirs.map((d) => normalizeTreePath(d)))];
  if (uniqueDirs.length === 0) {
    await refreshFileTree();
    return;
  }

  const scrollTop = captureFileTreeScrollTop();
  invalidateListingCacheForDirs(uniqueDirs);

  const treeRoot = getFilePanelState().treeRoot || '.';
  for (const dir of uniqueDirs) {
    loadingDirs.add(dir);
    await fetchListing(dir);
    loadingDirs.delete(dir);
    patchDirChildren(dir, treeRoot);
  }

  restoreFileTreeScrollTop(scrollTop);
  restoreFocusedTreeRow();
}

/** Reload the file tree after the effective listing root changes. */
async function refreshFileTreeForListingRootChange(
  nextRoot: string | undefined,
  prevRoot: string | undefined,
): Promise<void> {
  invalidateListingCacheScopes(prevRoot, nextRoot, getWorkspacePath().trim() || undefined);
  setFileTreeListingWorkspaceRoot(nextRoot);

  patchFilePanelState({
    expandedDirs: [],
    selectedPath: null,
    openViewerTabs: [],
    activeViewerTab: null,
  });

  const { closeFileViewerForce } = await import('./file-viewer');
  closeFileViewerForce();

  listingCache.clear();
  invalidateFileTreeIndex();

  await refreshFileTree();
}

/** Sync file tree listing root with git panel worktree cwd; reload when root changes. */
export async function syncFileTreeToPanelWorktree(
  panelCwd?: string,
  options?: { force?: boolean },
): Promise<void> {
  const nextRoot = resolveFileTreeListingRoot(panelCwd);
  const prevRoot = getFileTreeListingWorkspaceRoot();

  if (!fileTreeListingRootsEqual(prevRoot, nextRoot)) {
    await refreshFileTreeForListingRootChange(nextRoot, prevRoot);
  } else if (options?.force) {
    await refreshFileTree();
  }

  startFileTreeGitStatusPoll(nextRoot ?? getWorkspacePath());
  syncFileSidebarTitleFromFileTree();
  void import('./terminal-panel').then((m) => m.syncTerminalFromFileExplorer());
}

/** Update #fileSidebarTitle when the files view is visible. */
export function syncFileSidebarTitleFromFileTree(): void {
  const title = document.getElementById('fileSidebarTitle');
  if (!title || title.textContent === 'Source Control') return;
  title.textContent = `Files${getFileTreeSidebarTitleSuffix()}`;
}

let filterRenderGeneration = 0;

export async function expandDir(path: string): Promise<void> {
  if (!isFileTreeServerAvailable()) return;
  setExpanded(path, true);
  loadingDirs.add(path);
  renderFileTree();
  await fetchListing(path);
  loadingDirs.delete(path);
  renderFileTree();
}

export function collapseDir(path: string): void {
  setExpanded(path, false);
  renderFileTree();
}

// ── Rows ─────────────────────────────────────────────────────────────────────

function setFocusedRow(path: string, kind: FileTreeEntryKind, row: HTMLElement): void {
  focusedTreePath = path;
  focusedTreeKind = kind;
  document.querySelectorAll('.file-tree-row--focused').forEach((el) => {
    el.classList.remove('file-tree-row--focused');
  });
  row.classList.add('file-tree-row--focused');
}

/** Folder the tree lists (task worktree or main workspace); tree paths are relative to it. */
function fileTreeAbsoluteRoot(): string {
  return buildFileTreeToolContext().workspaceRoot?.trim() || getWorkspacePath().trim();
}

/**
 * Draggable file-tree row (composer copy + internal move). In Electron the drag
 * becomes a native OS file drag so it can also land in Explorer, Finder or another
 * app; in-app targets recognise it through the native drag session.
 */
function wireTreeRowDrag(row: HTMLElement, fullPath: string): { consumeClickAfterDrag: () => boolean } {
  row.draggable = true;
  let suppressClick = false;

  row.addEventListener('mousedown', () => {
    suppressClick = false;
  });

  row.addEventListener('dragstart', (event) => {
    suppressClick = true;
    const transfer = event.dataTransfer;
    if (!transfer) return;
    transfer.effectAllowed = 'copyMove';
    transfer.setData(WORKSPACE_FILE_MIME, fullPath);
    transfer.setData('text/plain', fullPath);
    const payload = capturePayloadFromDataTransfer(transfer);
    if (payload) beginCaptureDrag(transfer, payload);
    startNativeWorkspaceDrag(event, fileTreeAbsoluteRoot(), [fullPath], endCaptureDrag);
  });

  row.addEventListener('dragend', () => {
    suppressClick = true;
  });

  return {
    consumeClickAfterDrag: () => {
      if (!suppressClick) return false;
      suppressClick = false;
      return true;
    },
  };
}

function wireRowContextMenu(
  row: HTMLElement,
  path: string,
  kind: FileTreeEntryKind,
): void {
  row.dataset.path = path;
  row.dataset.entryKind = kind;

  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    setFocusedRow(path, kind, row);
    showFileTreeRowContextMenu(buildMenuContext(path, kind), e.clientX, e.clientY);
  });

  row.addEventListener('focus', () => setFocusedRow(path, kind, row));
}

// ── Render ───────────────────────────────────────────────────────────────────

function renderOfflineEmpty(host: HTMLElement): void {
  host.innerHTML = '';
  const msg = document.createElement('p');
  msg.className = 'file-tree-empty';
  msg.textContent = 'Open Minnow to browse project files.';
  host.appendChild(msg);
}

function friendlyListingError(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes('allowlist') || lower.includes('workspaceroot')) {
    return 'Worktree not accessible — enable Full disk access in Settings or add the path via git worktree.';
  }
  return message;
}

function renderTreeError(host: HTMLElement, message: string): void {
  host.innerHTML = '';
  const msg = document.createElement('p');
  msg.className = 'file-tree-empty file-tree-error';
  msg.textContent = friendlyListingError(message);
  host.appendChild(msg);
}

function createExpandHit(path: string, expanded: boolean): HTMLSpanElement {
  const hit = document.createElement('span');
  hit.className = 'file-tree-expand' + (expanded ? ' open' : '');
  hit.setAttribute('role', 'presentation');
  hit.tabIndex = 0;
  hit.setAttribute('aria-label', expanded ? `Collapse ${path}` : `Expand ${path}`);
  hit.addEventListener('click', (e) => {
    e.stopPropagation();
    if (expanded) collapseDir(path);
    else void expandDir(path);
  });
  hit.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      if (expanded) collapseDir(path);
      else void expandDir(path);
    }
  });
  return hit;
}

function appendDirRow(
  host: HTMLElement,
  parentPath: string,
  name: string,
  depth: number,
): void {
  const fullPath = joinTreePath(parentPath, name);
  const expanded = isExpanded(fullPath);
  const loading = loadingDirs.has(fullPath);

  const row = document.createElement('div');
  row.className = 'file-tree-row file-tree-row--dir';
  row.setAttribute('role', 'treeitem');
  row.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  row.setAttribute('data-path', fullPath);
  row.style.paddingLeft = `${dirRowPaddingLeftPx(depth)}px`;
  row.tabIndex = 0;

  row.appendChild(createExpandHit(fullPath, expanded));
  row.appendChild(createFolderTypeIconElement(name, 'tree', { expanded }));

  const label = document.createElement('span');
  label.className = 'file-tree-label';
  label.textContent = loading ? `${name} …` : name;
  row.appendChild(label);

  const drag = wireTreeRowDrag(row, fullPath);

  row.addEventListener('click', () => {
    if (drag.consumeClickAfterDrag()) return;
    setFocusedRow(fullPath, 'dir', row);
    if (expanded) collapseDir(fullPath);
    else void expandDir(fullPath);
  });
  row.addEventListener('dblclick', (e) => {
    e.preventDefault();
    if (!expanded) void expandDir(fullPath);
  });
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (expanded) collapseDir(fullPath);
      else void expandDir(fullPath);
    }
  });

  wireRowContextMenu(row, fullPath, 'dir');
  host.appendChild(row);

  if (expanded) {
    const group = document.createElement('div');
    group.className = 'file-tree-children';
    group.setAttribute('role', 'group');
    group.setAttribute('data-tree-dir', fullPath);
    host.appendChild(group);
    renderSubtree(group, fullPath, depth + 1);
  }
}

function appendFileRow(
  host: HTMLElement,
  parentPath: string,
  name: string,
  depth: number,
): void {
  const fullPath = joinTreePath(parentPath, name);
  const selected = getFilePanelState().selectedPath === fullPath;

  const row = document.createElement('div');
  row.className = 'file-tree-row file-tree-row--file' + (selected ? ' selected' : '');
  row.setAttribute('role', 'treeitem');
  row.setAttribute('data-path', fullPath);
  row.style.paddingLeft = `${fileRowPaddingLeftPx(depth)}px`;
  row.tabIndex = 0;

  row.appendChild(createFileTypeIconElement(name, 'tree'));

  const label = document.createElement('span');
  label.className = 'file-tree-label';
  label.textContent = name;
  row.appendChild(label);

  const drag = wireTreeRowDrag(row, fullPath);

  row.addEventListener('click', (e) => {
    e.stopPropagation();
    setFocusedRow(fullPath, 'file', row);
    if (drag.consumeClickAfterDrag()) return;
    void import('./file-viewer').then((m) => m.openFileInViewer(fullPath));
  });
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      void import('./file-viewer').then((m) => m.openFileInViewer(fullPath));
    }
  });

  wireRowContextMenu(row, fullPath, 'file');
  appendGitBadge(row, fullPath);
  host.appendChild(row);
}

function appendFlatFileRow(host: HTMLElement, fullPath: string): void {
  const selected = getFilePanelState().selectedPath === fullPath;
  const base = basenameOf(fullPath);
  const parent =
    fullPath.includes('/') ? fullPath.slice(0, fullPath.length - base.length - 1) : '';

  const row = document.createElement('div');
  row.className =
    'file-tree-row file-tree-row--file file-tree-row--flat' + (selected ? ' selected' : '');
  row.setAttribute('role', 'option');
  row.setAttribute('data-path', fullPath);
  row.style.paddingLeft = `${FILE_TREE_DIR_BASE_PADDING_PX}px`;
  row.tabIndex = 0;

  row.appendChild(createFileTypeIconElement(base, 'tree'));

  const label = document.createElement('span');
  label.className = 'file-tree-label file-tree-label--flat';
  if (parent) {
    const parentSpan = document.createElement('span');
    parentSpan.className = 'file-tree-path-parent';
    parentSpan.textContent = `${parent}/`;
    const baseSpan = document.createElement('span');
    baseSpan.className = 'file-tree-path-base';
    baseSpan.textContent = base;
    label.appendChild(parentSpan);
    label.appendChild(baseSpan);
  } else {
    label.textContent = base;
  }
  row.appendChild(label);

  const drag = wireTreeRowDrag(row, fullPath);

  row.addEventListener('click', (e) => {
    e.stopPropagation();
    setFocusedRow(fullPath, 'file', row);
    if (drag.consumeClickAfterDrag()) return;
    void import('./file-viewer').then((m) => m.openFileInViewer(fullPath));
  });
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      void import('./file-viewer').then((m) => m.openFileInViewer(fullPath));
    }
  });

  wireRowContextMenu(row, fullPath, 'file');
  appendGitBadge(row, fullPath);
  host.appendChild(row);
}

async function renderFlatResults(host: HTMLElement, root: string, query: string): Promise<void> {
  const generation = ++filterRenderGeneration;
  host.innerHTML = '';
  host.setAttribute('role', 'listbox');
  host.setAttribute('aria-label', 'Filtered project files');

  const wait = document.createElement('p');
  wait.className = 'file-tree-loading';
  wait.textContent = 'Indexing project…';
  host.appendChild(wait);

  const indexResult = await ensureWorkspaceIndex(root, fetchListing);
  if (generation !== filterRenderGeneration) return;

  host.innerHTML = '';
  host.setAttribute('role', 'listbox');
  host.setAttribute('aria-label', 'Filtered project files');

  if ('error' in indexResult) {
    renderTreeError(host, indexResult.error);
    return;
  }

  const matched = sortFilteredPaths(filterPaths(indexResult, query), query);
  if (matched.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'file-tree-empty';
    empty.textContent = 'No matching files';
    host.appendChild(empty);
    return;
  }

  for (const filePath of matched) {
    appendFlatFileRow(host, filePath);
  }
}

function renderSubtree(host: HTMLElement, dirPath: string, depth: number): void {
  const listing = listingCache.get(dirPath);
  if (!listing) {
    if (loadingDirs.has(dirPath)) {
      const wait = document.createElement('p');
      wait.className = 'file-tree-loading';
      wait.textContent = 'Loading…';
      host.appendChild(wait);
    }
    return;
  }

  for (const dir of listing.dirs) {
    appendDirRow(host, dirPath, dir, depth);
  }
  for (const file of listing.files) {
    appendFileRow(host, dirPath, file, depth);
  }
}

// ── Init ─────────────────────────────────────────────────────────────────────

export function renderFileTree(): void {
  const host = document.getElementById('fileTreeHost');
  if (!host) return;

  const scrollTop = captureFileTreeScrollTop();
  const savedFocusPath = focusedTreePath;
  const savedFocusKind = focusedTreeKind;

  if (!isFileTreeServerAvailable()) {
    renderOfflineEmpty(host);
    restoreFileTreeScrollTop(scrollTop);
    return;
  }

  const activeFilter = getFilterQuery().trim();
  if (activeFilter) {
    const root = getFilePanelState().treeRoot || '.';
    void renderFlatResults(host, root, activeFilter).then(() => {
      restoreFileTreeScrollTop(scrollTop);
      restoreFocusedTreeRow();
    });
    return;
  }

  const root = getFilePanelState().treeRoot || '.';
  const rootListing = listingCache.get(root);

  if (!rootListing) {
    host.innerHTML = '';
    host.setAttribute('role', 'tree');
    host.setAttribute('aria-label', 'Project files');
    const wait = document.createElement('p');
    wait.className = 'file-tree-loading';
    wait.textContent = 'Loading project…';
    host.appendChild(wait);
    restoreFileTreeScrollTop(scrollTop);
    // No refresh is running, so the placeholder would stay up forever. Kick one.
    if (rootRefreshesInFlight === 0 && !loadingDirs.has(root)) {
      void refreshFileTree();
    }
    return;
  }

  host.innerHTML = '';
  host.setAttribute('role', 'tree');
  host.setAttribute('aria-label', 'Project files');
  renderSubtree(host, root, 0);

  restoreFileTreeScrollTop(scrollTop);
  if (savedFocusPath && savedFocusKind) {
    focusedTreePath = savedFocusPath;
    focusedTreeKind = savedFocusKind;
    restoreFocusedTreeRow();
  }
}

export async function refreshFileTree(): Promise<void> {
  rootRefreshesInFlight += 1;
  try {
    await refreshFileTreeInner();
  } catch (err) {
    // Never leave the "Loading project…" placeholder standing on a throw.
    const host = document.getElementById('fileTreeHost');
    if (host) renderTreeError(host, err instanceof Error ? err.message : String(err));
  } finally {
    rootRefreshesInFlight -= 1;
  }
}

async function refreshFileTreeInner(): Promise<void> {
  const scrollTop = captureFileTreeScrollTop();
  invalidateFileTreeCache();
  if (!isFileTreeServerAvailable()) {
    renderFileTree();
    return;
  }

  const root = getFilePanelState().treeRoot || '.';
  loadingDirs.add(root);
  renderFileTree();

  let rootResult: ParsedListing | { error: string };
  try {
    rootResult = await fetchListing(root);
  } finally {
    loadingDirs.delete(root);
  }

  if ('error' in rootResult) {
    const host = document.getElementById('fileTreeHost');
    if (host) renderTreeError(host, rootResult.error);
    return;
  }

  const expanded = [...getFilePanelState().expandedDirs];
  if (expanded.length > 0) {
    for (const dir of expanded) {
      loadingDirs.add(dir);
    }
    await Promise.all(
      expanded.map(async (dir) => {
        try {
          await fetchListing(dir);
        } finally {
          loadingDirs.delete(dir);
        }
      }),
    );
  }

  renderFileTree();
  restoreFileTreeScrollTop(scrollTop);
  restoreFocusedTreeRow();
}

export async function initFileTreeIfNeeded(): Promise<void> {
  if (!isFileTreeServerAvailable()) {
    renderFileTree();
    return;
  }
  if (listingCache.size === 0) {
    await refreshFileTree();
  } else {
    renderFileTree();
  }
}

// ── Keys ─────────────────────────────────────────────────────────────────────

/** F2 rename — tree row focus or open file while CodeMirror is focused (BUG-018). */
function handleRenameShortcut(e: KeyboardEvent): void {
  if (e.key !== 'F2' || !isFileTreeServerAvailable()) return;

  if (focusedTreePath && focusedTreeKind) {
    e.preventDefault();
    fileTreeOps.renamePath(focusedTreePath, focusedTreeKind);
    return;
  }

  if (!isFileViewerEditorFocused()) return;

  e.preventDefault();
  void import('./file-viewer').then((viewer) => {
    const open = viewer.getOpenViewerPath();
    if (open) fileTreeOps.renamePath(open, 'file');
  });
}

function handleTreeKeydown(e: KeyboardEvent): void {
  if (!isFileTreeServerAvailable()) return;

  if (e.key === 'F2') {
    handleRenameShortcut(e);
    return;
  }

  if (isFileViewerEditorFocused()) return;
  if (!focusedTreePath || !focusedTreeKind) return;

  const meta = e.metaKey;
  const ctrl = e.ctrlKey;
  const mod = meta || ctrl;

  if (mod && (e.key === 'c' || e.key === 'C')) {
    e.preventDefault();
    if (focusedTreeKind === 'file') fileTreeOps.copyPathToClipboard(focusedTreePath);
    return;
  }
  if (mod && (e.key === 'x' || e.key === 'X')) {
    e.preventDefault();
    fileTreeOps.cutPathToClipboard(focusedTreePath);
    return;
  }
  if (mod && (e.key === 'v' || e.key === 'V')) {
    e.preventDefault();
    const target = pasteTargetDirForPath(focusedTreePath, focusedTreeKind);
    void fileTreeOps.pasteInto(target);
    return;
  }

  if (e.key === 'Delete') {
    e.preventDefault();
    void fileTreeOps.deletePath(focusedTreePath, focusedTreeKind);
  }
}

/** Bind tree host shortcuts and background context menu (once). */
export function initFileTreeCrud(): void {
  if (crudBound) return;
  crudBound = true;

  const host = document.getElementById('fileTreeHost');
  if (!host) return;

  host.addEventListener('keydown', handleTreeKeydown);
  document.addEventListener('keydown', handleRenameShortcut);

  host.addEventListener('contextmenu', (e) => {
    const target = e.target as HTMLElement;
    if (target.closest('.file-tree-row')) return;
    if (!isFileTreeServerAvailable()) return;
    e.preventDefault();
    hideFileTreeContextMenu();
    const root = getFilePanelState().treeRoot || '.';
    showFileTreeBackgroundContextMenu(root, e.clientX, e.clientY);
  });
}

/** Test helper: current keyboard focus path in the tree. */
export function getFocusedTreePathForTests(): {
  path: string | null;
  kind: FileTreeEntryKind | null;
} {
  return { path: focusedTreePath, kind: focusedTreeKind };
}

/** Test helper: seed an in-memory directory listing without hitting the tool server. */
export function seedFileTreeListingForTests(dir: string, listing: ParsedListing): void {
  listingCache.set(normalizeTreePath(dir), listing);
}

/** Test helper: whether clipboard has items. */
export function hasFileTreeClipboardForTests(): boolean {
  return Boolean(getFileTreeClipboard()?.paths.length);
}
