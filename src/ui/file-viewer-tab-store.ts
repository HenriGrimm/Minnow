import {
  MAX_OPEN_VIEWER_TABS,
  getFilePanelState,
  patchFilePanelState,
} from '../state/file-panel';
import { basename, isAncestorPath, normalizeTreePath } from './file-tree-path';
import type { EditorGitDiff } from './editor-git-diff';

// ── Dirty ────────────────────────────────────────────────────────────────────

/** CodeMirror 6 stores documents with LF line breaks only. */
export function normalizeViewerDocText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/** True when editor buffer differs from the loaded/saved baseline (EOL-normalized). */
export function isViewerDocDirty(editorText: string, originalContent: string): boolean {
  return normalizeViewerDocText(editorText) !== normalizeViewerDocText(originalContent);
}

export type ViewerTabKind = 'workspace' | 'attachment';
export type ViewerViewMode = 'editor' | 'markdown-preview' | 'image' | 'pdf' | 'spreadsheet' | 'word';
export type ViewerLoadStatus = 'loading' | 'ready' | 'error';

export interface ViewerTabInitialSelection {
  line: number;
  character: number;
}

export interface ViewerTabInitialLineRange {
  startLine: number;
  endLine: number;
}

/** Per-tab state mirrored from the former file-viewer module globals. */
export interface ViewerTabState {
  gitDiff?: EditorGitDiff;
  path: string;
  displayName: string;
  kind: ViewerTabKind;
  originalContent: string;
  isDirty: boolean;
  readOnlyExcerpt: boolean;
  readOnlyBannerText: string | null;
  viewMode: ViewerViewMode;
  loadStatus: ViewerLoadStatus;
  loadError?: string;
  pendingInitialSelection?: ViewerTabInitialSelection | null;
  pendingInitialLineRange?: ViewerTabInitialLineRange | null;
  /** Editor buffer when the tab is inactive but was previously edited. */
  cachedEditorContent?: string;
  /** Advances only when the editor text changes, including while a save is pending. */
  revision: number;
}

export interface OpenViewerTabOptions {
  skipUnsavedGuard?: boolean;
  asCode?: boolean;
  initialSelection?: ViewerTabInitialSelection;
  initialLineRange?: ViewerTabInitialLineRange;
  kind?: ViewerTabKind;
  displayName?: string;
  /** Preloaded content (attachments / restore without IO). */
  content?: string;
  readOnlyExcerpt?: boolean;
  readOnlyBannerText?: string | null;
  viewMode?: ViewerViewMode;
}

type TabStoreListener = () => void;

const tabs = new Map<string, ViewerTabState>();
let tabOrder: string[] = [];
let activeTabPath: string | null = null;
const listeners = new Set<TabStoreListener>();

/** Virtual paths for chat attachment snapshots (not persisted). */
export function isAttachmentViewerPath(path: string): boolean {
  return path.startsWith('.minnow/attachments/');
}

function tabKey(path: string): string {
  return isAttachmentViewerPath(path) ? path : normalizeTreePath(path);
}

function emitChange(): void {
  for (const fn of listeners) {
    fn();
  }
}

function setTabEditorContent(tab: ViewerTabState, content: string, dirty: boolean): void {
  if (tab.cachedEditorContent !== content) {
    tab.cachedEditorContent = content;
    tab.revision += 1;
  }
  if (dirty !== tab.isDirty) {
    tab.isDirty = dirty;
    emitChange();
  }
}

// ── Queries ──────────────────────────────────────────────────────────────────

