/**
 * File panel UI state and persistence via config.json `filePanel` (Step 02 meta API).
 */

import { detectConfigServer } from '../config/storage-mode';
import { normalizeWorkspacePath } from '../lib/normalize-workspace-path';
import { readWorkspaceMapRow } from '../lib/workspace-scoped-map';
import { getWorkspacePath } from './workspace';

/** Workspace file or arbitrary URL shown in the preview panel. */
export type PreviewSource =
  | { kind: 'workspace'; path: string }
  | { kind: 'url'; url: string };

/** Which pane occupies the right split (null = closed). */
export type RightPaneMode = 'viewer' | 'preview' | 'split' | null;

/** Primary or secondary slot inside the right-pane vertical split. */
export type PaneSlotId = 'primary' | 'secondary';

/** Content shown in one right-pane slot when split is enabled. */
export type SlotContent =
  | { kind: 'none' }
  | { kind: 'viewer'; tabPath: string | null }
  | { kind: 'preview'; tabId: string | null };

/** Tab lists owned by one split slot (file + browser tabs in that pane). */
export interface SlotPaneTabs {
  viewerPaths: string[];
  activeViewerPath: string | null;
  previewIds: string[];
  activePreviewId: string | null;
  surface: 'viewer' | 'preview' | 'none';
}

// ── Defaults ─────────────────────────────────────────────────────────────────

export const EMPTY_SLOT_PANE_TABS: SlotPaneTabs = {
  viewerPaths: [],
  activeViewerPath: null,
  previewIds: [],
  activePreviewId: null,
  surface: 'none',
};

/** Vertical split inside the Code workspace right column (two independent surfaces). */
export interface RightPaneSplitState {
  enabled: boolean;
  /** Primary slot width share (0.35–0.65). */
  ratio: number;
  focusedSlot: PaneSlotId;
  primary: SlotContent;
  secondary: SlotContent;
  primaryTabs: SlotPaneTabs;
  secondaryTabs: SlotPaneTabs;
}

export const RIGHT_PANE_SPLIT_RATIO_MIN = 0.35;
export const RIGHT_PANE_SPLIT_RATIO_MAX = 0.65;

export const DEFAULT_RIGHT_PANE_SPLIT: RightPaneSplitState = {
  enabled: false,
  ratio: 0.5,
  focusedSlot: 'primary',
  primary: { kind: 'none' },
  secondary: { kind: 'none' },
  primaryTabs: { ...EMPTY_SLOT_PANE_TABS },
  secondaryTabs: { ...EMPTY_SLOT_PANE_TABS },
};

/** Where DevTools attaches relative to the preview guest. */
export type PreviewDevToolsDock = 'bottom' | 'side' | 'popout';

/** Max workspace file tabs persisted and open at once in the viewer strip. */
export const MAX_OPEN_VIEWER_TABS = 20;

/** Max preview browser tabs (each Electron tab is a live Chromium renderer). */
export const MAX_PREVIEW_TABS = 6;

/** Max recent viewer files remembered per workspace (empty-state MRU). */
export const MAX_RECENT_VIEWER_FILES = 12;

/** Persisted preview tab row (source only; title/loading are runtime). */
export interface PersistedPreviewTab {
  id: string;
  source: PreviewSource | null;
}

/** One recently opened workspace file (path is workspace-relative). */
export interface RecentViewerFileEntry {
  path: string;
  openedAt: number;
}

/**
 * Recent viewer files for one workspace root key.
 * Key is an absolute workspace/listing root, or `__default__` when unset.
 */
export type RecentViewerFilesByWorkspace = Record<string, RecentViewerFileEntry[]>;

