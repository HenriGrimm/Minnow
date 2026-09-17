import {
  EMPTY_SLOT_PANE_TABS,
  getFilePanelState,
  patchFilePanelState,
  type PaneSlotId,
  type SlotContent,
} from '../state/file-panel';
import { getOsView } from '../os/instances';
import { isMobileLayout } from './file-layout';
import {
  activePreviewIdForSlot,
  activeViewerPathForSlot,
  bootstrapSlotTabsOnSplitEnable,
  getSlotPaneTabs,
  isSlotEmpty,
  mergeSecondarySlotTabsIntoPrimary,
  reconcileSlotTabsWithStores,
  registerPreviewTabOpened,
  registerViewerTabOpened,
  slotContentFromTabs,
  slotOwningPreviewId,
  slotOwningViewerPath,
} from './right-pane-slot-tabs';
import { adoptActiveViewerTabPath, getActiveViewerTabPath } from './file-viewer-tab-store';
import { activatePreviewTab } from './preview-tab-store';

/** Same surface rule as the workspace gate (no floating desktop drawers). */
function isWorkspaceGateSurface(): boolean {
  return getOsView() === 'workspaces';
}

export const WORKSPACE_PREVIEW_SECONDARY_INSTANCE = 'workspace-preview-secondary';

export function isRightPaneSplitActive(): boolean {
  const state = getFilePanelState();
  return (
    state.rightPaneSplit.enabled &&
    !isMobileLayout() &&
    !isWorkspaceGateSurface()
  );
}

/** True when persisted state is split layout (ignores desktop hosting surface DOM guard). */
export function isRightPaneSplitLayoutEnabled(): boolean {
  const state = getFilePanelState();
  return state.rightPaneSplit.enabled && state.rightPaneMode === 'split' && !isMobileLayout();
}

export function getFocusedPaneSlot(): PaneSlotId {
  return getFilePanelState().rightPaneSplit.focusedSlot;
}

export function otherPaneSlot(slot: PaneSlotId): PaneSlotId {
  return slot === 'primary' ? 'secondary' : 'primary';
}

export function getSlotContent(slot: PaneSlotId): SlotContent {
  const split = getFilePanelState().rightPaneSplit;
  return slot === 'primary' ? split.primary : split.secondary;
}

export function getFocusedPreviewInstanceId(): string {
  if (!isRightPaneSplitActive()) return 'workspace-preview';
  const slot = getFocusedPaneSlot();
  const content = getSlotContent(slot);
  if (content.kind === 'preview') {
    return previewInstanceIdForSlot(slot);
  }
  const secondary = getSlotContent('secondary');
  if (secondary.kind === 'preview') return WORKSPACE_PREVIEW_SECONDARY_INSTANCE;
  return 'workspace-preview';
}

/** Instance id for a slot that is showing preview content. */
export function previewInstanceIdForSlot(slot: PaneSlotId): string {
  return slot === 'primary' ? 'workspace-preview' : WORKSPACE_PREVIEW_SECONDARY_INSTANCE;
}

function slotElements(slot: PaneSlotId): {
  slotEl: HTMLElement | null;
  viewerPane: HTMLElement | null;
  previewPane: HTMLElement | null;
} {
  const slotEl = document.getElementById(
    slot === 'primary' ? 'rightPaneSlotPrimary' : 'rightPaneSlotSecondary',
  );
  if (slot === 'primary') {
    return {
      slotEl,
      viewerPane: document.getElementById('fileViewerPane'),
      previewPane: document.getElementById('previewPane'),
    };
  }
  return {
    slotEl,
    viewerPane: document.getElementById('fileViewerPaneSecondary'),
    previewPane: document.getElementById('previewPaneSecondary'),
  };
}

/** Which surface the single (un-split) primary slot should show. */
function defaultPrimarySlotContent(): SlotContent {
  const state = getFilePanelState();
  if (state.rightPaneMode === 'preview') {
    return { kind: 'preview', tabId: state.activePreviewTab };
  }
  const path = state.activeViewerTab ?? getActiveViewerTabPath();
  if (path) return { kind: 'viewer', tabPath: path };
  if (state.activePreviewTab) {
    return { kind: 'preview', tabId: state.activePreviewTab };
  }
  return { kind: 'none' };
}

function syncSlotPaneVisibility(slot: PaneSlotId, content: SlotContent): void {
  const { slotEl, viewerPane, previewPane } = slotElements(slot);
  if (!slotEl) return;

  const showPreview = content.kind === 'preview';
  const showViewer = !showPreview;

  if (viewerPane) viewerPane.classList.toggle('hidden', !showViewer);
  if (previewPane) previewPane.classList.toggle('hidden', !showPreview);
}

