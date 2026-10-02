import type { MinnowPreviewBounds } from '../electron';
import { isDesignModeUsingIframeGuest } from './preview-design-mode-guest';
import { getFilePanelState } from '../state/file-panel';
import { isRightPaneSplitActive } from './right-pane-split';
import { clearPreviewPopoverSnapshot, preparePreviewPopoverSnapshot } from './preview-popover-snapshot';

/** Full-screen app layer roots that cover the Code workspace when `is-open`. */
const FULLSCREEN_OVERLAY_IDS = [
  'issuesView',
  'settingsView',
  'benchmarkView',
  'expertsView',
  'researchView',
  'chatView',
  'modelsView',
  'brainView',
  'schedulerView',
  'compareView',
] as const;

const MAX_LAYOUT_STABLE_FRAMES = 6;

/** happy-dom / node --test may omit requestAnimationFrame on globalThis. */
function scheduleAnimationFrame(callback: FrameRequestCallback): number {
  if (typeof globalThis.requestAnimationFrame === 'function') {
    return globalThis.requestAnimationFrame(callback);
  }
  if (typeof window !== 'undefined' && typeof window.setTimeout === 'function') {
    return window.setTimeout(
      () => callback(typeof performance !== 'undefined' ? performance.now() : Date.now()),
      0,
    ) as unknown as number;
  }
  return 0;
}

function cancelScheduledAnimationFrame(handle: number): void {
  if (!handle) return;
  if (typeof globalThis.cancelAnimationFrame === 'function') {
    globalThis.cancelAnimationFrame(handle);
    return;
  }
  if (typeof window !== 'undefined' && typeof window.clearTimeout === 'function') {
    window.clearTimeout(handle);
  }
}

function usesElectronPreview(): boolean {
  return Boolean(typeof window !== 'undefined' && window.minnow?.preview);
}

export function isNonCodeOsAppLayerActive(): boolean {
  if (typeof document === 'undefined') return false;
  if (typeof document.querySelectorAll !== 'function') return false;
  const layers = document.querySelectorAll('.mn-os-app-layer.is-active');
  for (const node of layers) {
    const appId = (node as HTMLElement).dataset?.osApp;
    if (appId && appId !== 'code') return true;
  }
  return false;
}

/** True when a full-screen app covers the workspace (Issues, settings, etc.). */
export function isFullscreenOverlayObscuringWorkspace(): boolean {
  for (const id of FULLSCREEN_OVERLAY_IDS) {
    const el = document.getElementById(id);
    if (!el?.classList.contains('is-open')) continue;
    // App pages stay mounted/open when cached by app-host. Only their active
    // layer covers Code; an inactive Issues/Settings page must not hide guests.
    if (el.classList.contains('mn-os-app-layer') && !el.classList.contains('is-active')) continue;
    return true;
  }
  return isNonCodeOsAppLayerActive();
}

/** True when the Minnow wiki overlay (#/wiki) covers the workspace. */
export function isProductWikiOverlayVisible(): boolean {
  const el = document.getElementById('productWikiOverlay');
  return Boolean(el && !el.classList.contains('hidden'));
}

/** Open menubar/chrome popovers that overlap the preview pane (native layer wins). */
let chromePopoverOpenCount = 0;

/** Register an obstructing chrome popover (notifications, model chip, workspace, etc.). */
export function registerChromePopover(): void {
  chromePopoverOpenCount += 1;
  scheduleElectronPreviewHostVisibilitySync();
}

/** Unregister when a chrome popover closes. */
export function unregisterChromePopover(): void {
  if (chromePopoverOpenCount > 0) chromePopoverOpenCount -= 1;
  scheduleElectronPreviewHostVisibilitySync();
}

/** True while any registered chrome popover is open. */
export function isChromePopoverOpen(): boolean {
  return chromePopoverOpenCount > 0;
}

/** Test helper — reset popover registry between cases. */
export function resetChromePopoverRegistryForTests(): void {
  chromePopoverOpenCount = 0;
}

/** True when the desktop workspace drawer is showing the browser mount. */
function isDesktopBrowserMountActive(): boolean {
  const mount = document.getElementById('desktopPreviewMount');
  return Boolean(mount?.classList.contains('is-active'));
}