/** Persisted + in-memory file explorer / viewer preferences. */
export interface FilePanelState {
  fileSidebarCollapsed: boolean;
  /** Expanded file sidebar width in px (persisted). */
  fileSidebarWidth?: number;
  /** @deprecated Use rightPaneMode; kept in sync for older persisted configs. */
  viewerOpen: boolean;
  rightPaneMode: RightPaneMode;
  /**
   * Right pane hidden by its close button while every tab, guest and split slot
   * stays alive underneath; reopening restores the same surface (MIN-224).
   */
  rightPaneCollapsed: boolean;
  /** @deprecated Migrated into previewTabs; kept in sync with active tab source. */
  previewSource: PreviewSource | null;
  previewAutoReload: boolean;
  /** Docked DevTools position in the preview guest (Electron only). */
  previewDevToolsDock: PreviewDevToolsDock;
  splitRatio: number;
  expandedDirs: string[];
  selectedPath: string | null;
  /** Workspace-relative paths open in the file viewer (attachments excluded). */
  openViewerTabs: string[];
  /** Active viewer tab path; must be in openViewerTabs or null. */
  activeViewerTab: string | null;
  /** Open preview browser tabs (order preserved). */
  previewTabs: PersistedPreviewTab[];
  /** Active preview tab id; must be in previewTabs or null. */
  activePreviewTab: string | null;
  /**
   * Most-recently-opened workspace files for the viewer empty state,
   * keyed by absolute workspace / listing root.
   */
  recentViewerFilesByWorkspace: RecentViewerFilesByWorkspace;
  treeRoot: string;
  /** Two-slot right column (file+file, file+browser, browser+browser). */
  rightPaneSplit: RightPaneSplitState;
}

export const DEFAULT_FILE_PANEL_STATE: FilePanelState = {
  fileSidebarCollapsed: false,
  viewerOpen: false,
  rightPaneMode: null,
  rightPaneCollapsed: false,
  previewSource: null,
  previewAutoReload: true,
  previewDevToolsDock: 'bottom',
  splitRatio: 0.55,
  expandedDirs: [],
  selectedPath: null,
  openViewerTabs: [],
  activeViewerTab: null,
  previewTabs: [],
  activePreviewTab: null,
  recentViewerFilesByWorkspace: {},
  treeRoot: '.',
  rightPaneSplit: { ...DEFAULT_RIGHT_PANE_SPLIT },
};

/** Persisted split ratio bounds (main column share when the right pane is open). */
export const SPLIT_RATIO_MIN = 0.35;
export const SPLIT_RATIO_MAX = 0.75;
/** Dragging the split left past this main-column ratio collapses chat for a full-width preview. */
export const SPLIT_DRAG_CHAT_COLLAPSE_THRESHOLD = 0.12;

const SPLIT_MIN = SPLIT_RATIO_MIN;
const SPLIT_MAX = SPLIT_RATIO_MAX;
const FILE_SIDEBAR_MIN_W = 220;
const FILE_SIDEBAR_MAX_W = 560;
const DEFAULT_FILE_SIDEBAR_W = 350;

function clampFileSidebarWidth(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_FILE_SIDEBAR_W;
  return Math.min(FILE_SIDEBAR_MAX_W, Math.max(FILE_SIDEBAR_MIN_W, Math.round(value)));
}

let panelState: FilePanelState = { ...DEFAULT_FILE_PANEL_STATE };
let panelWorkspaceKey = '';
let saveTimer: ReturnType<typeof setTimeout> | null = null;
const SAVE_DEBOUNCE_MS = 400;

// ── Normalize ────────────────────────────────────────────────────────────────

function clampSplitRatio(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_FILE_PANEL_STATE.splitRatio;
  return Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, value));
}

function normalizePreviewSource(raw: unknown): PreviewSource | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  if (row.kind === 'workspace' && typeof row.path === 'string' && row.path.trim()) {
    return { kind: 'workspace', path: row.path };
  }
  if (row.kind === 'url' && typeof row.url === 'string' && row.url.trim()) {
    return { kind: 'url', url: row.url };
  }
  return null;
}

function clampRightPaneSplitRatio(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_RIGHT_PANE_SPLIT.ratio;
  return Math.min(
    RIGHT_PANE_SPLIT_RATIO_MAX,
    Math.max(RIGHT_PANE_SPLIT_RATIO_MIN, value),
  );
}

function normalizeSlotContent(raw: unknown): SlotContent {
  if (!raw || typeof raw !== 'object') return { kind: 'none' };
  const row = raw as Record<string, unknown>;
  if (row.kind === 'viewer') {
    const tabPath =
      typeof row.tabPath === 'string' && row.tabPath.trim()
        ? row.tabPath.trim().replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\.\//, '')
        : null;
    return { kind: 'viewer', tabPath };
  }
  if (row.kind === 'preview') {
    const tabId = typeof row.tabId === 'string' && row.tabId.trim() ? row.tabId.trim() : null;
    return { kind: 'preview', tabId };
  }
  return { kind: 'none' };
}

