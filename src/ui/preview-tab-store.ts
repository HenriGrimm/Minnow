import { randomUUID } from '../lib/random-id.ts';
import {
  getFilePanelState,
  patchFilePanelState,
  type PreviewSource,
} from '../state/file-panel';
import { recordBrowserTitle, recordBrowserVisit } from './browser-history';

export const MAX_PREVIEW_TABS = 6;

export interface PreviewTabState {
  id: string;
  source: PreviewSource | null;
  title: string;
  loading: boolean;
  loadFailed?: { errorCode: number; errorDescription: string };
  guestCrashed?: { reason: string; exitCode: number };
  createdAt: number;
}

export type OpenPreviewTabResult =
  | { tab: PreviewTabState; evictedId?: string }
  | { tab: null; atLimit: true; evictedId?: string };

type TabStoreListener = () => void;

const tabs = new Map<string, PreviewTabState>();
let tabOrder: string[] = [];
let activeTabId: string | null = null;
const listeners = new Set<TabStoreListener>();

function emitChange(): void {
  for (const fn of listeners) {
    fn();
  }
}

function titleFromSource(source: PreviewSource | null): string {
  if (!source) return 'New tab';
  if (source.kind === 'workspace') {
    const parts = source.path.split('/').filter(Boolean);
    return parts[parts.length - 1] ?? source.path;
  }
  try {
    return new URL(source.url).host || source.url;
  } catch {
    return source.url;
  }
}

function createTabState(source?: PreviewSource | null): PreviewTabState {
  return {
    id: randomUUID(),
    source: source ?? null,
    title: titleFromSource(source ?? null),
    loading: false,
    createdAt: Date.now(),
  };
}

function persistPreviewTabs(): void {
  const serialized = tabOrder.map((id) => {
    const tab = tabs.get(id);
    return tab ? { id: tab.id, source: tab.source } : null;
  }).filter((row): row is { id: string; source: PreviewSource | null } => row !== null);

  patchFilePanelState({
    previewTabs: serialized,
    activePreviewTab: activeTabId,
    previewSource: activeTabId ? tabs.get(activeTabId)?.source ?? null : null,
  });
}