/** Subscribe to tab list / active tab changes (UI refresh). */
export function onViewerTabStoreChange(listener: TabStoreListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function listViewerTabs(): ViewerTabState[] {
  return tabOrder
    .map((p) => tabs.get(p))
    .filter((t): t is ViewerTabState => t !== undefined);
}

export function getViewerTab(path: string): ViewerTabState | undefined {
  return tabs.get(tabKey(path));
}

export function getActiveViewerTab(): ViewerTabState | null {
  if (!activeTabPath) return null;
  return tabs.get(activeTabPath) ?? null;
}

export function getActiveViewerTabPath(): string | null {
  return activeTabPath;
}

export function isAnyViewerTabDirty(): boolean {
  for (const tab of tabs.values()) {
    if (tab.isDirty) return true;
  }
  return false;
}

export function isViewerTabDirty(path: string): boolean {
  return tabs.get(tabKey(path))?.isDirty ?? false;
}

export function getOpenViewerTabPaths(): string[] {
  return [...tabOrder];
}

function workspaceTabCount(): number {
  return tabOrder.filter((p) => !isAttachmentViewerPath(p)).length;
}

function persistWorkspaceTabs(): void {
  const workspacePaths = tabOrder.filter((p) => !isAttachmentViewerPath(p));
  const active =
    activeTabPath && !isAttachmentViewerPath(activeTabPath) ? activeTabPath : null;
  const panel = getFilePanelState();
  const patch: Parameters<typeof patchFilePanelState>[0] = {
    openViewerTabs: workspacePaths,
    activeViewerTab: active,
    selectedPath: activeTabPath,
  };
  if (panel.rightPaneMode !== 'preview') {
    patch.rightPaneMode = tabOrder.length > 0 ? 'viewer' : undefined;
  }
  patchFilePanelState(patch);
}

function setActiveInternal(path: string | null): void {
  activeTabPath = path;
  if (!path) return;
  if (isAttachmentViewerPath(path)) {
    patchFilePanelState({ selectedPath: path });
    return;
  }
  patchFilePanelState({
    selectedPath: path,
    activeViewerTab: path,
  });
}

// ── Snapshots ────────────────────────────────────────────────────────────────

/** Point the global "active tab" at a slot's active path when split focus moves. */
export function adoptActiveViewerTabPath(path: string | null): void {
  const key = path ? tabKey(path) : null;
  if (key !== null && !tabs.has(key)) return;
  if (activeTabPath === key) return;
  activeTabPath = key;
  if (key) {
    setActiveInternal(key);
  } else {
    patchFilePanelState({ activeViewerTab: null });
  }
  emitChange();
}

/** Snapshot editor buffer from the active tab before switching away. */
export function snapshotActiveTabEditorContent(content: string, dirty: boolean): void {
  const tab = getActiveViewerTab();
  if (!tab || tab.viewMode === 'image') return;
  setTabEditorContent(tab, content, dirty);
}

/** Snapshot editor buffer into a specific tab (by path key). */
export function snapshotViewerTabEditorContent(
  path: string,
  content: string,
  dirty: boolean,
): void {
  const tab = getViewerTab(path);
  if (!tab || tab.viewMode === 'image') return;
  setTabEditorContent(tab, content, dirty);
}

export function updateActiveTabFromEditor(content: string, dirty: boolean): void {
  const tab = getActiveViewerTab();
  if (!tab) return;
  setTabEditorContent(tab, content, dirty);
}

/** Commit a save only to the tab instance that submitted it. A newer draft stays intact. */
export function markViewerTabSaved(
  tab: ViewerTabState,
  submittedRevision: number,
  content: string,
): boolean {
  if (getViewerTab(tab.path) !== tab) return false;
  const normalized = normalizeViewerDocText(content);
  tab.originalContent = normalized;
  const unchanged = tab.revision === submittedRevision;
  if (unchanged) tab.cachedEditorContent = normalized;
  tab.isDirty = isViewerDocDirty(tab.cachedEditorContent ?? normalized, normalized);
  emitChange();
  return unchanged;
}

/** Rebase an explicitly chosen draft on disk, without touching a reopened tab. */
export function reconcileViewerTabWithDisk(tab: ViewerTabState, disk: string, draft: string): boolean {
  if (getViewerTab(tab.path) !== tab) return false;
  tab.originalContent = normalizeViewerDocText(disk);
  const nextDraft = normalizeViewerDocText(draft);
  if (tab.cachedEditorContent !== nextDraft) tab.revision += 1;
  tab.cachedEditorContent = nextDraft;
  tab.isDirty = isViewerDocDirty(nextDraft, tab.originalContent);
  emitChange();
  return true;
}

/** Apply load result to a specific tab (by path) so async loads cannot land on the wrong tab. */
export function setViewerTabLoadState(
  path: string,
  status: ViewerLoadStatus,
  payload?: {
    content?: string;
    readOnlyExcerpt?: boolean;
    readOnlyBannerText?: string | null;
    viewMode?: ViewerViewMode;
    error?: string;
  },
): void {
  const tab = getViewerTab(path);
  if (!tab) return;
  tab.loadStatus = status;
  if (payload?.content !== undefined) {
    const normalized = normalizeViewerDocText(payload.content);
    tab.originalContent = normalized;
    tab.cachedEditorContent = normalized;
    tab.isDirty = false;
  }
  if (payload?.readOnlyExcerpt !== undefined) {
    tab.readOnlyExcerpt = payload.readOnlyExcerpt;
  }
  if (payload?.readOnlyBannerText !== undefined) {
    tab.readOnlyBannerText = payload.readOnlyBannerText;
  }
  if (payload?.viewMode !== undefined) {
    tab.viewMode = payload.viewMode;
  }
  if (payload?.error !== undefined) {
    tab.loadError = payload.error;
  }
  emitChange();
}

export function setActiveTabLoadState(
  status: ViewerLoadStatus,
  payload?: {
    content?: string;
    readOnlyExcerpt?: boolean;
    readOnlyBannerText?: string | null;
    viewMode?: ViewerViewMode;
    error?: string;
  },
): void {
  const active = getActiveViewerTabPath();
  if (!active) return;
  setViewerTabLoadState(active, status, payload);
}

/** After CodeMirror mounts, adopt its exact doc string as the clean baseline. */
export function rebaselineViewerTabFromEditor(path: string, editorText: string): void {
  const tab = getViewerTab(path);
  if (!tab || tab.readOnlyExcerpt) return;
  const normalized = normalizeViewerDocText(editorText);
  tab.originalContent = normalized;
  tab.cachedEditorContent = normalized;
  if (tab.isDirty) {
    tab.isDirty = false;
    emitChange();
  }
}

function shouldUseMarkdownPreview(path: string, asCode?: boolean): boolean {
  const lower = path.toLowerCase();
  return (lower.endsWith('.md') || lower.endsWith('.markdown')) && !asCode;
}

function createTabState(path: string, options?: OpenViewerTabOptions): ViewerTabState {
  const key = tabKey(path);
  const kind = options?.kind ?? (isAttachmentViewerPath(path) ? 'attachment' : 'workspace');
  const displayName = options?.displayName ?? basename(key);
  const hasContent = options?.content !== undefined;
  const viewMode =
    options?.viewMode ??
    (shouldUseMarkdownPreview(path, options?.asCode) ? 'markdown-preview' : 'editor');
  const seededContent =
    options?.content !== undefined ? normalizeViewerDocText(options.content) : undefined;
  return {
    path: key,
    displayName,
    kind,
    originalContent: seededContent ?? '',
    cachedEditorContent: seededContent,
    revision: 0,
    isDirty: false,
    readOnlyExcerpt: options?.readOnlyExcerpt ?? false,
    readOnlyBannerText: options?.readOnlyBannerText ?? null,
    viewMode,
    loadStatus: hasContent ? 'ready' : 'loading',
    pendingInitialSelection: options?.initialSelection ?? null,
    pendingInitialLineRange: options?.initialLineRange ?? null,
  };
}

export interface OpenViewerTabResult {
  focusedExisting: boolean;
  tab: ViewerTabState;
}

/** Open or focus a tab. */
export type ViewerUnsavedGuard = () => boolean | Promise<boolean>;

// ── Open ─────────────────────────────────────────────────────────────────────

export function openViewerTab(
  path: string,
  options?: OpenViewerTabOptions & {
    confirmUnsaved?: ViewerUnsavedGuard;
    /** Snapshot outgoing editor before unsaved guard / tab switch. */
    beforeActivate?: () => void;
  },
): Promise<OpenViewerTabResult | null> {
  return openViewerTabInternal(path, options);
}

async function openViewerTabInternal(
  path: string,
  options?: OpenViewerTabOptions & {
    confirmUnsaved?: ViewerUnsavedGuard;
    beforeActivate?: () => void;
  },
): Promise<OpenViewerTabResult | null> {
  const key = tabKey(path);
  const existing = tabs.get(key);
  if (existing) {
    if (activeTabPath && activeTabPath !== key) {
      options?.beforeActivate?.();
    }
    if (
      !options?.skipUnsavedGuard &&
      activeTabPath &&
      activeTabPath !== key &&
      options?.confirmUnsaved &&
      !(await options.confirmUnsaved())
    ) {
      return null;
    }
    if (options?.initialSelection) {
      existing.pendingInitialSelection = options.initialSelection;
    }
    if (options?.initialLineRange) {
      existing.pendingInitialLineRange = options.initialLineRange;
    }
    if (options?.asCode && existing.viewMode === 'markdown-preview') {
      existing.viewMode = 'editor';
    }
    setActiveInternal(key);
    emitChange();
    persistWorkspaceTabs();
    return { focusedExisting: true, tab: existing };
  }

  if (activeTabPath) {
    options?.beforeActivate?.();
  }
  if (
    !options?.skipUnsavedGuard &&
    activeTabPath &&
    options?.confirmUnsaved &&
    !(await options.confirmUnsaved())
  ) {
    return null;
  }

  if (!isAttachmentViewerPath(key) && workspaceTabCount() >= MAX_OPEN_VIEWER_TABS) {
    return null;
  }

  const tab = createTabState(path, options);
  tabs.set(key, tab);
  tabOrder.push(key);
  setActiveInternal(key);
  emitChange();
  persistWorkspaceTabs();
  return { focusedExisting: false, tab };
}

export function activateViewerTab(
  path: string,
  options?: {
    skipUnsavedGuard?: boolean;
    confirmUnsaved?: ViewerUnsavedGuard;
    /** Snapshot outgoing editor before unsaved guard / tab switch. */
    beforeActivate?: () => void;
  },
): Promise<boolean> {
  return activateViewerTabInternal(path, options);
}

async function activateViewerTabInternal(
  path: string,
  options?: {
    skipUnsavedGuard?: boolean;
    confirmUnsaved?: ViewerUnsavedGuard;
    beforeActivate?: () => void;
  },
): Promise<boolean> {
  const key = tabKey(path);
  if (!tabs.has(key)) return false;
  if (activeTabPath && activeTabPath !== key) {
    options?.beforeActivate?.();
  }
  if (
    !options?.skipUnsavedGuard &&
    activeTabPath &&
    activeTabPath !== key &&
    options?.confirmUnsaved &&
    !(await options.confirmUnsaved())
  ) {
    return false;
  }
  setActiveInternal(key);
  emitChange();
  persistWorkspaceTabs();
  return true;
}

// ── Close ────────────────────────────────────────────────────────────────────

/** Reorder a tab to a new index in the strip (0-based). */
export function reorderViewerTab(path: string, toIndex: number): void {
  const key = tabKey(path);
  const fromIndex = tabOrder.indexOf(key);
  if (fromIndex < 0) return;
  const clamped = Math.max(0, Math.min(toIndex, tabOrder.length - 1));
  if (fromIndex === clamped) return;
  tabOrder.splice(fromIndex, 1);
  tabOrder.splice(clamped, 0, key);
  emitChange();
  persistWorkspaceTabs();
}

/** Close every tab except the given path (no unsaved guard — caller handles). */
export function closeOtherViewerTabs(keepPath: string): string[] {
  const keepKey = tabKey(keepPath);
  const closed = tabOrder.filter((p) => p !== keepKey);
  for (const p of closed) {
    tabs.delete(p);
  }
  tabOrder = tabs.has(keepKey) ? [keepKey] : [];
  if (activeTabPath && !tabs.has(activeTabPath)) {
    activeTabPath = tabOrder[tabOrder.length - 1] ?? null;
  }
  emitChange();
  persistWorkspaceTabs();
  return closed;
}

/** Close tabs to the right of the given path (no unsaved guard — caller handles). */
export function closeViewerTabsToRight(path: string): string[] {
  const key = tabKey(path);
  const idx = tabOrder.indexOf(key);
  if (idx < 0) return [];
  const closed = tabOrder.slice(idx + 1);
  for (const p of closed) {
    tabs.delete(p);
  }
  tabOrder = tabOrder.slice(0, idx + 1);
  if (activeTabPath && !tabs.has(activeTabPath)) {
    activeTabPath = tabOrder[tabOrder.length - 1] ?? null;
  }
  emitChange();
  persistWorkspaceTabs();
  return closed;
}

export function removeViewerTab(path: string): void {
  const key = tabKey(path);
  if (!tabs.has(key)) return;
  tabs.delete(key);
  tabOrder = tabOrder.filter((p) => p !== key);
  if (activeTabPath === key) {
    const next = tabOrder[tabOrder.length - 1] ?? null;
    activeTabPath = next;
  }
  emitChange();
  persistWorkspaceTabs();
}

export function clearAllViewerTabs(): void {
  tabs.clear();
  tabOrder = [];
  activeTabPath = null;
  emitChange();
  patchFilePanelState({
    openViewerTabs: [],
    activeViewerTab: null,
    selectedPath: null,
  });
}

/** Workspace tab paths for persistence (order preserved). */
export function serializeWorkspaceViewerTabs(): string[] {
  return tabOrder.filter((p) => !isAttachmentViewerPath(p));
}

/** Restore tab strip after load; content loads when each tab is activated. */
export function restoreWorkspaceViewerTabs(paths: string[], activePath: string | null): void {
  tabs.clear();
  tabOrder = [];
  for (const p of paths.slice(0, MAX_OPEN_VIEWER_TABS)) {
    const key = normalizeTreePath(p);
    if (isAttachmentViewerPath(key)) continue;
    const tab = createTabState(key);
    tabs.set(key, tab);
    tabOrder.push(key);
  }
  const activeKey = activePath ? tabKey(activePath) : null;
  activeTabPath =
    activeKey && tabs.has(activeKey)
      ? activeKey
      : tabOrder.length > 0
        ? tabOrder[tabOrder.length - 1]!
        : null;
  emitChange();
}

export function retargetViewerTab(oldPath: string, newPath: string): void {
  const oldKey = tabKey(oldPath);
  const newKey = tabKey(newPath);
  const tab = tabs.get(oldKey);
  if (!tab) return;
  tabs.delete(oldKey);
  tab.path = newKey;
  tab.displayName = basename(newKey);
  tabs.set(newKey, tab);
  tabOrder = tabOrder.map((p) => (p === oldKey ? newKey : p));
  if (activeTabPath === oldKey) {
    activeTabPath = newKey;
  }
  emitChange();
  persistWorkspaceTabs();
}

export function closeViewerTabsUnderAncestor(ancestorPath: string): void {
  const norm = normalizeTreePath(ancestorPath);
  const toClose = tabOrder.filter((p) => {
    const pn = normalizeTreePath(p);
    return pn === norm || isAncestorPath(norm, pn);
  });
  for (const p of toClose) {
    tabs.delete(p);
  }
  tabOrder = tabOrder.filter((p) => !toClose.includes(p));
  if (activeTabPath && toClose.includes(activeTabPath)) {
    activeTabPath = tabOrder[tabOrder.length - 1] ?? null;
  }
  emitChange();
  persistWorkspaceTabs();
}

export function remapViewerTabsUnderAncestor(oldAncestor: string, newAncestor: string): string[] {
  const oldNorm = normalizeTreePath(oldAncestor);
  const newNorm = normalizeTreePath(newAncestor);
  const remapped: string[] = [];
  const nextOrder: string[] = [];
  for (const p of tabOrder) {
    const pn = normalizeTreePath(p);
    if (pn === oldNorm || isAncestorPath(oldNorm, pn)) {
      const newPath = normalizeTreePath(newNorm + pn.slice(oldNorm.length));
      const tab = tabs.get(p);
      if (tab) {
        tabs.delete(p);
        tab.path = newPath;
        tab.displayName = basename(newPath);
        tabs.set(newPath, tab);
        remapped.push(newPath);
        nextOrder.push(newPath);
      }
    } else {
      nextOrder.push(p);
    }
  }
  tabOrder = nextOrder;
  if (activeTabPath) {
    const activeNorm = normalizeTreePath(activeTabPath);
    if (isAncestorPath(oldNorm, activeNorm) || activeNorm === oldNorm) {
      activeTabPath = normalizeTreePath(newNorm + activeNorm.slice(oldNorm.length));
    }
  }
  emitChange();
  persistWorkspaceTabs();
  return remapped;
}

/** Test helper: reset in-memory tab store. */
export function resetViewerTabStoreForTests(): void {
  tabs.clear();
  tabOrder = [];
  activeTabPath = null;
  listeners.clear();
}