function deriveSlotFromLegacy(
  rightPaneMode: RightPaneMode,
  activeViewerTab: string | null,
  activePreviewTab: string | null,
): SlotContent {
  if (rightPaneMode === 'preview') {
    return { kind: 'preview', tabId: activePreviewTab };
  }
  if (rightPaneMode === 'viewer' || activeViewerTab) {
    return { kind: 'viewer', tabPath: activeViewerTab };
  }
  return { kind: 'none' };
}

function normalizeSlotPaneTabs(
  raw: unknown,
  legacy: SlotContent,
  viewerPaths: string[],
  activeViewer: string | null,
  previewIds: string[],
  activePreview: string | null,
): SlotPaneTabs {
  if (raw && typeof raw === 'object') {
    const row = raw as Record<string, unknown>;
    const paths = normalizeViewerTabPaths(row.viewerPaths ?? row.viewerTabPaths);
    const ids: string[] = [];
    if (Array.isArray(row.previewIds)) {
      for (const entry of row.previewIds) {
        if (typeof entry === 'string' && entry.trim()) ids.push(entry.trim());
      }
    }
    const activeViewerPath =
      typeof row.activeViewerPath === 'string' && paths.includes(row.activeViewerPath)
        ? row.activeViewerPath
        : paths.length > 0
          ? paths[paths.length - 1]!
          : null;
    const activePreviewId =
      typeof row.activePreviewId === 'string' && ids.includes(row.activePreviewId)
        ? row.activePreviewId
        : ids.length > 0
          ? ids[ids.length - 1]!
          : null;
    let surface: SlotPaneTabs['surface'] = 'none';
    if (row.surface === 'viewer' || row.surface === 'preview') {
      surface = row.surface;
    } else if (legacy.kind === 'viewer') surface = 'viewer';
    else if (legacy.kind === 'preview') surface = 'preview';
    else if (activeViewerPath) surface = 'viewer';
    else if (activePreviewId) surface = 'preview';
    return {
      viewerPaths: paths,
      activeViewerPath,
      previewIds: ids,
      activePreviewId,
      surface,
    };
  }
  if (legacy.kind === 'viewer' && legacy.tabPath) {
    const paths = viewerPaths.length > 0 ? viewerPaths : [legacy.tabPath];
    return {
      viewerPaths: paths,
      activeViewerPath: legacy.tabPath,
      previewIds: [],
      activePreviewId: null,
      surface: 'viewer',
    };
  }
  if (legacy.kind === 'preview' && legacy.tabId) {
    const ids = previewIds.length > 0 ? previewIds : [legacy.tabId];
    return {
      viewerPaths: [],
      activeViewerPath: null,
      previewIds: ids,
      activePreviewId: legacy.tabId,
      surface: 'preview',
    };
  }
  return { ...EMPTY_SLOT_PANE_TABS };
}

function normalizeRightPaneSplit(
  raw: unknown,
  rightPaneMode: RightPaneMode,
  activeViewerTab: string | null,
  activePreviewTab: string | null,
  openViewerTabs: string[],
  previewTabIds: string[],
): RightPaneSplitState {
  const legacyPrimary = deriveSlotFromLegacy(rightPaneMode, activeViewerTab, activePreviewTab);
  if (!raw || typeof raw !== 'object') {
    return {
      ...DEFAULT_RIGHT_PANE_SPLIT,
      primary: legacyPrimary,
      primaryTabs: normalizeSlotPaneTabs(
        undefined,
        legacyPrimary,
        openViewerTabs,
        activeViewerTab,
        previewTabIds,
        activePreviewTab,
      ),
    };
  }
  const row = raw as Record<string, unknown>;
  const enabled = row.enabled === true;
  const focusedSlot: PaneSlotId = row.focusedSlot === 'secondary' ? 'secondary' : 'primary';
  const primary = normalizeSlotContent(row.primary);
  const secondary = normalizeSlotContent(row.secondary);
  const ratio = clampRightPaneSplitRatio(
    typeof row.ratio === 'number' ? row.ratio : DEFAULT_RIGHT_PANE_SPLIT.ratio,
  );
  const primaryLegacy = primary.kind === 'none' ? legacyPrimary : primary;
  const primaryTabs = normalizeSlotPaneTabs(
    row.primaryTabs,
    primaryLegacy,
    openViewerTabs,
    activeViewerTab,
    previewTabIds,
    activePreviewTab,
  );
  const secondaryTabs = enabled
    ? normalizeSlotPaneTabs(row.secondaryTabs, secondary, [], null, [], null)
    : { ...EMPTY_SLOT_PANE_TABS };
  if (!enabled) {
    return {
      enabled: false,
      ratio,
      focusedSlot,
      primary: legacyPrimary,
      secondary: { kind: 'none' },
      primaryTabs,
      secondaryTabs: { ...EMPTY_SLOT_PANE_TABS },
    };
  }
  return {
    enabled: true,
    ratio,
    focusedSlot,
    primary: primaryLegacy,
    secondary,
    primaryTabs,
    secondaryTabs,
  };
}