/** Subscribe to preview tab list / active tab changes. */
export function onPreviewTabStoreChange(listener: TabStoreListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function listPreviewTabs(): PreviewTabState[] {
  return tabOrder
    .map((id) => tabs.get(id))
    .filter((t): t is PreviewTabState => t !== undefined);
}

export function getPreviewTab(id: string): PreviewTabState | undefined {
  return tabs.get(id);
}

export function getActivePreviewTab(): PreviewTabState | null {
  if (!activeTabId) return null;
  return tabs.get(activeTabId) ?? null;
}

export function getActivePreviewTabId(): string | null {
  return activeTabId;
}

export function openPreviewTab(source?: PreviewSource | null): PreviewTabState | null {
  const result = openPreviewTabWithCapacity(source);
  return result.tab;
}

function sourceUrl(source: PreviewSource | null | undefined): string | null {
  return source?.kind === 'url' ? source.url : null;
}

function insertPreviewTab(source?: PreviewSource | null): PreviewTabState {
  const tab = createTabState(source);
  const url = sourceUrl(source);
  if (url) recordBrowserVisit(url);
  tabs.set(tab.id, tab);
  tabOrder.push(tab.id);
  activeTabId = tab.id;
  emitChange();
  persistPreviewTabs();
  return tab;
}

/** Oldest non-active tab (for eviction when MAX_PREVIEW_TABS is reached). */
export function findOldestBackgroundPreviewTab(): PreviewTabState | null {
  let oldest: PreviewTabState | null = null;
  for (const id of tabOrder) {
    if (id === activeTabId) continue;
    const tab = tabs.get(id);
    if (!tab) continue;
    if (!oldest || tab.createdAt < oldest.createdAt) {
      oldest = tab;
    }
  }
  return oldest;
}

/** Open a tab when below capacity, or return the oldest background tab to evict first. */
export function openPreviewTabWithCapacity(
  source?: PreviewSource | null,
  options?: { evict?: boolean },
): OpenPreviewTabResult {
  if (tabOrder.length < MAX_PREVIEW_TABS) {
    return { tab: insertPreviewTab(source) };
  }

  if (options?.evict === false) {
    return { tab: null, atLimit: true };
  }

  const victim = findOldestBackgroundPreviewTab();
  if (!victim) {
    return { tab: null, atLimit: true };
  }

  return { tab: null, atLimit: true, evictedId: victim.id };
}

export function activatePreviewTab(id: string): boolean {
  if (!tabs.has(id)) return false;
  activeTabId = id;
  emitChange();
  persistPreviewTabs();
  return true;
}

export function closePreviewTab(id: string): void {
  if (!tabs.has(id)) return;
  tabs.delete(id);
  tabOrder = tabOrder.filter((tid) => tid !== id);
  if (activeTabId === id) {
    activeTabId = tabOrder[tabOrder.length - 1] ?? null;
  }
  emitChange();
  persistPreviewTabs();
}

export function reorderPreviewTab(id: string, toIndex: number): void {
  const fromIndex = tabOrder.indexOf(id);
  if (fromIndex < 0) return;
  const clamped = Math.max(0, Math.min(toIndex, tabOrder.length - 1));
  if (fromIndex === clamped) return;
  tabOrder.splice(fromIndex, 1);
  tabOrder.splice(clamped, 0, id);
  emitChange();
  persistPreviewTabs();
}

export function updatePreviewTabSource(id: string, source: PreviewSource | null): void {
  const tab = tabs.get(id);
  if (!tab) return;
  const nextUrl = sourceUrl(source);
  // Same URL again (address-bar load then its navigation event, reloads) is one visit.
  if (nextUrl && nextUrl !== sourceUrl(tab.source)) recordBrowserVisit(nextUrl);
  tab.source = source;
  if (!tab.title || tab.title === 'New tab') {
    tab.title = titleFromSource(source);
  }
  emitChange();
  if (id === activeTabId) {
    persistPreviewTabs();
  }
}

export function setPreviewTabTitle(id: string, title: string): void {
  const tab = tabs.get(id);
  if (!tab || !title.trim()) return;
  tab.title = title.trim();
  const url = sourceUrl(tab.source);
  if (url) recordBrowserTitle(url, tab.title);
  emitChange();
}

export function setPreviewTabLoading(id: string, loading: boolean): void {
  const tab = tabs.get(id);
  if (!tab) return;
  tab.loading = loading;
  emitChange();
}

export function setPreviewTabLoadFailed(
  id: string,
  detail: { errorCode: number; errorDescription: string } | undefined,
): void {
  const tab = tabs.get(id);
  if (!tab) return;
  tab.loadFailed = detail;
  emitChange();
}

export function setPreviewTabGuestCrashed(
  id: string,
  detail: { reason: string; exitCode: number } | undefined,
): void {
  const tab = tabs.get(id);
  if (!tab) return;
  tab.guestCrashed = detail;
  tab.loading = false;
  if (detail) {
    tab.loadFailed = undefined;
  }
  emitChange();
}

/** Ensure at least one tab exists (blank when empty). */
export function ensureDefaultPreviewTab(): PreviewTabState {
  if (tabOrder.length > 0 && activeTabId && tabs.has(activeTabId)) {
    return tabs.get(activeTabId)!;
  }
  const existing = tabOrder[0] ? tabs.get(tabOrder[0]) : undefined;
  if (existing) {
    activeTabId = existing.id;
    emitChange();
    return existing;
  }
  return openPreviewTab(null)!;
}

/** Restore tab strip from persisted prefs (lazy guest load on activation). */
export function restorePreviewTabs(
  rows: { id: string; source: PreviewSource | null }[],
  activeId: string | null,
): void {
  tabs.clear();
  tabOrder = [];
  for (const row of rows.slice(0, MAX_PREVIEW_TABS)) {
    if (!row.id) continue;
    const tab: PreviewTabState = {
      id: row.id,
      source: row.source,
      title: titleFromSource(row.source),
      loading: false,
      createdAt: Date.now(),
    };
    tabs.set(tab.id, tab);
    tabOrder.push(tab.id);
  }
  if (tabOrder.length === 0) {
    openPreviewTab(null);
    return;
  }
  activeTabId =
    activeId && tabs.has(activeId)
      ? activeId
      : tabOrder[tabOrder.length - 1]!;
  emitChange();
}

/** Migrate legacy single previewSource into one tab. */
export function migrateLegacyPreviewSource(source: PreviewSource | null): void {
  if (tabOrder.length > 0) return;
  openPreviewTab(source);
}

/** Test helper: reset in-memory preview tab store. */
export function resetPreviewTabStoreForTests(): void {
  tabs.clear();
  tabOrder = [];
  activeTabId = null;
  listeners.clear();
}
