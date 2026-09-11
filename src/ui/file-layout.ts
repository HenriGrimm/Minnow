import { ICON_FILE_TREE } from '../constants';
import {
  getFilePanelState,
  patchFilePanelState,
  type PaneSlotId,
  type RightPaneMode,
} from '../state/file-panel';
import { syncStatsStripLayoutForViewer } from './stats';
import { mountOsMobileDrawerBackdrops, syncOsMobileDrawerHtmlClass } from './mobile-drawer-portal';
import {
  syncAppBodySidebarWidthVars,
  syncFileSidebarResizer,
} from './sidebar-resize';
import {
  applyRightPaneSplitDom,
  isRightPaneSplitActive,
  isRightPaneSplitLayoutEnabled,
} from './right-pane-split';
import { isNarrowLayout } from './mobile-layout';

let chatColumnDragCollapsed = false;

const PREVIEW_FULL_WIDTH_BUTTON_IDS = [
  'btnPreviewFullWidth',
  'btnPreviewFullWidthSecondary',
] as const;

export function isMobileLayout(): boolean {
  return isNarrowLayout();
}

const RIGHT_PANE_CHILD_IDS = [
  'fileViewerPane',
  'previewPane',
  'fileViewerPaneSecondary',
  'previewPaneSecondary',
] as const;

/** MIN-224: viewer/preview panes must live inside #rightPaneColumn (below #unifiedTabs). */
export function repairRightPaneDomStructure(): boolean {
  const column = document.getElementById('rightPaneColumn');
  const split = document.getElementById('workspaceSplit');
  if (!column || !split) return false;

  let repaired = false;
  for (const paneId of RIGHT_PANE_CHILD_IDS) {
    const pane = document.getElementById(paneId);
    if (pane?.parentElement === split) {
      column.appendChild(pane);
      repaired = true;
    }
  }

  const primarySlot = document.getElementById('rightPaneSlotPrimary');
  if (primarySlot) {
    for (const paneId of ['fileViewerPane', 'previewPane'] as const) {
      const pane = document.getElementById(paneId);
      if (pane?.parentElement === column) {
        primarySlot.appendChild(pane);
        repaired = true;
      }
    }
  }

  return repaired;
}

/** Close source control when the file sidebar is collapsed or dismissed. */
function closeGitPanelIfOpen(): void {
  void import('./git-panel').then((m) => {
    if (m.isGitSidePanelOpen()) m.closeGitSidePanel();
  });
}

/** Clear mobile drawer classes without closing source control (safe during layout refresh). */
export function clearMobileFileSidebarOverlay(): void {
  const side = document.getElementById('fileSidebar');
  const bd = document.getElementById('fileSidebarBackdrop');
  if (side) side.classList.remove('mobile-open');
  syncOsMobileDrawerHtmlClass('file', false);
  if (bd) {
    bd.classList.remove('open');
    bd.setAttribute('aria-hidden', 'true');
    (bd as HTMLButtonElement).tabIndex = -1;
  }
}

export function closeMobileFileSidebar(): void {
  clearMobileFileSidebarOverlay();
  closeGitPanelIfOpen();
}

export function openMobileFileSidebar(): void {
  if (!isMobileLayout()) return;
  mountOsMobileDrawerBackdrops();
  const side = document.getElementById('fileSidebar');
  const bd = document.getElementById('fileSidebarBackdrop');
  if (side) side.classList.add('mobile-open');
  syncOsMobileDrawerHtmlClass('file', true);
  if (bd) {
    bd.classList.add('open');
    bd.setAttribute('aria-hidden', 'false');
    (bd as HTMLButtonElement).tabIndex = 0;
  }
}

function resolvedRightPaneMode(): RightPaneMode {
  const state = getFilePanelState();
  if (
    state.rightPaneMode === 'preview' ||
    state.rightPaneMode === 'viewer' ||
    state.rightPaneMode === 'split'
  ) {
    return state.rightPaneMode;
  }
  return state.viewerOpen ? 'viewer' : null;
}