function normalizeRightPaneMode(
  raw: unknown,
  viewerOpen: boolean,
  previewSource: PreviewSource | null,
  splitEnabled: boolean,
): RightPaneMode {
  if (splitEnabled) return 'split';
  if (raw === 'viewer' || raw === 'preview') return raw;
  if (raw === 'split') return null;
  if (previewSource && viewerOpen) return 'preview';
  if (viewerOpen) return 'viewer';
  return null;
}

function normalizeViewerTabPaths(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (!trimmed || trimmed.startsWith('.minnow/attachments/')) continue;
    const norm = trimmed.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\.\//, '');
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    paths.push(norm);
    if (paths.length >= MAX_OPEN_VIEWER_TABS) break;
  }
  return paths;
}

function normalizeActiveViewerTab(
  raw: unknown,
  openTabs: string[],
  selectedPath: string | null,
): string | null {
  if (typeof raw === 'string' && raw.trim()) {
    const norm = raw.trim().replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\.\//, '');
    if (openTabs.includes(norm)) return norm;
  }
  if (selectedPath) {
    const sel = selectedPath.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\.\//, '');
    if (openTabs.includes(sel)) return sel;
  }
  return openTabs.length > 0 ? openTabs[openTabs.length - 1]! : null;
}

function normalizePreviewTabs(raw: unknown, legacySource: PreviewSource | null): PersistedPreviewTab[] {
  if (Array.isArray(raw) && raw.length > 0) {
    const rows: PersistedPreviewTab[] = [];
    const seen = new Set<string>();
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object') continue;
      const row = entry as Record<string, unknown>;
      const id = typeof row.id === 'string' ? row.id.trim() : '';
      if (!id || seen.has(id)) continue;
      seen.add(id);
      rows.push({ id, source: normalizePreviewSource(row.source) });
      if (rows.length >= MAX_PREVIEW_TABS) break;
    }
    if (rows.length > 0) return rows;
  }
  if (legacySource) {
    return [{ id: 'legacy-preview-tab', source: legacySource }];
  }
  return [];
}

function normalizeActivePreviewTab(
  raw: unknown,
  tabs: PersistedPreviewTab[],
): string | null {
  if (typeof raw === 'string' && raw.trim()) {
    const id = raw.trim();
    if (tabs.some((t) => t.id === id)) return id;
  }
  return tabs.length > 0 ? tabs[tabs.length - 1]!.id : null;
}

/** Normalize persisted recent-viewer-files map (workspace root → MRU list). */
function normalizeRecentViewerFilesByWorkspace(raw: unknown): RecentViewerFilesByWorkspace {
  if (!raw || typeof raw !== 'object') return {};
  const out: RecentViewerFilesByWorkspace = {};
  for (const [workspaceKey, entries] of Object.entries(raw as Record<string, unknown>)) {
    const key = workspaceKey.trim();
    if (!key || !Array.isArray(entries)) continue;
    const seen = new Set<string>();
    const list: RecentViewerFileEntry[] = [];
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      const row = entry as Record<string, unknown>;
      if (typeof row.path !== 'string') continue;
      const path = row.path
        .trim()
        .replace(/\\/g, '/')
        .replace(/\/+/g, '/')
        .replace(/^\.\//, '');
      if (!path || path.startsWith('.minnow/attachments/') || seen.has(path)) continue;
      const openedAt =
        typeof row.openedAt === 'number' && Number.isFinite(row.openedAt)
          ? row.openedAt
          : 0;
      seen.add(path);
      list.push({ path, openedAt });
      if (list.length >= MAX_RECENT_VIEWER_FILES) break;
    }
    if (list.length > 0) out[key] = list;
  }
  return out;
}