/** True when the preview split pane is the active right pane and not CSS-hidden. */
export function isPreviewPaneDomVisible(): boolean {
  const state = getFilePanelState();
  if (state.rightPaneMode === 'split' && isRightPaneSplitActive()) {
    const primaryPreview = state.rightPaneSplit.primary.kind === 'preview';
    const secondaryPreview = state.rightPaneSplit.secondary.kind === 'preview';
    if (!primaryPreview && !secondaryPreview) return false;
    if (primaryPreview) {
      const pane = document.getElementById('previewPane');
      if (pane && !pane.classList.contains('hidden')) return true;
    }
    if (secondaryPreview) {
      const pane = document.getElementById('previewPaneSecondary');
      if (pane && !pane.classList.contains('hidden')) return true;
    }
    return false;
  }
  if (state.rightPaneMode !== 'preview') return false;
  const pane = document.getElementById('previewPane');
  if (!pane) return false;
  if (isDesktopBrowserMountActive()) return true;
  if (pane.classList.contains('hidden')) return false;
  return true;
}

/** True when the Code workspace or desktop browser drawer hosts the preview guest. */
function isPreviewSurfaceActive(): boolean {
  if (isDesktopBrowserSurfaceActive()) return true;
  return isCodeWorkspaceForeground();
}

/** Whether agent browser_navigate may open the preview split and later paint the guest. */
export function canAgentRevealPreviewPanel(): boolean {
  if (isProductWikiOverlayVisible()) return false;
  if (isFullscreenOverlayObscuringWorkspace()) return false;
  return isPreviewSurfaceActive();
}

function isDesktopBrowserSurfaceActive(): boolean {
  if (!isDesktopBrowserMountActive()) return false;
  return isPreviewPaneDomVisible();
}

/** True when the Code workspace (where #previewBody lives) is the active shell surface. */
function isCodeWorkspaceForeground(): boolean {
  if (document.documentElement.dataset.osApp !== 'code') return false;
  const appBody = document.getElementById('appBody');
  return Boolean(appBody && !appBody.classList.contains('hidden'));
}

/** Whether the Chromium guest should be visible and receive bounds updates. */
export function shouldShowElectronPreviewHost(): boolean {
  return !isChromePopoverOpen() && canPaintElectronPreviewHost();
}