/** Apply split chrome, slot visibility, and focus ring from persisted state. */
export function applyRightPaneSplitDom(): void {
  const state = getFilePanelState();
  const split = state.rightPaneSplit;
  // Collapsed right pane: leave every slot hidden instead of re-showing panes.
  if (state.rightPaneCollapsed === true && state.rightPaneMode !== null) return;
  const active = isRightPaneSplitActive();

  const wrapper = document.getElementById('rightPaneSplit');
  const resizer = document.getElementById('rightPaneSplitResizer');
  const secondarySlot = document.getElementById('rightPaneSlotSecondary');

  if (wrapper) {
    wrapper.classList.toggle('is-active', active);
    if (active) {
      wrapper.style.setProperty('--right-pane-split-ratio', String(split.ratio));
    }
  }
  if (resizer) resizer.classList.toggle('hidden', !active);
  if (secondarySlot) secondarySlot.classList.toggle('hidden', !active);

  const primarySlot = document.getElementById('rightPaneSlotPrimary');
  if (primarySlot) {
    primarySlot.classList.toggle('is-focused', active && split.focusedSlot === 'primary');
  }
  if (secondarySlot) {
    secondarySlot.classList.toggle('is-focused', active && split.focusedSlot === 'secondary');
  }

  if (!active) {
    syncSlotPaneVisibility('primary', defaultPrimarySlotContent());
    void import('./unified-right-tabs').then((m) => m.refreshUnifiedRightTabs());
    return;
  }

  syncSlotPaneVisibility('primary', split.primary);
  syncSlotPaneVisibility('secondary', split.secondary);

  void import('./file-viewer').then((m) => m.renderViewerSlots());

  void import('./preview-secondary-slot').then((m) => {
    const sec = split.secondary;
    if (sec.kind === 'preview') {
      void m.renderSecondaryPreviewSlot(sec.tabId);
    } else {
      m.hideSecondaryPreviewSlot();
    }
  });

  void import('./preview-electron-visibility').then((m) => {
    m.scheduleElectronPreviewHostLayoutSync();
    m.scheduleSecondaryPreviewHostLayoutSync?.();
  });

  void import('./unified-right-tabs').then((m) => m.refreshUnifiedRightTabs());
}

/** Move split focus. */
export function focusPaneSlot(slot: PaneSlotId): void {
  if (!isRightPaneSplitLayoutEnabled()) return;
  const split = getFilePanelState().rightPaneSplit;
  if (split.focusedSlot !== slot) {
    patchFilePanelState({ rightPaneSplit: { ...split, focusedSlot: slot } });
  }
  adoptActiveViewerTabPath(activeViewerPathForSlot(slot));
  if (getSlotPaneTabs(slot).surface === 'preview') {
    const previewId = activePreviewIdForSlot(slot);
    if (previewId) activatePreviewTab(previewId);
  }
  applyRightPaneSplitDom();
}

/** Tab count in a slot (or in the global stores when the split is off). */
function slotTabCount(slot: PaneSlotId): number {
  if (!getFilePanelState().rightPaneSplit.enabled) {
    const state = getFilePanelState();
    return slot === 'primary' ? state.openViewerTabs.length + state.previewTabs.length : 0;
  }
  const tabs = getSlotPaneTabs(slot);
  return tabs.viewerPaths.length + tabs.previewIds.length;
}

/** Active content of a slot, resolved through its tab list. */
function activeContentForSlot(slot: PaneSlotId): SlotContent {
  if (!isRightPaneSplitLayoutEnabled()) return defaultPrimarySlotContent();
  return slotContentFromTabs(getSlotPaneTabs(slot));
}

function ownerOfContent(content: SlotContent): PaneSlotId | null {
  if (content.kind === 'viewer' && content.tabPath) return slotOwningViewerPath(content.tabPath);
  if (content.kind === 'preview' && content.tabId) return slotOwningPreviewId(content.tabId);
  return null;
}

/** Move a tab into `target`, unless that would leave its current group with nothing. */
function moveContentToSlot(content: SlotContent, target: PaneSlotId): void {
  if (content.kind === 'none') return;
  const owner = ownerOfContent(content);
  if (owner === target) return;
  if (owner && slotTabCount(owner) <= 1) return;
  if (content.kind === 'viewer' && content.tabPath) {
    registerViewerTabOpened(content.tabPath, target);
  } else if (content.kind === 'preview' && content.tabId) {
    registerPreviewTabOpened(content.tabId, target);
  }
}