/** Deep-copy recent-files map so callers cannot mutate persisted state in place. */
function cloneRecentViewerFilesByWorkspace(
  map: RecentViewerFilesByWorkspace,
): RecentViewerFilesByWorkspace {
  const out: RecentViewerFilesByWorkspace = {};
  for (const [key, entries] of Object.entries(map)) {
    out[key] = entries.map((e) => ({ path: e.path, openedAt: e.openedAt }));
  }
  return out;
}

function normalizeFilePanelBlock(raw: unknown): FilePanelState {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_FILE_PANEL_STATE };
  }
  const row = raw as Record<string, unknown>;
  const expandedDirs = Array.isArray(row.expandedDirs)
    ? row.expandedDirs.filter((p): p is string => typeof p === 'string')
    : [];
  const viewerOpenLegacy = row.viewerOpen === true;
  const previewSource = normalizePreviewSource(row.previewSource);
  const openViewerTabsEarly = normalizeViewerTabPaths(row.openViewerTabs);
  const previewTabsEarly = normalizePreviewTabs(row.previewTabs, previewSource);
  const activePreviewTabEarly = normalizeActivePreviewTab(row.activePreviewTab, previewTabsEarly);
  const activeViewerTabEarly = normalizeActiveViewerTab(
    row.activeViewerTab,
    openViewerTabsEarly,
    typeof row.selectedPath === 'string' ? row.selectedPath : null,
  );
  const previewTabIdsEarly = previewTabsEarly.map((t) => t.id);
  const rightPaneSplitEarly = normalizeRightPaneSplit(
    row.rightPaneSplit,
    normalizeRightPaneMode(row.rightPaneMode, viewerOpenLegacy, previewSource, false),
    activeViewerTabEarly,
    activePreviewTabEarly,
    openViewerTabsEarly,
    previewTabIdsEarly,
  );
  const rightPaneMode = normalizeRightPaneMode(
    row.rightPaneMode,
    viewerOpenLegacy,
    previewSource,
    rightPaneSplitEarly.enabled,
  );
  const viewerOpen = rightPaneMode !== null;
  const selectedPath = typeof row.selectedPath === 'string' ? row.selectedPath : null;
  const openViewerTabs = normalizeViewerTabPaths(row.openViewerTabs);
  const legacySelected =
    selectedPath &&
    !selectedPath.startsWith('.minnow/attachments/') &&
    openViewerTabs.length === 0 &&
    rightPaneMode !== 'preview'
      ? [selectedPath.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\.\//, '')]
      : openViewerTabs;
  const tabs =
    legacySelected.length > openViewerTabs.length ? legacySelected.slice(0, MAX_OPEN_VIEWER_TABS) : openViewerTabs;
  const activeViewerTab = normalizeActiveViewerTab(
    row.activeViewerTab,
    tabs,
    rightPaneMode === 'preview' ? null : selectedPath,
  );
  const previewTabs = normalizePreviewTabs(row.previewTabs, previewSource);
  const activePreviewTab = normalizeActivePreviewTab(row.activePreviewTab, previewTabs);
  const syncedPreviewSource =
    activePreviewTab
      ? (previewTabs.find((t) => t.id === activePreviewTab)?.source ?? previewSource)
      : previewSource;
  const syncedSelected = activeViewerTab ?? selectedPath;
  return {
    fileSidebarCollapsed: row.fileSidebarCollapsed === true,
    fileSidebarWidth:
      typeof row.fileSidebarWidth === 'number'
        ? clampFileSidebarWidth(row.fileSidebarWidth)
        : undefined,
    viewerOpen,
    rightPaneMode,
    rightPaneCollapsed: rightPaneMode !== null && row.rightPaneCollapsed === true,
    previewSource: syncedPreviewSource,
    previewAutoReload: row.previewAutoReload !== false,
    previewDevToolsDock:
      row.previewDevToolsDock === 'side'
        ? 'side'
        : row.previewDevToolsDock === 'popout'
          ? 'popout'
          : 'bottom',
    splitRatio: clampSplitRatio(
      typeof row.splitRatio === 'number' ? row.splitRatio : DEFAULT_FILE_PANEL_STATE.splitRatio,
    ),
    expandedDirs,
    selectedPath: syncedSelected,
    openViewerTabs: tabs,
    activeViewerTab,
    previewTabs,
    activePreviewTab,
    recentViewerFilesByWorkspace: normalizeRecentViewerFilesByWorkspace(
      row.recentViewerFilesByWorkspace,
    ),
    treeRoot: typeof row.treeRoot === 'string' && row.treeRoot.trim() ? row.treeRoot : '.',
    rightPaneSplit: normalizeRightPaneSplit(
      row.rightPaneSplit,
      rightPaneMode,
      activeViewerTab,
      activePreviewTab,
      tabs,
      previewTabs.map((t) => t.id),
    ),
  };
}