/** True when the right split column is visible in the DOM. */
function isRightPaneColumnDomVisible(): boolean {
  const column = document.getElementById('rightPaneColumn');
  return Boolean(column && !column.classList.contains('hidden'));
}

/** True when the preview or viewer content pane is visible. */
function isRightPaneDomVisible(mode: Exclude<RightPaneMode, null>): boolean {
  const paneId = mode === 'preview' ? 'previewPane' : 'fileViewerPane';
  const pane = document.getElementById(paneId);
  return Boolean(pane && !pane.classList.contains('hidden'));
}

function isRightSplitOpen(): boolean {
  const mode = resolvedRightPaneMode();
  if (mode === null) return false;
  return isRightPaneColumnDomVisible();
}

function showRightPaneColumnDom(): void {
  document.getElementById('rightPaneColumn')?.classList.remove('hidden');
  document.getElementById('splitResizer')?.classList.remove('hidden');
}

function hideRightPaneColumnDom(): void {
  document.getElementById('rightPaneColumn')?.classList.add('hidden');
  document.getElementById('splitResizer')?.classList.add('hidden');
}

/** Hide preview, viewer, and resizer DOM without changing persisted prefs. */
export function hideAllRightSplitPanesDom(): void {
  hidePreviewPaneDom();
  hideViewerPaneDom();
  hideRightPaneColumnDom();
  void window.minnow?.preview?.hide();
}

/** Unhide the pane matching persisted rightPaneMode when state and DOM diverge (e.g. reload applied viewer-open before preview restore, or Code foreground). */
export function reconcileRightSplitDomWithState(): void {
  repairRightPaneDomStructure();
  const mode = resolvedRightPaneMode();
  if (mode === null) {
    hideAllRightSplitPanesDom();
    return;
  }
  showRightPaneColumnDom();

  if (mode === 'split' && isRightPaneSplitActive()) {
    applyRightPaneSplitDom();
    return;
  }

  if (mode === 'preview') {
    hideViewerPaneDom();
    document.getElementById('fileViewerPaneSecondary')?.classList.add('hidden');
    if (!isRightPaneDomVisible('preview')) {
      document.getElementById('previewPane')?.classList.remove('hidden');
      schedulePreviewGuestResyncAfterReconcile();
    }
    document.getElementById('previewPaneSecondary')?.classList.add('hidden');
    return;
  }

  if (mode === 'viewer' || mode === 'split') {
    hidePreviewPaneDom();
    document.getElementById('previewPaneSecondary')?.classList.add('hidden');
    void window.minnow?.preview?.hide();
    if (!isRightPaneDomVisible('viewer')) {
      document.getElementById('fileViewerPane')?.classList.remove('hidden');
    }
    if (mode !== 'split') {
      document.getElementById('fileViewerPaneSecondary')?.classList.add('hidden');
    }
  }
}

/** Sync Electron preview guest bounds after workspace split geometry changes. */
function scheduleElectronPreviewHostLayoutAfterSplitChange(): void {
  const mode = getFilePanelState().rightPaneMode;
  if (mode !== 'preview' && mode !== 'split') return;
  if (!window.minnow?.preview) return;
  void import('./preview-electron-visibility').then((m) => {
    m.scheduleElectronPreviewHostLayoutSync();
    m.scheduleSecondaryPreviewHostLayoutSync?.();
  });
}

/** Re-show Chromium guest + reload source after reconcile unhides the preview pane. */
function schedulePreviewGuestResyncAfterReconcile(): void {
  if (getFilePanelState().rightPaneMode !== 'preview') return;
  if (!window.minnow?.preview) return;
  void import('./preview-panel').then((m) => {
    m.resyncOpenPreviewPanelFromState({ reload: true });
  });
}

function refreshUnifiedTabsIfPresent(): void {
  if (!document.getElementById('unifiedTabs')) return;
  void import('./unified-right-tabs').then((m) => m.refreshUnifiedRightTabs());
}