/** Ignore transient menus when deciding whether the underlying page is on screen. */
function canPaintElectronPreviewHost(): boolean {
  if (!usesElectronPreview()) return false;
  if (isDesignModeUsingIframeGuest()) return false;
  if (!isPreviewSurfaceActive()) return false;
  if (!isPreviewPaneDomVisible()) return false;
  if (isFullscreenOverlayObscuringWorkspace()) return false;
  if (isProductWikiOverlayVisible()) return false;
  const body = document.getElementById('previewBody');
  if (!body) return false;
  const rect = body.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function previewBodyHasLayout(): boolean {
  const body = document.getElementById('previewBody');
  if (!body) return false;
  const rect = body.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function readPreviewBodyBounds(): MinnowPreviewBounds | null {
  const body = document.getElementById('previewBody');
  if (!body) return null;
  const rect = body.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  return {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
  };
}

function rectsStable(a: DOMRect, b: DOMRect): boolean {
  return (
    Math.abs(a.left - b.left) < 0.5 &&
    Math.abs(a.top - b.top) < 0.5 &&
    Math.abs(a.width - b.width) < 0.5 &&
    Math.abs(a.height - b.height) < 0.5
  );
}

/** Wait until #previewBody has non-zero size and its rect stops moving between frames. */
function waitForStablePreviewBodyBounds(): Promise<MinnowPreviewBounds | null> {
  return new Promise((resolve) => {
    let frames = 0;
    let previous: DOMRect | null = null;

    const tick = (): void => {
      if (typeof document === 'undefined') {
        resolve(null);
        return;
      }

      const body = document.getElementById('previewBody');
      if (!body) {
        resolve(null);
        return;
      }

      const rect = body.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        frames += 1;
        if (frames >= MAX_LAYOUT_STABLE_FRAMES) {
          resolve(null);
          return;
        }
        scheduleAnimationFrame(tick);
        return;
      }

      if (previous && rectsStable(previous, rect)) {
        resolve(readPreviewBodyBounds());
        return;
      }

      previous = rect;
      frames += 1;
      if (frames >= MAX_LAYOUT_STABLE_FRAMES) {
        resolve(readPreviewBodyBounds());
        return;
      }
      scheduleAnimationFrame(tick);
    };

    scheduleAnimationFrame(tick);
  });
}

/** Serialize layout sync so overlapping async IPC cannot apply stale bounds. */
let layoutSyncChain: Promise<void> = Promise.resolve();
let previewGuestVisible = false;

async function runElectronPreviewHostLayoutSync(tabId?: string | null): Promise<void> {
  const api = typeof window !== 'undefined' ? window.minnow?.preview : undefined;
  if (!api) return;

  if (!shouldShowElectronPreviewHost()) {
    if (isChromePopoverOpen() && canPaintElectronPreviewHost()) {
      if (previewGuestVisible) await preparePreviewPopoverSnapshot();
      // Opening/closing menus or navigating away can race the capture IPC.
      if (shouldShowElectronPreviewHost()) {
        clearPreviewPopoverSnapshot();
        return;
      }
      if (!canPaintElectronPreviewHost()) clearPreviewPopoverSnapshot();
    } else {
      clearPreviewPopoverSnapshot();
    }
    await api.hide();
    previewGuestVisible = false;
    return;
  }

  const bounds = await waitForStablePreviewBodyBounds();
  if (!bounds) return;
  if (!shouldShowElectronPreviewHost()) return;

  await api.show(bounds, tabId ?? undefined);
  previewGuestVisible = true;
  clearPreviewPopoverSnapshot();
}

/** Show or hide the native preview host and sync bounds when visible. */
export function syncElectronPreviewHostLayout(tabId?: string | null): Promise<void> {
  if (layoutSyncRaf) {
    cancelScheduledAnimationFrame(layoutSyncRaf);
    layoutSyncRaf = 0;
  }
  const next = layoutSyncChain.then(() => runElectronPreviewHostLayoutSync(tabId));
  layoutSyncChain = next.catch(() => {});
  return next;
}

/** @deprecated Use syncElectronPreviewHostLayout — kept for existing dynamic imports. */
export async function syncElectronPreviewHostVisibility(): Promise<void> {
  await syncElectronPreviewHostLayout();
}

let layoutSyncRaf = 0;
let layoutRetryFrames = 0;
const MAX_LAYOUT_RETRY_FRAMES = 8;

function scheduleLayoutRetryIfNeeded(): void {
  if (typeof window === 'undefined') return;
  if (!usesElectronPreview()) return;
  if (!isPreviewPaneDomVisible() || isFullscreenOverlayObscuringWorkspace()) return;
  if (previewBodyHasLayout()) {
    layoutRetryFrames = 0;
    return;
  }
  if (layoutRetryFrames >= MAX_LAYOUT_RETRY_FRAMES) return;
  layoutRetryFrames += 1;
  scheduleAnimationFrame(() => {
    void syncElectronPreviewHostLayout().then(scheduleLayoutRetryIfNeeded);
  });
}

/** Debounced show/hide + bounds sync (resize, layout, overlay open, Code foreground). */
export function scheduleElectronPreviewHostVisibilitySync(): void {
  if (typeof window === 'undefined') return;
  if (layoutSyncRaf) return;
  layoutSyncRaf = scheduleAnimationFrame(() => {
    layoutSyncRaf = 0;
    if (typeof window === 'undefined') return;
    void syncElectronPreviewHostLayout().then(scheduleLayoutRetryIfNeeded);
  });
}

/** Alias for callers that distinguish visibility from bounds — same combined sync. */
export const scheduleElectronPreviewHostLayoutSync = scheduleElectronPreviewHostVisibilitySync;

/** Debounced bounds sync for workspace-preview-secondary slot. */
export function scheduleSecondaryPreviewHostLayoutSync(): void {
  void import('./preview-secondary-slot').then((m) => m.scheduleSecondaryPreviewHostLayoutSync());
}

/** Test helper — reset guest visibility tracking between cases. */
export function resetPreviewGuestVisibilityForTests(): void {
  clearPreviewPopoverSnapshot();
  previewGuestVisible = false;
  layoutSyncChain = Promise.resolve();
  if (layoutSyncRaf) {
    cancelScheduledAnimationFrame(layoutSyncRaf);
    layoutSyncRaf = 0;
  }
  layoutRetryFrames = 0;
}