/**
 * Row key for this workspace, or `''` when no folder is bound yet (a window
 * still at the workspace gate). It used to fall back to `'__default__'`, which
 * the server ran through `path.resolve()` and stored as `<cwd>/__default__` —
 * a junk row that no reader ever looks up again.
 */
function workspacePanelKey(workspacePath?: string): string {
  return normalizeWorkspacePath(workspacePath ?? getWorkspacePath());
}

function resolveFilePanelRaw(
  meta: Record<string, unknown>,
  workspaceKey: string,
): unknown {
  const workspace = meta.workspace;
  if (workspace && typeof workspace === 'object') {
    const byPath = (workspace as Record<string, unknown>).filePanelByPath;
    if (byPath && typeof byPath === 'object') {
      // Loose match: the server rewrites the key with its own normalizer, so an
      // exact lookup never finds the row this client just wrote.
      const row = readWorkspaceMapRow(byPath as Record<string, unknown>, workspaceKey);
      if (row && typeof row === 'object') {
        return row;
      }
    }
  }
  return meta.filePanel;
}

async function fetchFilePanelFromMeta(workspaceKey?: string): Promise<FilePanelState> {
  const res = await fetch('/api/config/meta', { cache: 'no-store' });
  if (!res.ok) {
    return { ...DEFAULT_FILE_PANEL_STATE };
  }
  const meta = (await res.json()) as Record<string, unknown>;
  const key = workspaceKey ?? workspacePanelKey();
  panelWorkspaceKey = key;
  return normalizeFilePanelBlock(resolveFilePanelRaw(meta, key));
}

// ── State ────────────────────────────────────────────────────────────────────

/** Current file panel state (mutate via patch helpers). */
export function getFilePanelState(): FilePanelState {
  return panelState;
}

/** Replace in-memory state (e.g. after load). */
export function setFilePanelState(next: FilePanelState): void {
  const rightPaneMode = next.rightPaneMode ?? (next.viewerOpen ? 'viewer' : null);
  panelState = {
    ...next,
    rightPaneMode,
    viewerOpen: rightPaneMode !== null,
    splitRatio: clampSplitRatio(next.splitRatio),
    fileSidebarWidth:
      next.fileSidebarWidth !== undefined
        ? clampFileSidebarWidth(next.fileSidebarWidth)
        : next.fileSidebarWidth,
    expandedDirs: [...next.expandedDirs],
    openViewerTabs: [...next.openViewerTabs],
    previewTabs: [...next.previewTabs],
    recentViewerFilesByWorkspace: cloneRecentViewerFilesByWorkspace(
      next.recentViewerFilesByWorkspace ?? {},
    ),
    rightPaneSplit: next.rightPaneSplit
      ? cloneRightPaneSplit(next.rightPaneSplit)
      : panelState.rightPaneSplit,
  };
}

function cloneSlotPaneTabs(tabs: SlotPaneTabs | undefined): SlotPaneTabs {
  if (!tabs) return { ...EMPTY_SLOT_PANE_TABS };
  return {
    ...tabs,
    viewerPaths: [...(tabs.viewerPaths ?? [])],
    previewIds: [...(tabs.previewIds ?? [])],
  };
}

/** Deep-copy a split state, tolerating callers/prefs that predate the slot tab lists. */
function cloneRightPaneSplit(split: RightPaneSplitState): RightPaneSplitState {
  return {
    ...split,
    primary: { ...split.primary },
    secondary: { ...split.secondary },
    primaryTabs: cloneSlotPaneTabs(split.primaryTabs),
    secondaryTabs: cloneSlotPaneTabs(split.secondaryTabs),
  };
}