/** Enable the split: the primary group adopts every open tab, then `secondary` (when given) moves across under {@link moveContentToSlot}'s rule. */
export function enableRightPaneSplit(secondary?: SlotContent): void {
  if (isMobileLayout() || isWorkspaceGateSurface()) return;

  bootstrapSlotTabsOnSplitEnable();
  patchFilePanelState({
    rightPaneMode: 'split',
    viewerOpen: true,
    rightPaneCollapsed: false,
    rightPaneSplit: {
      ...getFilePanelState().rightPaneSplit,
      enabled: true,
      focusedSlot: 'secondary',
    },
  });

  if (secondary) moveContentToSlot(secondary, 'secondary');

  focusPaneSlot('secondary');
  applyRightPaneSplitDom();
  void import('./file-layout').then((layout) => layout.applyFileSidebarVisuals());
  void import('./unified-right-tabs').then((tabs) => tabs.refreshUnifiedRightTabs());
}

/** Split right from whichever pane is focused, moving its active tab across. */
export function splitRightPane(): void {
  if (isMobileLayout() || isWorkspaceGateSurface()) return;

  if (!isRightPaneSplitLayoutEnabled()) {
    enableRightPaneSplit(defaultPrimarySlotContent());
    return;
  }

  const source = getFocusedPaneSlot();
  const target = otherPaneSlot(source);
  moveContentToSlot(activeContentForSlot(source), target);
  focusPaneSlot(target);
  void import('./file-layout').then((m) => m.applyFileSidebarVisuals());
}

/** Open a unified tab in the other pane (creates the split when needed). */
export function openTabToRightPane(kind: 'file' | 'preview', id: string): void {
  if (isMobileLayout() || isWorkspaceGateSurface()) return;
  const content: SlotContent =
    kind === 'file' ? { kind: 'viewer', tabPath: id } : { kind: 'preview', tabId: id };
  if (!isRightPaneSplitLayoutEnabled()) {
    enableRightPaneSplit(content);
    return;
  }
  moveContentToSlot(content, 'secondary');
  focusPaneSlot('secondary');
  void import('./file-layout').then((m) => m.applyFileSidebarVisuals());
}

/** Close the split, folding the secondary group's tabs back into the primary. */
export function closeRightPaneSplit(): void {
  const split = getFilePanelState().rightPaneSplit;
  if (!split.enabled) return;

  const merged = mergeSecondarySlotTabsIntoPrimary();
  const fromTabs = slotContentFromTabs(merged);
  const primary =
    fromTabs.kind !== 'none'
      ? fromTabs
      : split.primary.kind !== 'none'
        ? split.primary
        : split.secondary;
  let rightPaneMode: 'viewer' | 'preview' | null = null;
  if (primary.kind === 'viewer') rightPaneMode = 'viewer';
  if (primary.kind === 'preview') rightPaneMode = 'preview';

  patchFilePanelState({
    rightPaneSplit: {
      ...split,
      enabled: false,
      focusedSlot: 'primary',
      primary,
      secondary: { kind: 'none' },
      primaryTabs: merged,
      secondaryTabs: { ...EMPTY_SLOT_PANE_TABS },
    },
    rightPaneMode,
    viewerOpen: rightPaneMode !== null,
    rightPaneCollapsed: rightPaneMode !== null && getFilePanelState().rightPaneCollapsed === true,
  });

  if (primary.kind === 'viewer' && primary.tabPath) {
    adoptActiveViewerTabPath(primary.tabPath);
  }
  if (primary.kind === 'preview' && primary.tabId) {
    activatePreviewTab(primary.tabId);
  }

  void import('./file-viewer-secondary-slot').then((m) => m.destroySecondaryViewerSlot());
  void import('./preview-secondary-slot').then((m) => m.hideSecondaryPreviewSlot());
  void import('./preview-secondary-design').then((m) => m.teardownSecondaryDesignModeGuest());

  applyRightPaneSplitDom();
  void import('./file-viewer').then((m) => m.renderViewerSlots());
  void import('./file-layout').then((m) => {
    m.reconcileRightSplitDomWithState();
    m.applyFileSidebarVisuals();
  });
}

/** Collapse the split once a group runs out of tabs — an editor group with no tabs is dead space, and its surviving sibling merges back into a single full-width pane. */
export function collapseEmptySlots(): void {
  if (!getFilePanelState().rightPaneSplit.enabled) return;
  reconcileSlotTabsWithStores();
  if (isSlotEmpty('secondary') || isSlotEmpty('primary')) {
    closeRightPaneSplit();
  }
}

/** Re-sync slot ownership against the live tab stores (restore / external mutations). */
export function reconcileRightPaneSlots(): void {
  reconcileSlotTabsWithStores();
}
