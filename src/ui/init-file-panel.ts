import '../styles/file-panel.css';
/* Material Icon Theme (PKief) — colorful file/folder glyphs for Code tree + tabs */
import '../styles/file-type-icons.css';
import '../styles/git-commit-diff.css';

import {
  getFilePanelState,
  loadFilePanelPrefs,
  patchFilePanelState,
} from '../state/file-panel';
import {
  applyFileSidebarVisuals,
  clearMobileFileSidebarOverlay,
  closeMobileFileSidebar,
  isMobileLayout,
  toggleFileSidebarCollapsed,
  toggleFileSidebarLayout,
  toggleRightPaneFullWidth,
} from './file-layout';
import { initFileTreeDnD } from './file-tree-dnd';
import {
  initFileTreeCrud,
  initFileTreeIfNeeded,
  invalidateFileTreeCache,
  refreshDirectories,
  refreshFileTree,
  renderFileTree,
} from './file-tree';
import { initFileTreeAutoRefreshInteractionTracking } from './file-tree-auto-refresh';
import { registerFileTreeRefreshBridge } from './file-tree-refresh-bridge';
import { setFileTreeServerAvailable } from './file-tree-server';
import {
  initFileTreeSearch,
  onFileTreeSearchServerChanged,
  registerFileTreeFilterRender,
  registerFileTreeServerCheck,
} from './file-tree-search';
import {
  bindFileViewerControls,
  bindFileViewerContextMenu,
  closeFileViewer,
  getOpenViewerTabPaths,
  openFileInViewer,
  renderViewerEmptyState,
  restoreViewerTabsFromPrefs,
} from './file-viewer';
import { bindFileViewerTabs } from './file-viewer-tabs';
import { isLocalServerAvailable } from '../tools/config';
import { getLocalServerAvailable } from '../tools/client';
import { refreshWorkspaceUi } from './workspace-button';
import { syncOrchestratePlanStripFromActiveChat } from './orchestrate-plan-selector';
import { syncViewModeToggleFromActiveChat } from './view-mode-toggle';
import { initGitPanel, syncPanelFromActiveChat } from './git-panel';
import { syncComposerRunTargetFromActiveChat } from './composer-run-target';
import { initSourceControlCenter } from './source-control-center-entry';
import { initGitHelpLightbox } from './git-help-lightbox';
import { startFileTreeGitStatusPoll } from './file-tree';
import {
  isCodeAppForeground,
  shouldAutoRestoreViewerSplitOnBoot,
} from './preview-restore-policy';
import { bindWorkspaceSplitResizer } from './workspace-split-resize';
import { bindRightPaneSplitResizer } from './right-pane-split-resize';
import {
  closeRightPaneSplit,
  focusPaneSlot,
  splitRightPane,
} from './right-pane-split';
import type { PaneSlotId } from '../state/file-panel';
import { bindSecondaryPreviewControls } from './preview-secondary-slot';
import { bindSecondaryPreviewDesignControls } from './preview-secondary-design';
import { sessionState } from '../state/sessions';

let resizerBound = false;

function bindSplitResizer(): void {
  if (resizerBound) return;
  resizerBound = true;
  bindWorkspaceSplitResizer();
  bindRightPaneSplitResizer();
}

function bindFilePanelControls(): void {
  const refreshBtn = document.getElementById('btnFileTreeRefresh');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      void refreshFileTree();
    });
  }

  const closeBtn = document.getElementById('btnFileViewerClose');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => closeFileViewer());
  }

  const splitBtn = document.getElementById('btnRightPaneSplit');
  if (splitBtn) {
    splitBtn.addEventListener('click', () => splitRightPane());
  }

  const previewSplitBtn = document.getElementById('btnPreviewPaneSplit');
  if (previewSplitBtn) {
    previewSplitBtn.addEventListener('click', () => splitRightPane());
  }

  for (const id of ['btnPreviewFullWidth', 'btnPreviewFullWidthSecondary']) {
    document.getElementById(id)?.addEventListener('click', () => {
      toggleRightPaneFullWidth();
    });
  }

  document.getElementById('btnFileViewerCloseSecondary')?.addEventListener('click', () => {
    closeRightPaneSplit();
  });
  document.getElementById('btnPreviewCloseSecondary')?.addEventListener('click', () => {
    closeRightPaneSplit();
  });

  const toggleBtn = document.getElementById('btnFileSidebarCollapse');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      void initFileTreeIfNeeded();
    });
  }

  window.addEventListener('keydown', (e) => {
    if (e.key !== '\\' || !(e.ctrlKey || e.metaKey)) return;
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    if (
      !target.closest(
        '#rightPaneSlotPrimary, #rightPaneSlotSecondary, #fileViewerHost, #previewBody',
      )
    ) {
      return;
    }
    e.preventDefault();
    splitRightPane();
  });

  bindPaneSlotFocusTracking();
}