/** Sync the Files pane button: always the folder glyph, highlighted when the files view is the active left pane (MIN-655). */
export function syncFileSidebarFilesPaneButton(options?: { gitOpen?: boolean }): void {
  const side = document.getElementById('fileSidebar');
  const btn = document.getElementById('btnFileSidebarCollapse');
  if (!side || !btn) return;

  const gitOpen = options?.gitOpen ?? side.classList.contains('file-sidebar--git');
  const mobile = isMobileLayout();
  const mobileOpen = side.classList.contains('mobile-open');
  const collapsed = mobile
    ? !mobileOpen
    : side.classList.contains('collapsed') || getFilePanelState().fileSidebarCollapsed;

  btn.innerHTML = ICON_FILE_TREE;

  const filesActive = !collapsed && !gitOpen;
  let label: string;
  if (gitOpen) {
    label = 'Show file tree';
  } else if (mobile) {
    label = mobileOpen ? 'Close file tree' : 'Open file tree';
  } else {
    label = collapsed ? 'Expand file tree' : 'Collapse file tree';
  }

  btn.classList.toggle('is-active', filesActive);
  btn.setAttribute('aria-pressed', filesActive ? 'true' : 'false');
  btn.setAttribute('aria-label', label);
  btn.setAttribute('title', label);
}

/** Apply collapsed rail, mobile overlay, and split ratio CSS variables. */
export function applyFileSidebarVisuals(): void {
  reconcileRightSplitDomWithState();
  applyRightPaneSplitDom();

  const side = document.getElementById('fileSidebar');
  const btn = document.getElementById('btnFileSidebarCollapse');
  const state = getFilePanelState();
  const split = document.getElementById('workspaceSplit');
  const splitOpen = isRightSplitOpen();

  if (split) {
    split.classList.toggle('viewer-open', splitOpen);
    split.classList.toggle('chat-column-collapsed', chatColumnDragCollapsed && splitOpen);
    split.style.setProperty('--split-ratio', String(state.splitRatio));
    syncStatsStripLayoutForViewer(splitOpen);
  }
  syncPreviewFullWidthButtons();
  scheduleElectronPreviewHostLayoutAfterSplitChange();
  refreshUnifiedTabsIfPresent();

  if (!side || !btn) return;

  if (isMobileLayout()) {
    mountOsMobileDrawerBackdrops();
    syncOsMobileDrawerHtmlClass('file', side.classList.contains('mobile-open'));
  } else {
    syncOsMobileDrawerHtmlClass('file', false);
  }

  if (!isMobileLayout()) {
    clearMobileFileSidebarOverlay();
    side.classList.toggle('collapsed', state.fileSidebarCollapsed);
  } else {
    side.classList.toggle('collapsed', state.fileSidebarCollapsed);
  }

  syncFileSidebarFilesPaneButton();

  const previewBtn = document.getElementById('btnPreviewToggle');
  if (previewBtn) {
    const previewOpen =
      state.rightPaneMode === 'preview' ||
      (state.rightPaneMode === 'split' &&
        (state.rightPaneSplit.primary.kind === 'preview' ||
          state.rightPaneSplit.secondary.kind === 'preview'));
    previewBtn.classList.toggle('is-active', previewOpen);
    previewBtn.setAttribute('aria-pressed', previewOpen ? 'true' : 'false');
  }

  syncAppBodySidebarWidthVars();
  syncFileSidebarResizer();
  if (state.rightPaneMode === 'preview' || state.rightPaneMode === 'split') {
    scheduleElectronPreviewHostLayoutAfterSplitChange();
  }
}

/** Files pane control: switch back from Source Control, else toggle collapse / mobile overlay (MIN-655). */
export async function toggleFileSidebarLayout(): Promise<void> {
  const git = await import('./git-panel');

  if (git.isGitSidePanelOpen()) {
    git.closeGitSidePanel();
    if (isMobileLayout()) {
      openMobileFileSidebar();
    } else if (getFilePanelState().fileSidebarCollapsed) {
      patchFilePanelState({ fileSidebarCollapsed: false });
    }
    applyFileSidebarVisuals();
    return;
  }

  if (isMobileLayout()) {
    const side = document.getElementById('fileSidebar');
    if (side && side.classList.contains('mobile-open')) {
      closeMobileFileSidebar();
    } else {
      openMobileFileSidebar();
    }
    applyFileSidebarVisuals();
    return;
  }

  const state = getFilePanelState();
  const nextCollapsed = !state.fileSidebarCollapsed;
  patchFilePanelState({ fileSidebarCollapsed: nextCollapsed });
  if (nextCollapsed) closeGitPanelIfOpen();
  applyFileSidebarVisuals();
}