/** Merge partial state and schedule persistence. */
export function patchFilePanelState(partial: Partial<FilePanelState>): FilePanelState {
  const merged = {
    ...panelState,
    ...partial,
    splitRatio:
      partial.splitRatio !== undefined
        ? clampSplitRatio(partial.splitRatio)
        : panelState.splitRatio,
    fileSidebarWidth:
      partial.fileSidebarWidth !== undefined
        ? clampFileSidebarWidth(partial.fileSidebarWidth)
        : panelState.fileSidebarWidth,
    expandedDirs:
      partial.expandedDirs !== undefined
        ? [...partial.expandedDirs]
        : panelState.expandedDirs,
    openViewerTabs:
      partial.openViewerTabs !== undefined
        ? [...partial.openViewerTabs]
        : panelState.openViewerTabs,
    previewTabs:
      partial.previewTabs !== undefined ? [...partial.previewTabs] : panelState.previewTabs,
    recentViewerFilesByWorkspace:
      partial.recentViewerFilesByWorkspace !== undefined
        ? cloneRecentViewerFilesByWorkspace(partial.recentViewerFilesByWorkspace)
        : cloneRecentViewerFilesByWorkspace(panelState.recentViewerFilesByWorkspace),
    rightPaneSplit:
      partial.rightPaneSplit !== undefined
        ? cloneRightPaneSplit(partial.rightPaneSplit)
        : panelState.rightPaneSplit,
  };
  const splitEnabled = merged.rightPaneSplit.enabled;
  const rightPaneMode =
    partial.rightPaneMode !== undefined
      ? partial.rightPaneMode === 'split' && !splitEnabled
        ? merged.openViewerTabs.length > 0
          ? 'viewer'
          : merged.previewTabs.length > 0
            ? 'preview'
            : null
        : partial.rightPaneMode
      : splitEnabled
        ? 'split'
        : partial.viewerOpen === true
          ? merged.rightPaneMode === 'preview'
            ? 'preview'
            : 'viewer'
          : partial.viewerOpen === false
            ? null
            : merged.rightPaneMode === 'split' && !splitEnabled
              ? merged.openViewerTabs.length > 0
                ? 'viewer'
                : merged.previewTabs.length > 0
                  ? 'preview'
                  : null
              : merged.rightPaneMode;
  panelState = {
    ...merged,
    rightPaneMode,
    viewerOpen: rightPaneMode !== null,
  };
  scheduleSaveFilePanelPrefs();
  return panelState;
}

// ── Persist ──────────────────────────────────────────────────────────────────

function scheduleSaveFilePanelPrefs(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void saveFilePanelPrefs();
  }, SAVE_DEBOUNCE_MS);
}

/** Load prefs from ~/.minnow/config.json when config server is up. */
export async function loadFilePanelPrefs(): Promise<FilePanelState> {
  const serverUp = await detectConfigServer();
  if (serverUp) {
    panelState = await fetchFilePanelFromMeta();
  } else {
    panelState = { ...DEFAULT_FILE_PANEL_STATE };
  }
  return panelState;
}

/** Persist current state to meta API (scoped to the active workspace). */
export async function saveFilePanelPrefs(): Promise<void> {
  const serverUp = await detectConfigServer();
  if (!serverUp) return;

  const key = panelWorkspaceKey || workspacePanelKey();
  // No folder bound yet (workspace gate): there is nothing to scope the row to.
  if (!key) return;
  panelWorkspaceKey = key;
  await fetch('/api/config/meta', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workspace: { filePanelByPath: { [key]: panelState } },
    }),
  });
}

/** Save panel state under a specific workspace key (used before workspace switches). */
export async function persistFilePanelForWorkspace(workspacePath: string): Promise<void> {
  const serverUp = await detectConfigServer();
  if (!serverUp) return;
  const key = workspacePanelKey(workspacePath);
  if (!key) return;
  await fetch('/api/config/meta', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workspace: { filePanelByPath: { [key]: panelState } },
    }),
  });
}

/** Load persisted panel state for a workspace after a switch. */
export async function reloadFilePanelForWorkspace(workspacePath: string): Promise<FilePanelState> {
  const key = workspacePanelKey(workspacePath);
  panelWorkspaceKey = key;
  const serverUp = await detectConfigServer();
  if (serverUp) {
    panelState = await fetchFilePanelFromMeta(key);
  } else {
    panelState = { ...DEFAULT_FILE_PANEL_STATE };
  }
  return panelState;
}

/** Test helper: reset module state. */
export function resetFilePanelStateForTests(): void {
  panelState = { ...DEFAULT_FILE_PANEL_STATE };
  panelWorkspaceKey = '';
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
}

/** Test helper: parse a raw filePanel block like the meta API. */
export function normalizeFilePanelBlockForTests(raw: unknown): FilePanelState {
  return normalizeFilePanelBlock(raw);
}