/** Clicking or tabbing into a pane makes it the focused editor group, so the next file the user opens (and Ctrl+S / Ctrl+W) targets the pane they are looking at. */
function bindPaneSlotFocusTracking(): void {
  const slots: [string, PaneSlotId][] = [
    ['rightPaneSlotPrimary', 'primary'],
    ['rightPaneSlotSecondary', 'secondary'],
  ];
  for (const [id, slot] of slots) {
    const el = document.getElementById(id);
    if (!el) continue;
    const focus = (): void => {
      if (getFilePanelState().rightPaneSplit.focusedSlot === slot) return;
      focusPaneSlot(slot);
    };
    el.addEventListener('pointerdown', focus, true);
    el.addEventListener('focusin', focus);
  }
}

/** React to local server ping success/failure (after detectLocalServer). */
export function onFilePanelServerAvailabilityChanged(): void {
  setFileTreeServerAvailable(getLocalServerAvailable());
  onFileTreeSearchServerChanged();
  if (getLocalServerAvailable()) {
    if (typeof document !== 'undefined' && document.getElementById('fileTreeHost')) {
      void refreshFileTree();
    }
    if (!sessionState) return;
    void refreshWorkspaceUi();
    void syncOrchestratePlanStripFromActiveChat();
    syncViewModeToggleFromActiveChat();
    syncPanelFromActiveChat({ forceFileTree: true });
    syncComposerRunTargetFromActiveChat();
    startFileTreeGitStatusPoll();
  } else {
    renderFileTree();
  }
}

/** Initialize file panel after detectLocalServer(). */
export async function initFilePanel(): Promise<void> {
  registerFileTreeRefreshBridge({
    refresh: refreshFileTree,
    refreshDirectories,
    render: renderFileTree,
    invalidateCache: invalidateFileTreeCache,
  });

  await loadFilePanelPrefs();
  if (isCodeAppForeground()) {
    const { hideAllRightSplitPanesDom } = await import('./file-layout');
    hideAllRightSplitPanesDom();
    patchFilePanelState({ rightPaneMode: null, viewerOpen: false });
  }
  setFileTreeServerAvailable(getLocalServerAvailable());
  if (getLocalServerAvailable()) {
    void initFileTreeIfNeeded();
  }

  const { initPreviewPanel } = await import('./preview-panel');
  await initPreviewPanel();

  const state = getFilePanelState();
  if (shouldAutoRestoreViewerSplitOnBoot()) {
    // Persisted tabs are the one step here that reopens *files*, so it is the
    // one that can fail on paths this workspace does not have. Everything below
    // (viewer controls, tree CRUD, git panel, status poll) must still wire.
    try {
      if (state.openViewerTabs.length > 0) {
        await restoreViewerTabsFromPrefs(state.openViewerTabs, state.activeViewerTab);
      } else if (state.viewerOpen && state.selectedPath) {
        await openFileInViewer(state.selectedPath);
      }
    } catch (err) {
      console.error('[file-panel] could not restore persisted editor tabs', err);
    }
  }
  if (getOpenViewerTabPaths().length === 0) {
    renderViewerEmptyState();
  }

  applyFileSidebarVisuals();

  bindSplitResizer();
  bindFilePanelControls();
  bindSecondaryPreviewControls();
  bindSecondaryPreviewDesignControls();
  bindFileViewerControls();
  bindFileViewerTabs();
  bindFileViewerContextMenu();
  initFileTreeCrud();
  initFileTreeDnD();
  initFileTreeAutoRefreshInteractionTracking();
  registerFileTreeFilterRender(renderFileTree);
  registerFileTreeServerCheck(isLocalServerAvailable);
  initFileTreeSearch();

  initGitPanel();
  initSourceControlCenter();
  initGitHelpLightbox();
  if (getLocalServerAvailable()) {
    startFileTreeGitStatusPoll();
  }

  window.addEventListener('resize', () => {
    if (!isMobileLayout()) clearMobileFileSidebarOverlay();
    applyFileSidebarVisuals();
  });
}

export {
  applyFileSidebarVisuals,
  clearMobileFileSidebarOverlay,
  closeMobileFileSidebar,
  toggleFileSidebarCollapsed,
  toggleFileSidebarLayout,
};