export function toggleFileSidebarCollapsed(): void {
  if (isMobileLayout()) {
    closeMobileFileSidebar();
    applyFileSidebarVisuals();
    return;
  }
  const state = getFilePanelState();
  const nextCollapsed = !state.fileSidebarCollapsed;
  patchFilePanelState({ fileSidebarCollapsed: nextCollapsed });
  if (nextCollapsed) closeGitPanelIfOpen();
  applyFileSidebarVisuals();
}

/** Collapse the file sidebar (or dismiss the mobile drawer). No-op when already collapsed. */
export function closeFileSidebar(): void {
  if (isMobileLayout()) {
    const side = document.getElementById('fileSidebar');
    if (side?.classList.contains('mobile-open')) {
      closeMobileFileSidebar();
      applyFileSidebarVisuals();
    }
    return;
  }
  if (!getFilePanelState().fileSidebarCollapsed) {
    patchFilePanelState({ fileSidebarCollapsed: true });
    closeGitPanelIfOpen();
    applyFileSidebarVisuals();
  }
}

/** Hide preview pane DOM only (does not change persisted split state). */
export function hidePreviewPaneDom(): void {
  const previewPane = document.getElementById('previewPane');
  if (previewPane) previewPane.classList.add('hidden');
}

/** Hide file viewer pane DOM only (does not change persisted split state). */
export function hideViewerPaneDom(): void {
  const pane = document.getElementById('fileViewerPane');
  if (pane) pane.classList.add('hidden');
}

/** When closing the active pane type, fall back to the other tab family if any remain. */
function fallbackRightPaneModeAfterClose(closedMode: Exclude<RightPaneMode, null>): RightPaneMode | null {
  const state = getFilePanelState();
  if (closedMode === 'viewer' && state.previewTabs.length > 0) return 'preview';
  if (closedMode === 'preview' && state.openViewerTabs.length > 0) return 'viewer';
  return null;
}

/** Show split viewer pane; keeps preview tabs in the unified strip. */
export function showViewerSplit(): void {
  if (!isRightSplitOpen()) clearChatColumnDragCollapsed();
  const state = getFilePanelState();
  if (state.rightPaneMode === 'split' && state.rightPaneSplit.enabled) {
    patchFilePanelState({ viewerOpen: true, rightPaneMode: 'split' });
    applyFileSidebarVisuals();
    return;
  }
  hidePreviewPaneDom();
  void window.minnow?.preview?.hide();
  showRightPaneColumnDom();
  const pane = document.getElementById('fileViewerPane');
  if (pane) pane.classList.remove('hidden');
  patchFilePanelState({ rightPaneMode: 'viewer', viewerOpen: true });
  applyFileSidebarVisuals();
}

/** Hide split viewer pane; switches to preview tabs when available. */
export function hideViewerSplit(options?: { skipPreviewFallback?: boolean }): void {
  if (getFilePanelState().rightPaneMode === 'preview') {
    hideViewerPaneDom();
    applyFileSidebarVisuals();
    return;
  }

  const fallback = options?.skipPreviewFallback
    ? null
    : fallbackRightPaneModeAfterClose('viewer');
  if (fallback === 'preview') {
    showPreviewSplit();
    return;
  }
  hideViewerPaneDom();
  hideRightPaneColumnDom();
  clearChatColumnDragCollapsed();
  patchFilePanelState({ rightPaneMode: null, viewerOpen: false });
  applyFileSidebarVisuals();
}

export type ShowPreviewSplitOptions = {
  tabId?: string | null;
  slot?: PaneSlotId;
};

/** Show preview pane; keeps file tabs in the unified strip. */
export function showPreviewSplit(_options?: ShowPreviewSplitOptions): void {
  if (!isRightSplitOpen()) clearChatColumnDragCollapsed();

  if (isRightPaneSplitLayoutEnabled()) {
    patchFilePanelState({ viewerOpen: true, rightPaneMode: 'split' });
    showRightPaneColumnDom();
    applyFileSidebarVisuals();
    scheduleElectronPreviewHostLayoutAfterSplitChange();
    return;
  }
  hideViewerPaneDom();
  showRightPaneColumnDom();
  patchFilePanelState({
    rightPaneMode: 'preview',
    viewerOpen: true,
  });
  const previewPane = document.getElementById('previewPane');
  if (previewPane) previewPane.classList.remove('hidden');
  applyFileSidebarVisuals();
  scheduleElectronPreviewHostLayoutAfterSplitChange();
}

/** Hide preview pane; switches to file tabs when available. */
export function hidePreviewSplit(): void {
  const fallback = fallbackRightPaneModeAfterClose('preview');
  if (fallback === 'viewer') {
    showViewerSplit();
    return;
  }
  hidePreviewPaneDom();
  void window.minnow?.preview?.hide();
  hideRightPaneColumnDom();
  clearChatColumnDragCollapsed();
  patchFilePanelState({ rightPaneMode: null, viewerOpen: false, previewSource: null });
  applyFileSidebarVisuals();
}

/** True when the user drag-collapsed the chat column for a full-width preview/viewer. */
export function isChatColumnDragCollapsed(): boolean {
  return chatColumnDragCollapsed;
}

function syncPreviewFullWidthButtons(): void {
  const label = chatColumnDragCollapsed
    ? 'Restore chat beside preview'
    : 'Expand preview to full width';
  for (const id of PREVIEW_FULL_WIDTH_BUTTON_IDS) {
    const button = document.getElementById(id);
    if (!button) continue;
    button.setAttribute('aria-pressed', chatColumnDragCollapsed ? 'true' : 'false');
    button.setAttribute('aria-label', label);
    button.setAttribute('title', label);
  }
}

/** Hide the chat column after dragging the split toward the preview pane. */
export function collapseChatColumnFromDrag(): void {
  if (!isRightSplitOpen()) return;
  chatColumnDragCollapsed = true;
  applyFileSidebarVisuals();
  scheduleElectronPreviewHostLayoutAfterSplitChange();
}

/** Restore the chat column after drag-collapse or when selecting a sidebar chat. */
export function restoreChatColumnFromDrag(): boolean {
  if (!chatColumnDragCollapsed) return false;
  chatColumnDragCollapsed = false;
  applyFileSidebarVisuals();
  scheduleElectronPreviewHostLayoutAfterSplitChange();
  return true;
}

/** Toggle the same full-width right-pane state used by split-handle drag collapse. */
export function toggleRightPaneFullWidth(): void {
  if (isChatColumnDragCollapsed()) {
    restoreChatColumnFromDrag();
    return;
  }
  collapseChatColumnFromDrag();
}

function clearChatColumnDragCollapsed(): void {
  chatColumnDragCollapsed = false;
}

/** Test helper — reset drag-collapse memory. */
export function resetChatColumnDragCollapsedForTests(): void {
  clearChatColumnDragCollapsed();
}

/** Close the preview split without clearing previewSource (MIN-342). */
export function hidePreviewSplitKeepSource(): void {
  hideAllRightSplitPanesDom();
  patchFilePanelState({ rightPaneMode: null, viewerOpen: false });
  applyFileSidebarVisuals();
}

/** Close both right split panes on Code entry while keeping previewSource and openViewerTabs for explicit reopen (MIN-342). */
export function resetRightSplitForCodeEntry(): void {
  hideAllRightSplitPanesDom();
  patchFilePanelState({ rightPaneMode: null, viewerOpen: false });
  applyFileSidebarVisuals();
}
