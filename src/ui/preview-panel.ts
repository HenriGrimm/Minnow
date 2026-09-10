import { loadBrowserMeta } from '../config/browser-meta';
import type { MinnowPreviewApi } from '../electron';
import {
  getFilePanelState,
  patchFilePanelState,
  type PaneSlotId,
  type PreviewDevToolsDock,
  type PreviewSource,
} from '../state/file-panel';
import { onFileSaved } from '../state/preview-events';
import {
  hidePreviewSplit,
  resetRightSplitForCodeEntry,
  showPreviewSplit,
  showViewerSplit,
} from './file-layout';
import { listViewerTabs } from './file-viewer-tab-store';
import { withSessionToken } from '../api/session-token.ts';
import { detectEmbedBlockedFrame } from './preview-embed-detect';
import { resolvePreviewLoadUrl, workspacePreviewUrl } from './preview-load-url';
import { getFileTreeListingWorkspaceRoot } from './file-tree-listing-root';
import {
  canAgentRevealPreviewPanel,
  isFullscreenOverlayObscuringWorkspace,
  isPreviewPaneDomVisible,
  scheduleElectronPreviewHostLayoutSync,
  scheduleElectronPreviewHostVisibilitySync,
  syncElectronPreviewHostLayout,
} from './preview-electron-visibility';
import { setDesignModeUsingIframeGuest } from './preview-design-mode-guest';
import {
  activatePreviewTab,
  closePreviewTab,
  ensureDefaultPreviewTab,
  getActivePreviewTab,
  getActivePreviewTabId,
  getPreviewTab,
  listPreviewTabs,
  migrateLegacyPreviewSource,
  openPreviewTabWithCapacity,
  restorePreviewTabs,
  setPreviewTabGuestCrashed,
  setPreviewTabLoadFailed,
  setPreviewTabLoading,
  setPreviewTabTitle,
  updatePreviewTabSource,
} from './preview-tab-store';
import { bindPreviewTabs, registerPreviewTabHandlers } from './preview-tabs';
import { HTTP_URL_RE, parsePreviewAddress } from './preview-url';
import {
  shouldAutoRestorePreviewPanel,
  shouldAutoRevealPreviewOnNavigation,
  isCodeAppForeground,
} from './preview-restore-policy';
import { showToast } from './toast';
import { disableDesignMode, enableDesignMode, isDesignModeEnabled, getDesignModeSession, refreshDesignModeArmedToolGuest, relocateDesignModeStrip } from '../design/design-mode';
import {
  resolveDesignModeMountOptions,
  WORKSPACE_PREVIEW_DESIGN_INSTANCE_ID,
} from './preview-design-mode-mount';
export { WORKSPACE_PREVIEW_DESIGN_INSTANCE_ID } from './preview-design-mode-mount';
import { currentPreviewPageRef, gatherAnchorCandidates } from '../design/design-tool';
import { isCrossOriginPreview } from '../design/element-picker';
import {
  eraseShape,
  erasePin,
  healPageAnnotations,
  loadPageAnnotations,
} from '../design/annotation-store';
import {
  mountAnnotationsPanel,
  type AnnotationsPanelHandle,
  type AnnotationsPanelItem,
} from '../design/annotations-panel';
import {
  notifyDesignFileSaved,
  notifyDesignReloadSettled,
  onBeforeAfterPair,
} from '../design/before-after-integration';
import { getActiveChat } from '../state/sessions';

async function dismissFileViewerForPreview(): Promise<boolean> {
  const mod = await import('./file-viewer');
  return mod.dismissFileViewerForPreview();
}

const BROWSER_PREVIEW_HINT =
  'Full Chromium preview (any website or local file) runs in the Minnow desktop app.';
const PREVIEW_FILE_API = '/api/preview/file/';
const FRAME_BLOCKED_TIMEOUT_MS = 1500;
const MIN_RELOAD_INTERVAL_MS = 1000;
const DEFERRED_PREVIEW_LOAD_MS = 800;

const DESIGN_MODE_INSTANCE_ID = WORKSPACE_PREVIEW_DESIGN_INSTANCE_ID;

const EMBED_BLOCKED_MESSAGE =
  'This site blocks embedded previews (X-Frame-Options or CSP frame-ancestors). Sites like Google, GitHub, and most login pages cannot load inside an iframe. Preview workspace HTML files instead, or open this URL in a new tab.';

let controlsBound = false;
let boundsObserver: ResizeObserver | null = null;
let autoReloadDebounce: ReturnType<typeof setTimeout> | null = null;
let deferredPreviewLoadTimer: ReturnType<typeof setTimeout> | null = null;
let frameBlockedTimer: ReturnType<typeof setTimeout> | null = null;
let lastReloadAt = 0;
let embedBlockedActive = false;
let unsubscribeNavigation: (() => void) | null = null;
let unsubscribeLoading: (() => void) | null = null;
let unsubscribeLoadFailed: (() => void) | null = null;
let unsubscribePageTitle: (() => void) | null = null;
let unsubscribeGuestCrashed: (() => void) | null = null;
let unsubscribeDevToolsState: (() => void) | null = null;
const iframesByTabId = new Map<string, HTMLIFrameElement>();
const loadedTabGuests = new Set<string>();

// ── Frames ───────────────────────────────────────────────────────────────────

function getActivePreviewSource(): PreviewSource | null {
  return getActivePreviewTab()?.source ?? getFilePanelState().previewSource;
}

function resolveTabId(tabId?: string): string | null {
  if (tabId) return tabId;
  return getActivePreviewTabId();
}

function usesElectronPreview(): boolean {
  return Boolean(getPreviewApi());
}

function getPreviewApi(): MinnowPreviewApi | undefined {
  return window.minnow?.preview;
}

function getOrCreateFrame(tabId: string): HTMLIFrameElement | null {
  const body = getPreviewBody();
  if (!body) return null;
  let frame = iframesByTabId.get(tabId);
  if (!frame) {
    frame = document.createElement('iframe');
    frame.className = 'preview-frame';
    frame.setAttribute(
      'sandbox',
      'allow-scripts allow-forms allow-popups allow-modals allow-same-origin',
    );
    frame.title = 'Workspace preview';
    frame.hidden = true;
    frame.addEventListener('load', () => {
      onIframeLoad(tabId);
    });
    body.appendChild(frame);
    iframesByTabId.set(tabId, frame);
  }
  return frame;
}

function getActiveFrame(): HTMLIFrameElement | null {
  const tabId = getActivePreviewTabId();
  if (!tabId) return null;
  return getOrCreateFrame(tabId);
}

function showActiveTabFrame(): void {
  const activeId = getActivePreviewTabId();
  for (const [id, frame] of iframesByTabId) {
    frame.hidden = id !== activeId;
  }
}

function destroyPreviewFrame(tabId: string): void {
  const frame = iframesByTabId.get(tabId);
  if (frame) {
    frame.remove();
    iframesByTabId.delete(tabId);
  }
  loadedTabGuests.delete(tabId);
}

function onIframeLoad(tabId: string): void {
  if (usesElectronPreview() && !usesDesignModeIframeGuest()) return;
  if (tabId !== getActivePreviewTabId()) return;
  onPreviewReloadSettled();
  clearFrameBlockedTimer();
  const source = getPreviewTabSource(tabId);
  if (source?.kind !== 'url') {
    hideEmbedBlockedNotice();
    return;
  }
  if (embedBlockedActive) return;
  const frame = iframesByTabId.get(tabId);
  if (!frame) return;
  const { href } = readFrameEmbedSignals(frame);
  if (href === 'about:blank') return;
  checkExternalUrlEmbedAfterLoad(tabId);
  if (!embedBlockedActive) {
    scheduleFrameBlockedCheck(tabId);
  }
}

function getPreviewTabSource(tabId: string): PreviewSource | null {
  return getPreviewTab(tabId)?.source ?? null;
}

function getUrlInput(): HTMLInputElement | null {
  return document.getElementById('previewUrlInput') as HTMLInputElement | null;
}

function getStatusEl(): HTMLElement | null {
  return document.getElementById('previewStatus');
}

function getStatusMessageEl(): HTMLElement | null {
  return document.getElementById('previewStatusMessage');
}

function getOpenExternalLink(): HTMLAnchorElement | null {
  return document.getElementById('previewOpenExternal') as HTMLAnchorElement | null;
}

function getPreviewBody(): HTMLElement | null {
  return document.getElementById('previewBody');
}

function getPreviewPane(): HTMLElement | null {
  return document.getElementById('previewPane');
}

function getPreviewDesignChrome(): HTMLElement | null {
  return document.getElementById('previewDesignChrome');
}

// ── Design mode ──────────────────────────────────────────────────────────────

/** Electron hides the native guest while Design Mode drives a same-origin iframe under the SVG overlay. */
export function usesDesignModeIframeGuest(): boolean {
  if (!usesElectronPreview() || !isDesignModeEnabled(DESIGN_MODE_INSTANCE_ID)) return false;
  if (!isCrossOriginPreview()) return true;
  const armedTool = getDesignModeSession(DESIGN_MODE_INSTANCE_ID)?.getArmedToolId();
  return armedTool !== 'select';
}

function getDesignToggleButton(): HTMLButtonElement | null {
  return document.getElementById('btnPreviewDesignToggle') as HTMLButtonElement | null;
}

function getAnnotationsToggleButton(): HTMLButtonElement | null {
  return document.getElementById('btnPreviewAnnotationsToggle') as HTMLButtonElement | null;
}

/** Annotations panel toggle is shown only while Design Mode (browser tools) is active. */
function syncAnnotationsToggleVisibility(available: boolean): void {
  const annotationsBtn = getAnnotationsToggleButton();
  const visible = available && isDesignModeEnabled(DESIGN_MODE_INSTANCE_ID);
  if (annotationsBtn) annotationsBtn.hidden = !visible;

  if (visible) return;

  if (!annotationsPanel) return;
  annotationsPanel.destroy();
  annotationsPanel = null;
  annotationsBtn?.setAttribute('aria-pressed', 'false');
  annotationsBtn?.classList.remove('is-active');
}

let annotationsPanel: AnnotationsPanelHandle | null = null;

/** Refresh the mounted annotations panel from the annotation store for the current page. */
async function refreshAnnotationsPanel(): Promise<void> {
  if (!annotationsPanel) return;
  const pageKey = currentPreviewPageRef();
  const [data, candidates] = await Promise.all([
    loadPageAnnotations(pageKey),
    gatherAnchorCandidates(),
  ]);
  annotationsPanel.setData(data, candidates);
}

function highlightAnnotationItem(item: AnnotationsPanelItem): void {
  const session = getDesignModeSession(DESIGN_MODE_INSTANCE_ID);
  if (!session) return;
  if (item.type === 'shape') session.overlay.pulseShapeIds([item.id]);
  else session.overlay.pulsePinIds([item.id]);
}

async function bulkDeleteAnnotationItems(ids: { shapeIds: string[]; pinIds: string[] }): Promise<void> {
  const pageKey = currentPreviewPageRef();
  for (const shapeId of ids.shapeIds) await eraseShape(pageKey, shapeId);
  for (const pinId of ids.pinIds) await erasePin(pageKey, pinId);
  await refreshAnnotationsPanel();
}

/** Toggle the annotations panel (MIN-368) — a collapsible list of every mark on the current page. */
async function toggleAnnotationsPanel(): Promise<void> {
  if (!(await isPreviewDesignModeAvailable())) return;
  const host = getPreviewBody();
  if (!host) return;

  if (annotationsPanel) {
    annotationsPanel.destroy();
    annotationsPanel = null;
    getAnnotationsToggleButton()?.setAttribute('aria-pressed', 'false');
    getAnnotationsToggleButton()?.classList.remove('is-active');
    return;
  }

  getAnnotationsToggleButton()?.setAttribute('aria-pressed', 'true');
  getAnnotationsToggleButton()?.classList.add('is-active');
  annotationsPanel = mountAnnotationsPanel(host, {
    onHighlight: highlightAnnotationItem,
    onJumpToChat: (chatId, turnId) => {
      void import('../design/annotation-nav').then((m) => m.jumpToChatTurn(chatId, turnId));
    },
    onBulkDelete: bulkDeleteAnnotationItems,
  });
  await refreshAnnotationsPanel();
}

async function syncDesignModeElectronGuest(): Promise<void> {
  const body = getPreviewBody();
  const chrome = getPreviewDesignChrome();
  if (!body) return;

  const usingIframe = usesDesignModeIframeGuest();
  setDesignModeUsingIframeGuest(DESIGN_MODE_INSTANCE_ID, usingIframe);

  const designOn = usesElectronPreview() && isDesignModeEnabled(DESIGN_MODE_INSTANCE_ID);
  const session = getDesignModeSession(DESIGN_MODE_INSTANCE_ID);
  if (designOn && session) {
    if (usingIframe) {
      chrome?.setAttribute('hidden', '');
      relocateDesignModeStrip(DESIGN_MODE_INSTANCE_ID, body);
    } else {
      chrome?.removeAttribute('hidden');
      if (chrome) relocateDesignModeStrip(DESIGN_MODE_INSTANCE_ID, chrome);
    }
  } else {
    chrome?.setAttribute('hidden', '');
  }

  if (usingIframe) {
    body.classList.add('preview-body--design-mode');
    const tabId = getActivePreviewTabId();
    if (tabId) {
      const tab = getPreviewTab(tabId);
      if (tab?.source) {
        applySourceToFrame(tabId, tab.source);
      }
      showActiveTabFrame();
    }
  } else {
    body.classList.remove('preview-body--design-mode');
    if (usesElectronPreview()) {
      for (const frame of iframesByTabId.values()) {
        frame.hidden = true;
      }
    } else {
      showActiveTabFrame();
    }
  }

  await syncElectronPreviewHostLayout();

  if (getDesignModeSession(DESIGN_MODE_INSTANCE_ID)?.getArmedToolId() === 'select') {
    refreshDesignModeArmedToolGuest(DESIGN_MODE_INSTANCE_ID);
  }
}

/** Primary workspace preview — exported for secondary design guest sync. */
export const syncPrimaryDesignModeElectronGuest = syncDesignModeElectronGuest;

/** Design Mode is a Code-workspace tool. */
export async function isPreviewDesignModeAvailable(): Promise<boolean> {
  return true;
}

/** Show or hide Design Mode chrome based on whether preview is hosted in Code vs the desktop drawer. */
export async function syncPreviewDesignToolbarForSurface(): Promise<void> {
  const available = await isPreviewDesignModeAvailable();
  const designBtn = getDesignToggleButton();

  if (designBtn) designBtn.hidden = !available;
  syncAnnotationsToggleVisibility(available);

  const secondaryDesignBtn = document.getElementById(
    'btnPreviewDesignToggleSecondary',
  ) as HTMLButtonElement | null;
  if (secondaryDesignBtn) secondaryDesignBtn.hidden = !available;

  if (available) return;

  if (!isDesignModeEnabled(DESIGN_MODE_INSTANCE_ID)) return;

  disableDesignMode(DESIGN_MODE_INSTANCE_ID);
  designBtn?.setAttribute('aria-pressed', 'false');
  designBtn?.classList.remove('is-active');
  await syncDesignModeElectronGuest();
}

/** Toggle Design Mode's overlay + tool strip over the preview guest (MIN-365). Guest untouched. */
async function toggleDesignModeFromToolbar(): Promise<void> {
  const host = getPreviewBody();
  const pane = getPreviewPane();
  if (!host) return;
  if (!(await isPreviewDesignModeAvailable())) return;

  if (isDesignModeEnabled(DESIGN_MODE_INSTANCE_ID)) {
    disableDesignMode(DESIGN_MODE_INSTANCE_ID);
    getDesignToggleButton()?.setAttribute('aria-pressed', 'false');
    getDesignToggleButton()?.classList.remove('is-active');
    syncAnnotationsToggleVisibility(true);
    await syncDesignModeElectronGuest();
    return;
  }

  getDesignToggleButton()?.setAttribute('aria-pressed', 'true');
  getDesignToggleButton()?.classList.add('is-active');
  await enableDesignMode({
    ...resolveDesignModeMountOptions(host, pane, getPreviewDesignChrome(), () =>
      void toggleDesignModeFromToolbar(),
    ),
    onArmedToolChange: async () => {
      await syncDesignModeElectronGuest();
    },
    onClearAll: () => void refreshAnnotationsPanel(),
  });
  syncAnnotationsToggleVisibility(true);
}

/** Open a page (workspace path or http(s) URL) in the preview panel and ensure Design Mode is on for it (MIN-368 transcript → page navigation). */
export async function openPreviewPageAndEnableDesignMode(pageUrl: string): Promise<void> {
  const isUrl = HTTP_URL_RE.test(pageUrl.trim());
  if (isUrl) {
    await openUrlInPreviewPanel(pageUrl);
  } else {
    openWorkspacePathInPreview(pageUrl);
  }

  const host = getPreviewBody();
  const pane = getPreviewPane();
  if (!host || isDesignModeEnabled(DESIGN_MODE_INSTANCE_ID)) return;
  if (!(await isPreviewDesignModeAvailable())) return;

  getDesignToggleButton()?.setAttribute('aria-pressed', 'true');
  getDesignToggleButton()?.classList.add('is-active');
  await enableDesignMode({
    ...resolveDesignModeMountOptions(host, pane, getPreviewDesignChrome(), () =>
      void toggleDesignModeFromToolbar(),
    ),
    onArmedToolChange: async () => {
      await syncDesignModeElectronGuest();
    },
    onClearAll: () => void refreshAnnotationsPanel(),
  });
  syncAnnotationsToggleVisibility(true);
}

// ── DevTools ─────────────────────────────────────────────────────────────────

function getDevToolsButton(): HTMLButtonElement | null {
  return document.getElementById('btnPreviewDevTools') as HTMLButtonElement | null;
}

function setDevToolsButtonPressed(open: boolean): void {
  getDevToolsButton()?.setAttribute('aria-pressed', open ? 'true' : 'false');
  const dockBtn = getDevToolsDockButton();
  if (!dockBtn) return;
  dockBtn.hidden = !open;
  if (open) syncDevToolsDockButton();
}

function getDevToolsDockButton(): HTMLButtonElement | null {
  return document.getElementById('btnPreviewDevToolsDock') as HTMLButtonElement | null;
}

function devToolsDockLabel(dock: PreviewDevToolsDock): string {
  if (dock === 'bottom') return 'Dock DevTools to side';
  if (dock === 'side') return 'Pop out DevTools';
  return 'Dock DevTools to bottom';
}

function nextDevToolsDock(dock: PreviewDevToolsDock): PreviewDevToolsDock {
  if (dock === 'bottom') return 'side';
  if (dock === 'side') return 'popout';
  return 'bottom';
}

function syncDevToolsDockButton(dock: PreviewDevToolsDock = getFilePanelState().previewDevToolsDock): void {
  const btn = getDevToolsDockButton();
  if (!btn) return;
  btn.title = devToolsDockLabel(dock);
  btn.setAttribute('aria-label', devToolsDockLabel(dock));
  btn.dataset.dock = dock;
}

/** Push the persisted dock preference to the Electron preview host. */
export async function syncPreviewDevToolsDockToHost(): Promise<void> {
  const api = getPreviewApi();
  if (!api?.devtools?.setDock) return;
  try {
    await api.devtools.setDock(getFilePanelState().previewDevToolsDock);
  } catch {
  }
  syncDevToolsDockButton();
}

function toggleDevToolsDockFromToolbar(): void {
  const next = nextDevToolsDock(getFilePanelState().previewDevToolsDock);
  patchFilePanelState({ previewDevToolsDock: next });
  void syncPreviewDevToolsDockToHost();
}

/** Reflect the active tab's docked-DevTools state on the toolbar toggle (Electron only). */
async function syncDevToolsButtonState(): Promise<void> {
  const api = getPreviewApi();
  if (!api?.devtools) return;
  const tabId = getActivePreviewTabId() ?? undefined;
  try {
    setDevToolsButtonPressed(await api.devtools.isOpen(tabId));
  } catch {
  }
}

/** Toggle Chromium DevTools docked under the preview guest (MIN-177). */
async function toggleDevToolsFromToolbar(): Promise<void> {
  const api = getPreviewApi();
  if (!api?.devtools) return;
  const tabId = getActivePreviewTabId() ?? undefined;
  try {
    const { open } = await api.devtools.toggle(tabId);
    setDevToolsButtonPressed(open);
  } catch {
  }
}

/** F12 or Ctrl+Shift+I toggles preview DevTools while the preview pane is on screen. */
function isDevToolsShortcut(e: KeyboardEvent): boolean {
  if (e.key === 'F12') return true;
  return (e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'i';
}

// ── Navigation ───────────────────────────────────────────────────────────────

function getAutoReloadCheckbox(): HTMLInputElement | null {
  return document.getElementById('previewAutoReload') as HTMLInputElement | null;
}

function getBackButton(): HTMLButtonElement | null {
  return document.getElementById('btnPreviewBack') as HTMLButtonElement | null;
}

function getForwardButton(): HTMLButtonElement | null {
  return document.getElementById('btnPreviewForward') as HTMLButtonElement | null;
}

function getLoadingIndicator(): HTMLElement | null {
  return document.getElementById('previewLoading');
}

function normalizeWorkspacePath(input: string): string {
  return input.replace(/^\/+/, '').trim();
}

/** @deprecated Import from `./preview-load-url` to avoid the editor bundle. */
export { resolvePreviewLoadUrl, workspacePreviewUrl } from './preview-load-url';

function sourceToAddressBar(source: PreviewSource): string {
  if (source.kind === 'url') return source.url;
  return source.path;
}

function parseAddressInput(raw: string): PreviewSource | null {
  return parsePreviewAddress(raw, { allowLocalFiles: usesElectronPreview() });
}

function sourcesEqual(a: PreviewSource | null, b: PreviewSource | null): boolean {
  if (!a || !b) return false;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'url' && b.kind === 'url') return a.url === b.url;
  if (a.kind === 'workspace' && b.kind === 'workspace') {
    return normalizeWorkspacePath(a.path) === normalizeWorkspacePath(b.path);
  }
  return false;
}

function showPreviewStatus(message: string, externalUrl?: string): void {
  const status = getStatusEl();
  const msg = getStatusMessageEl();
  const link = getOpenExternalLink();
  if (!status || !msg) return;
  msg.textContent = message;
  if (link && externalUrl) {
    link.href = externalUrl;
    link.classList.remove('hidden');
  } else {
    link?.classList.add('hidden');
    link?.removeAttribute('href');
  }
  status.hidden = false;
}

function hidePreviewStatus(): void {
  hideEmbedBlockedNotice();
  const status = getStatusEl();
  const link = getOpenExternalLink();
  if (status) status.hidden = true;
  if (link) {
    link.classList.add('hidden');
    link.removeAttribute('href');
  }
}

function setPreviewLoading(loading: boolean, tabId?: string): void {
  const id = resolveTabId(tabId);
  if (id) setPreviewTabLoading(id, loading);
  const el = getLoadingIndicator();
  if (!el) return;
  el.classList.toggle('hidden', !loading);
  el.classList.toggle('is-active', loading);
}

function syncAddressBarFromNavigation(url: string): void {
  const input = getUrlInput();
  if (!input) return;
  if (!url || url === 'about:blank') return;

  const activeSource = getActivePreviewSource();
  if (activeSource?.kind === 'workspace') {
    try {
      const parsed = new URL(url);
      const prefix = `${window.location.origin}${PREVIEW_FILE_API}`;
      if (parsed.origin === window.location.origin && parsed.pathname.startsWith(PREVIEW_FILE_API)) {
        const encoded = parsed.pathname.slice(PREVIEW_FILE_API.length);
        const path = decodeURIComponent(encoded).replace(/^\/+/, '');
        input.value = path;
        return;
      }
    } catch {
    }
  }

  input.value = url;
}

function commitActivePreviewSource(source: PreviewSource | null): void {
  const tabId = getActivePreviewTabId();
  if (tabId) {
    updatePreviewTabSource(tabId, source);
  } else {
    patchFilePanelState({ previewSource: source });
  }
}

function onPreviewNavigation(url: string, tabId?: string): void {
  const resolvedTabId = resolveTabId(tabId);
  if (
    usesElectronPreview() &&
    !isPreviewPaneDomVisible() &&
    !isFullscreenOverlayObscuringWorkspace() &&
    shouldAutoRevealPreviewOnNavigation() &&
    url &&
    HTTP_URL_RE.test(url)
  ) {
    void revealPreviewPanelForAgentNavigation(url);
  }

  if (resolvedTabId === getActivePreviewTabId()) {
    syncAddressBarFromNavigation(url);
  }
  if (!url || url === 'about:blank' || url.startsWith('chrome-error:')) return;
  if (resolvedTabId === getActivePreviewTabId()) {
    hidePreviewStatus();
  }

  if (url.startsWith('file://') || HTTP_URL_RE.test(url)) {
    if (resolvedTabId) updatePreviewTabSource(resolvedTabId, { kind: 'url', url });
    else commitActivePreviewSource({ kind: 'url', url });
    return;
  }

  try {
    const parsed = new URL(url);
    const prefix = `${window.location.origin}${PREVIEW_FILE_API}`;
    if (parsed.origin === window.location.origin && parsed.pathname.startsWith(PREVIEW_FILE_API)) {
      const encoded = parsed.pathname.slice(PREVIEW_FILE_API.length);
      const path = decodeURIComponent(encoded).replace(/^\/+/, '');
      const source = { kind: 'workspace' as const, path };
      if (resolvedTabId) updatePreviewTabSource(resolvedTabId, source);
      else commitActivePreviewSource(source);
    }
  } catch {
  }
}

function clearLoadedTabGuest(tabId?: string): void {
  if (tabId) {
    loadedTabGuests.delete(tabId);
    return;
  }
  loadedTabGuests.clear();
}

function onPreviewGuestCrashed(
  detail: { reason: string; exitCode: number },
  tabId?: string,
): void {
  const resolvedTabId = resolveTabId(tabId);
  if (!resolvedTabId) return;
  clearLoadedTabGuest(resolvedTabId);
  setPreviewTabGuestCrashed(resolvedTabId, detail);
  if (resolvedTabId !== getActivePreviewTabId()) return;
  setPreviewLoading(false, resolvedTabId);
  const reason = detail.reason?.trim() || 'crashed';
  showPreviewStatus(
    `Preview tab crashed (${reason}). Reload or switch tabs to continue.`,
  );
}

function onPreviewLoadFailed(
  detail: {
    errorCode: number;
    errorDescription: string;
    url?: string;
  },
  tabId?: string,
): void {
  const resolvedTabId = resolveTabId(tabId);
  if (resolvedTabId) {
    setPreviewTabLoadFailed(resolvedTabId, {
      errorCode: detail.errorCode,
      errorDescription: detail.errorDescription,
    });
  }
  if (resolvedTabId !== getActivePreviewTabId()) return;
  setPreviewLoading(false, resolvedTabId ?? undefined);
  let message =
    detail.errorDescription?.trim() ||
    `Preview failed to load (error ${detail.errorCode}).`;
  if (detail.errorCode === -27 || /ERR_BLOCKED_BY_RESPONSE/i.test(message)) {
    message =
      'This site refused to load in the embedded browser. Use Open in new tab, or try again after restarting Minnow.';
  }
  const previewSource = getActivePreviewSource();
  const externalUrl =
    detail.url && (detail.url.startsWith('http') || detail.url.startsWith('file:'))
      ? detail.url
      : previewSource?.kind === 'url'
        ? previewSource.url
        : undefined;
  showPreviewStatus(message, externalUrl);
}

// ── Electron host ────────────────────────────────────────────────────────────

function startBoundsObserver(): void {
  const body = getPreviewBody();
  if (!body || boundsObserver || !usesElectronPreview()) return;
  const onLayoutChange = (): void => {
    scheduleElectronPreviewHostLayoutSync();
  };
  boundsObserver = new ResizeObserver(onLayoutChange);
  boundsObserver.observe(body);
  const column = document.getElementById('rightPaneColumn');
  const pane = document.getElementById('previewPane');
  const split = document.getElementById('workspaceSplit');
  const resizer = document.getElementById('splitResizer');
  if (column) boundsObserver.observe(column);
  if (pane) boundsObserver.observe(pane);
  if (split) boundsObserver.observe(split);
  if (resizer) boundsObserver.observe(resizer);
  window.addEventListener('resize', onLayoutChange);
  window.addEventListener('scroll', onLayoutChange, true);
  scheduleElectronPreviewHostLayoutSync();
}

function markPreviewHostMode(): void {
  const body = getPreviewBody();
  if (!body) return;
  body.classList.toggle('preview-body--electron', usesElectronPreview());
}

async function showPreviewHost(): Promise<void> {
  const tabId = getActivePreviewTabId();
  await syncElectronPreviewHostLayout(tabId);
  scheduleElectronPreviewHostLayoutSync();
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      scheduleElectronPreviewHostLayoutSync();
    });
  });
}

async function hidePreviewHost(): Promise<void> {
  await syncElectronPreviewHostLayout();
}

/** Drop the guest document so a closed/empty preview does not resurrect the last page. */
async function clearPreviewGuest(tabId?: string): Promise<void> {
  const api = getPreviewApi();
  if (!api) return;
  const id = resolveTabId(tabId);
  clearLoadedTabGuest(id ?? undefined);
  if (api.tabs?.close && id) {
    await api.tabs.close(id);
    return;
  }
  if (api.clear) {
    await api.clear(id ?? undefined);
    return;
  }
  await api.loadURL('about:blank', id ?? undefined);
}

async function ensureElectronPreviewTab(tabId: string): Promise<void> {
  const api = getPreviewApi();
  if (!api?.tabs) return;
  const listed = await api.tabs.list();
  if (!listed.some((t) => t.id === tabId)) {
    await api.tabs.create(tabId);
  }
  await api.tabs.activate(tabId);
}

async function loadSourceInPreview(
  source: PreviewSource,
  cacheBust?: number,
  tabId?: string,
): Promise<void> {
  const api = getPreviewApi();
  if (!api) return;
  const id = resolveTabId(tabId);
  if (!id) return;
  setPreviewLoading(true, id);
  const url = resolvePreviewLoadUrl(source, cacheBust, getFileTreeListingWorkspaceRoot());

  await ensureElectronPreviewTab(id);
  await showPreviewHost();

  if (api.navigateAndWait) {
    const result = await api.navigateAndWait(url, id);
    if (!result.ok) {
      onPreviewLoadFailed(
        {
          errorCode: result.errorCode ?? -1,
          errorDescription: result.errorDescription ?? 'Navigation failed',
          url,
        },
        id,
      );
    }
    await showPreviewHost();
    scheduleElectronPreviewHostVisibilitySync();
    return;
  }

  if (api.loadSource) {
    await api.loadSource({ kind: 'url', url, cacheBust }, id);
  } else {
    await api.loadURL(url, id);
  }
  await showPreviewHost();
  scheduleElectronPreviewHostVisibilitySync();
}

// ── Embed checks ─────────────────────────────────────────────────────────────

function clearFrameBlockedTimer(): void {
  if (frameBlockedTimer) {
    clearTimeout(frameBlockedTimer);
    frameBlockedTimer = null;
  }
}

function readFrameEmbedSignals(frame: HTMLIFrameElement): {
  href: string;
  bodyText: string;
} {
  try {
    const href = frame.contentWindow?.location.href ?? '';
    const bodyText = frame.contentDocument?.body?.innerText ?? '';
    return { href, bodyText };
  } catch {
    return { href: '', bodyText: '' };
  }
}

function isExternalUrlBlockedInFrame(frame: HTMLIFrameElement): boolean {
  const { href, bodyText } = readFrameEmbedSignals(frame);
  return detectEmbedBlockedFrame(href, bodyText, { externalUrlMode: true });
}

function showEmbedBlockedNotice(externalUrl: string): void {
  const status = getStatusEl();
  const message = getStatusMessageEl();
  const link = getOpenExternalLink();
  const body = getPreviewBody();
  if (!status || !message) return;

  embedBlockedActive = true;
  message.textContent = EMBED_BLOCKED_MESSAGE;
  if (link) {
    link.href = externalUrl;
    link.classList.remove('hidden');
  }
  body?.classList.add('is-embed-blocked');
  status.hidden = false;
}

function hideEmbedBlockedNotice(): void {
  const status = getStatusEl();
  const link = getOpenExternalLink();
  const body = getPreviewBody();
  embedBlockedActive = false;
  if (status) status.hidden = true;
  if (link) {
    link.classList.add('hidden');
    link.removeAttribute('href');
  }
  body?.classList.remove('is-embed-blocked');
}

function checkExternalUrlEmbedAfterLoad(tabId?: string): void {
  const id = resolveTabId(tabId);
  const frame = id ? iframesByTabId.get(id) ?? null : getActiveFrame();
  const source = id ? getPreviewTabSource(id) : getActivePreviewSource();
  if (!frame || source?.kind !== 'url') return;

  if (isExternalUrlBlockedInFrame(frame)) {
    showEmbedBlockedNotice(source.url);
    return;
  }

  try {
    const doc = frame.contentDocument;
    if (doc && doc.body && doc.body.childElementCount === 0) {
      showEmbedBlockedNotice(source.url);
      return;
    }
  } catch {
  }

  hideEmbedBlockedNotice();
}

function scheduleFrameBlockedCheck(tabId?: string): void {
  clearFrameBlockedTimer();
  frameBlockedTimer = setTimeout(() => {
    frameBlockedTimer = null;
    checkExternalUrlEmbedAfterLoad(tabId);
  }, FRAME_BLOCKED_TIMEOUT_MS);
}

function clearPreviewFrame(tabId?: string): void {
  const id = resolveTabId(tabId);
  const frame = id ? iframesByTabId.get(id) : getActiveFrame();
  if (!frame) return;
  frame.removeAttribute('src');
  frame.src = 'about:blank';
}

function applySourceToFrame(tabId: string, source: PreviewSource, cacheBust?: number): void {
  const frame = getOrCreateFrame(tabId);
  if (!frame) return;

  embedBlockedActive = false;
  hideEmbedBlockedNotice();
  clearFrameBlockedTimer();
  if (tabId === getActivePreviewTabId()) {
    hidePreviewStatus();
    const input = getUrlInput();
    if (input) input.value = sourceToAddressBar(source);
  }

  if (source.kind === 'url') {
    frame.src = source.url;
    if (tabId === getActivePreviewTabId()) {
      scheduleFrameBlockedCheck(tabId);
    }
    return;
  }

  frame.src = workspacePreviewUrl(source.path, cacheBust, getFileTreeListingWorkspaceRoot());
}

function applySourceToPreview(source: PreviewSource, cacheBust?: number, tabId?: string): void {
  const id = resolveTabId(tabId);
  if (!id) return;
  if (usesDesignModeIframeGuest()) {
    if (id === getActivePreviewTabId()) {
      hidePreviewStatus();
      const input = getUrlInput();
      if (input) input.value = sourceToAddressBar(source);
    }
    applySourceToFrame(id, source, cacheBust);
    showActiveTabFrame();
    return;
  }
  if (usesElectronPreview()) {
    if (id === getActivePreviewTabId()) {
      hidePreviewStatus();
      const input = getUrlInput();
      if (input) input.value = sourceToAddressBar(source);
    }
    void loadSourceInPreview(source, cacheBust, id);
    return;
  }

  if (id === getActivePreviewTabId()) {
    if (source.kind === 'url') {
      showPreviewStatus(BROWSER_PREVIEW_HINT, source.url);
    } else {
      hidePreviewStatus();
    }
  }
  applySourceToFrame(id, source, cacheBust);
  showActiveTabFrame();
}

// ── Tabs and panel ───────────────────────────────────────────────────────────

export async function activatePreviewTabGuest(
  tabId: string,
  options?: { forceLoad?: boolean; slot?: PaneSlotId },
): Promise<void> {
  activatePreviewTab(tabId);
  const { showPreviewSplit } = await import('./file-layout');
  const split = await import('./right-pane-split');
  const splitLayout = split.isRightPaneSplitLayoutEnabled();

  const slotTabs = await import('./right-pane-slot-tabs');
  const targetSlot = splitLayout
    ? slotTabs.registerPreviewTabOpened(tabId, options?.slot)
    : 'primary';
  if (splitLayout) split.focusPaneSlot(targetSlot);
  showPreviewSplit({ tabId, slot: targetSlot });

  if (splitLayout && targetSlot === 'secondary') {
    const tab = getPreviewTab(tabId);
    if (!tab) return;
    const { renderSecondaryPreviewSlot } = await import('./preview-secondary-slot');
    await renderSecondaryPreviewSlot(tabId);
    return;
  }

  showActiveTabFrame();
  syncPreviewChromeFromState();

  const tab = getPreviewTab(tabId);
  if (!tab) return;

  const forceLoad = options?.forceLoad || Boolean(tab.guestCrashed);
  if (tab.guestCrashed) {
    setPreviewTabGuestCrashed(tabId, undefined);
    hidePreviewStatus();
  }

  const api = getPreviewApi();
  if (usesDesignModeIframeGuest()) {
    if (tab.source && (!loadedTabGuests.has(tabId) || forceLoad)) {
      applySourceToFrame(tabId, tab.source);
      loadedTabGuests.add(tabId);
    }
    showActiveTabFrame();
    return;
  }
  if (usesElectronPreview() && api) {
    if (api.tabs?.create) {
      const listed = await api.tabs.list();
      if (!listed.some((t) => t.id === tabId)) {
        await api.tabs.create(tabId);
      }
    }
    if (api.tabs?.activate) {
      await api.tabs.activate(tabId);
      if (!loadedTabGuests.has(tabId) || forceLoad) {
        if (tab.source) {
          await loadSourceInPreview(tab.source, undefined, tabId);
        } else {
          await clearPreviewGuest(tabId);
        }
        loadedTabGuests.add(tabId);
      }
    } else if (tab.source) {
      await loadSourceInPreview(tab.source, undefined, tabId);
      loadedTabGuests.add(tabId);
    } else {
      await clearPreviewGuest(tabId);
      loadedTabGuests.add(tabId);
    }
    await showPreviewHost();
    void syncDevToolsButtonState();
    return;
  }

  if (!usesElectronPreview()) {
    if (tab.source && (!loadedTabGuests.has(tabId) || forceLoad)) {
      applySourceToFrame(tabId, tab.source);
      loadedTabGuests.add(tabId);
    }
  }
}

async function openPreviewTabFromUi(source?: PreviewSource | null): Promise<void> {
  let opened = openPreviewTabWithCapacity(source ?? null);
  if (!opened.tab && opened.evictedId) {
    await closePreviewTabUi(opened.evictedId);
    opened = openPreviewTabWithCapacity(source ?? null, { evict: false });
  }
  if (!opened.tab) {
    showToast('Tab limit reached (6 max). Close a tab to open another.', 'error');
    return;
  }
  await activatePreviewTabGuest(opened.tab.id, { forceLoad: true });
}

async function openNewPreviewTabUi(): Promise<void> {
  await openPreviewTabFromUi(null);
  getUrlInput()?.focus();
}

export async function closePreviewTabUi(tabId: string): Promise<void> {
  const tabs = listPreviewTabs();
  const isLastTab = tabs.length <= 1;

  const slotTabs = await import('./right-pane-slot-tabs');
  const split = await import('./right-pane-split');
  const owningSlot = slotTabs.slotOwningPreviewId(tabId);

  if (usesElectronPreview()) {
    const api = getPreviewApi();
    const instanceId = owningSlot ? split.previewInstanceIdForSlot(owningSlot) : undefined;
    if (api?.tabs?.close) {
      await api.tabs.close(tabId, instanceId);
    } else {
      await clearPreviewGuest(tabId);
    }
  }
  destroyPreviewFrame(tabId);
  clearLoadedTabGuest(tabId);
  closePreviewTab(tabId);
  slotTabs.unregisterPreviewTab(tabId);
  split.collapseEmptySlots();

  if (isLastTab) {
    cancelDeferredPreviewLoad();
    hidePreviewStatus();
    setPreviewLoading(false);
    if (listViewerTabs().length > 0) {
      showViewerSplit();
    } else {
      if (usesElectronPreview()) {
        await hidePreviewHost();
      }
      hidePreviewSplit();
    }
    scheduleElectronPreviewHostVisibilitySync();
    return;
  }

  const nextId = getActivePreviewTabId();
  if (nextId) {
    await activatePreviewTabGuest(nextId);
  }
}

/** Load the given source into the active preview tab and persist state. */
export function loadPreviewSource(source: PreviewSource, options?: { cacheBust?: boolean }): void {
  const tabId = getActivePreviewTabId() ?? ensureDefaultPreviewTab().id;
  const tab = getPreviewTab(tabId);
  const bust = options?.cacheBust ? Date.now() : undefined;
  if (!sourcesEqual(tab?.source ?? null, source)) {
    updatePreviewTabSource(tabId, source);
  }
  applySourceToPreview(source, bust, tabId);
}

/** Show the preview split + Electron guest when browser_navigate runs on Code / Orchestrate. */
export async function revealPreviewPanelForAgentNavigation(
  url: string,
  requestedTabId?: string,
): Promise<void> {
  const trimmed = url.trim();
  if (!trimmed) return;

  const desktopHosted = false;
  if (!(await dismissFileViewerForPreview())) {
    return;
  }

  await applyAgentPreviewNavigation(trimmed, desktopHosted, requestedTabId);
}

async function applyAgentPreviewNavigation(
  url: string,
  desktopHosted: boolean,
  requestedTabId?: string,
): Promise<void> {
  if (!desktopHosted && !(await dismissFileViewerForPreview())) return;

  const tabId = requestedTabId?.trim() || getActivePreviewTabId() || ensureDefaultPreviewTab().id;
  updatePreviewTabSource(tabId, { kind: 'url', url });
  hidePreviewStatus();
  setPreviewLoading(true);
  const input = getUrlInput();
  if (input) input.value = url;

  const allowedToShow = desktopHosted || canAgentRevealPreviewPanel();
  if (!allowedToShow) {
    if (usesElectronPreview()) {
      const api = getPreviewApi();
      await api?.hide();
    }
    return;
  }

  if (!desktopHosted) {
    showPreviewSplit();
  }

  if (!usesElectronPreview()) {
    loadPreviewSource({ kind: 'url', url });
    return;
  }

  await syncElectronPreviewHostLayout(tabId);
}

/**
 * Open an http(s) URL in the in-app preview panel (hub dev-server link, etc.).
 */
export async function openUrlInPreviewPanel(url: string): Promise<void> {
  const trimmed = url.trim();
  if (!trimmed || !HTTP_URL_RE.test(trimmed)) return;
  if (!(await dismissFileViewerForPreview())) return;

  const api = getPreviewApi();
  if (!api) {
    await openPreviewPanel({ kind: 'url', url: trimmed });
    return;
  }

  await revealPreviewPanelForAgentNavigation(trimmed);
  scheduleElectronPreviewHostVisibilitySync();

  if (api.navigateAndWait) {
    const result = await api.navigateAndWait(trimmed);
    if (!result.ok) {
      showPreviewStatus(
        result.errorDescription?.trim() || 'Preview failed to load',
        trimmed,
      );
      return;
    }
    hidePreviewStatus();
    scheduleElectronPreviewHostVisibilitySync();
    return;
  }

  await loadSourceInPreview({ kind: 'url', url: trimmed });
  scheduleElectronPreviewHostVisibilitySync();
}

/** Open the preview panel with an optional initial source. */
export async function openPreviewPanel(source?: PreviewSource | null): Promise<void> {
  if (!(await dismissFileViewerForPreview())) return;
  showPreviewSplit();
  const resolved = source ?? getActivePreviewSource();
  const tabId = getActivePreviewTabId() ?? ensureDefaultPreviewTab().id;

  if (usesElectronPreview()) {
    if (!resolved) {
      updatePreviewTabSource(tabId, null);
      await clearPreviewGuest(tabId);
      await showPreviewHost();
      scheduleElectronPreviewHostVisibilitySync();
    } else {
      updatePreviewTabSource(tabId, resolved);
      await activatePreviewTabGuest(tabId, { forceLoad: true });
      syncPreviewChromeFromState();
      return;
    }
  } else if (resolved) {
    loadPreviewSource(resolved);
  } else {
    const input = getUrlInput();
    if (input) input.value = '';
    hidePreviewStatus();
    clearPreviewFrame();
  }
  syncPreviewChromeFromState();
}

/** Close the preview panel. */
export function closePreviewPanel(): void {
  cancelDeferredPreviewLoad();
  if (isDesignModeEnabled(DESIGN_MODE_INSTANCE_ID)) {
    disableDesignMode(DESIGN_MODE_INSTANCE_ID);
    getDesignToggleButton()?.setAttribute('aria-pressed', 'false');
    getDesignToggleButton()?.classList.remove('is-active');
    syncAnnotationsToggleVisibility(true);
    void syncDesignModeElectronGuest();
  }
  if (usesElectronPreview()) {
    void clearPreviewGuest().then(() => hidePreviewHost());
  } else {
    clearFrameBlockedTimer();
    clearPreviewFrame();
  }
  hidePreviewSplit();
  hidePreviewStatus();
  setPreviewLoading(false);
}

/** Collapse the preview split on Code app entry without discarding previewSource (MIN-342). */
export function collapsePreviewPanelKeepingSource(): void {
  resetRightSplitForCodeEntry();
  cancelDeferredPreviewLoad();
  clearLoadedTabGuest();
  if (usesElectronPreview()) {
    void clearPreviewGuest().then(() => hidePreviewHost());
  } else {
    clearFrameBlockedTimer();
    clearPreviewFrame();
  }
  hidePreviewStatus();
  setPreviewLoading(false);
}

/** Toggle preview panel using last source or empty address bar. */
export function togglePreviewPanel(): void {
  const state = getFilePanelState();
  if (state.rightPaneMode === 'preview') {
    closePreviewPanel();
    return;
  }
  openPreviewPanel(state.previewSource);
}

// ── Reload and IPC ───────────────────────────────────────────────────────────

function reloadPreview(): void {
  const now = Date.now();
  if (now - lastReloadAt < MIN_RELOAD_INTERVAL_MS) return;
  lastReloadAt = now;

  const tabId = getActivePreviewTabId();
  const crashedTab = tabId ? getPreviewTab(tabId) : null;
  if (crashedTab?.guestCrashed && tabId) {
    void activatePreviewTabGuest(tabId, { forceLoad: true });
    return;
  }

  const api = getPreviewApi();
  const activeSource = getActivePreviewSource();
  if (!activeSource) {
    const input = getUrlInput();
    const parsed = input ? parseAddressInput(input.value) : null;
    if (parsed) {
      loadPreviewSource(parsed, { cacheBust: true });
    }
    return;
  }

  if (usesDesignModeIframeGuest()) {
    if (activeSource.kind === 'workspace') {
      loadPreviewSource(activeSource, { cacheBust: true });
    } else {
      const frame = getActiveFrame();
      const id = tabId ?? getActivePreviewTabId();
      try {
        frame?.contentWindow?.location.reload();
      } catch {
        if (id) applySourceToFrame(id, activeSource, Date.now());
      }
    }
    return;
  }

  if (api && activeSource.kind === 'workspace') {
    loadPreviewSource(activeSource, { cacheBust: true });
    return;
  }

  if (api) {
    setPreviewLoading(true);
    void api.reload(getActivePreviewTabId() ?? undefined);
    return;
  }

  loadPreviewSource(activeSource, { cacheBust: true });
}

function navigateFromAddressBar(): void {
  const input = getUrlInput();
  if (!input) return;
  const parsed = parseAddressInput(input.value);
  if (!parsed) {
    showPreviewStatus('Enter a workspace path or https:// URL.');
    return;
  }
  loadPreviewSource(parsed);
}

function syncPreviewChromeFromState(): void {
  const state = getFilePanelState();
  const checkbox = getAutoReloadCheckbox();
  if (checkbox) checkbox.checked = state.previewAutoReload;
  const source = getActivePreviewSource();
  if (source) {
    const input = getUrlInput();
    if (input) input.value = sourceToAddressBar(source);
  }
}

function pathsMatchForReload(savedPath: string, previewPath: string): boolean {
  const a = normalizeWorkspacePath(savedPath);
  const b = normalizeWorkspacePath(previewPath);
  return a === b;
}

/** Before/after diff capture (MIN-370 P1): only meaningful while Design Mode is on for this instance (the proxy this module uses for "the user is doing iterative visual work" — there's no direct signal here for which chat turn "owns" a given tool-driven file save). */
function notifyDesignFileSavedIfLinked(path: string): void {
  if (!isDesignModeEnabled(DESIGN_MODE_INSTANCE_ID)) return;
  const chat = getActiveChat();
  if (!chat?.id) return;
  const turnId = String(chat.history.length);
  void notifyDesignFileSaved(chat.id, turnId, path);
}

function onPreviewReloadSettled(): void {
  if (!isDesignModeEnabled(DESIGN_MODE_INSTANCE_ID)) return;
  if (getDesignModeSession(DESIGN_MODE_INSTANCE_ID)?.getArmedToolId() === 'select') {
    refreshDesignModeArmedToolGuest(DESIGN_MODE_INSTANCE_ID);
  }
  const pageKey = currentPreviewPageRef();
  if (pageKey) {
    void gatherAnchorCandidates().then(async (candidates) => {
      const result = await healPageAnnotations(pageKey, candidates);
      const session = getDesignModeSession(DESIGN_MODE_INSTANCE_ID);
      if (!session) return;
      session.overlay.renderShapes(result.data.shapes, (shapeId) => {
        const shape = result.data.shapes.find((s) => s.id === shapeId);
        const link = shape?.links?.[0];
        if (link) void import('../design/annotation-nav').then((m) => m.jumpToChatTurn(link.chatId, link.turnId));
      });
      session.overlay.renderPins(result.data.pins);
      void refreshAnnotationsPanel();
    });
  }

  const chat = getActiveChat();
  if (chat?.id) void notifyDesignReloadSettled(chat.id);
}

function onWorkspaceFileSaved(path: string): void {
  const state = getFilePanelState();
  if (!state.previewAutoReload || state.rightPaneMode !== 'preview') return;
  const activeSource = getActivePreviewSource();
  if (!activeSource || activeSource.kind !== 'workspace') return;
  if (!pathsMatchForReload(path, activeSource.path)) return;

  notifyDesignFileSavedIfLinked(path);

  if (autoReloadDebounce) clearTimeout(autoReloadDebounce);
  autoReloadDebounce = setTimeout(() => {
    autoReloadDebounce = null;
    if (usesDesignModeIframeGuest()) {
      reloadPreview();
      return;
    }
    const api = getPreviewApi();
    if (api) {
      setPreviewLoading(true);
      void api.reload();
      return;
    }
    reloadPreview();
  }, 250);
}

function bindPreviewIpcListeners(): void {
  const api = getPreviewApi();
  if (!api) return;

  unsubscribeNavigation?.();
  unsubscribeLoading?.();
  unsubscribeLoadFailed?.();
  unsubscribePageTitle?.();
  unsubscribeGuestCrashed?.();

  unsubscribeNavigation = api.onNavigation((url, tabId) => {
    onPreviewNavigation(url, tabId);
  });
  unsubscribeLoading = api.onLoading((loading, tabId) => {
    setPreviewLoading(loading, tabId);
    if (!loading && usesElectronPreview() && resolveTabId(tabId) === getActivePreviewTabId()) {
      void showPreviewHost();
      onPreviewReloadSettled();
    }
  });
  unsubscribeLoadFailed = api.onLoadFailed((detail, tabId) => {
    onPreviewLoadFailed(detail, tabId);
  });
  unsubscribePageTitle = api.onPageTitle((title, tabId) => {
    const id = resolveTabId(tabId);
    if (id && title.trim()) setPreviewTabTitle(id, title);
  });
  unsubscribeGuestCrashed = api.onGuestCrashed?.((detail, tabId) => {
    onPreviewGuestCrashed(detail, tabId);
  }) ?? null;
  unsubscribeDevToolsState?.();
  unsubscribeDevToolsState = api.devtools?.onState((open, tabId, instanceId) => {
    if (instanceId && instanceId !== 'workspace-preview') return;
    if (resolveTabId(tabId) !== getActivePreviewTabId()) return;
    setDevToolsButtonPressed(open);
  }) ?? null;
}

function goBackInFrame(): void {
  const frame = getActiveFrame();
  try {
    frame?.contentWindow?.history.back();
  } catch {
  }
}

function goForwardInFrame(): void {
  const frame = getActiveFrame();
  try {
    frame?.contentWindow?.history.forward();
  } catch {
  }
}

function bindPreviewControls(): void {
  if (controlsBound) return;
  controlsBound = true;

  markPreviewHostMode();

  document.getElementById('btnPreviewBack')?.addEventListener('click', () => {
    const tabId = getActivePreviewTabId() ?? undefined;
    if (usesElectronPreview()) {
      void getPreviewApi()?.goBack(tabId);
    } else {
      goBackInFrame();
    }
  });
  document.getElementById('btnPreviewForward')?.addEventListener('click', () => {
    const tabId = getActivePreviewTabId() ?? undefined;
    if (usesElectronPreview()) {
      void getPreviewApi()?.goForward(tabId);
    } else {
      goForwardInFrame();
    }
  });
  document.getElementById('btnPreviewReload')?.addEventListener('click', () => reloadPreview());
  document.getElementById('btnPreviewGo')?.addEventListener('click', () => navigateFromAddressBar());
  document.getElementById('btnPreviewClose')?.addEventListener('click', () => closePreviewPanel());
  const agentBrowserViewerButton = document.getElementById('btnAgentBrowserViewer') as HTMLButtonElement | null;
  if (agentBrowserViewerButton) {
    if (!window.minnow?.window?.openAgentBrowserViewer) {
      agentBrowserViewerButton.hidden = true;
    } else {
      agentBrowserViewerButton.addEventListener('click', () => {
        void window.minnow?.window?.openAgentBrowserViewer?.().then((result) => {
          if (result?.ok) return;
          void import('./toast').then((m) => m.showToast(result?.error || 'Could not open Agent Browser', 'error'));
        });
      });
    }
  }
  document
    .getElementById('btnPreviewDesignToggle')
    ?.addEventListener('click', () => void toggleDesignModeFromToolbar());
  document
    .getElementById('btnPreviewAnnotationsToggle')
    ?.addEventListener('click', () => void toggleAnnotationsPanel());

  const devToolsBtn = getDevToolsButton();
  if (devToolsBtn && getPreviewApi()?.devtools) {
    devToolsBtn.hidden = false;
    devToolsBtn.addEventListener('click', () => void toggleDevToolsFromToolbar());
    const dockBtn = getDevToolsDockButton();
    if (dockBtn) {
      dockBtn.addEventListener('click', () => toggleDevToolsDockFromToolbar());
    }
    document.addEventListener('keydown', (e) => {
      if (!isDevToolsShortcut(e)) return;
      if (!isPreviewPaneDomVisible()) return;
      e.preventDefault();
      void toggleDevToolsFromToolbar();
    });
  }

  getUrlInput()?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      navigateFromAddressBar();
    }
  });

  getAutoReloadCheckbox()?.addEventListener('change', (e) => {
    const checked = (e.target as HTMLInputElement).checked;
    patchFilePanelState({ previewAutoReload: checked });
  });

  getOpenExternalLink()?.addEventListener('click', (e) => {
    const href = getOpenExternalLink()?.href;
    if (!href) return;
    if (window.minnow?.app.openExternal) {
      e.preventDefault();
      void window.minnow.app.openExternal(href);
    }
  });

  registerPreviewTabHandlers({
    onActivate: (id) => {
      void activatePreviewTabGuest(id);
    },
    onClose: (id) => {
      void closePreviewTabUi(id);
    },
    onNew: () => {
      void openNewPreviewTabUi();
    },
  });
  bindPreviewTabs();

  onFileSaved(onWorkspaceFileSaved);
  onBeforeAfterPair((chatId) => {
    if (getActiveChat().id !== chatId) return;
    void import('./messages').then((m) => m.renderChatFromHistory(getActiveChat()));
  });
  bindPreviewIpcListeners();
  startBoundsObserver();

  const back = getBackButton();
  const forward = getForwardButton();
  if (back) back.disabled = false;
  if (forward) forward.disabled = false;
}

function cancelDeferredPreviewLoad(): void {
  if (deferredPreviewLoadTimer) {
    clearTimeout(deferredPreviewLoadTimer);
    deferredPreviewLoadTimer = null;
  }
}

/** Wait until the shell has finished loading before hitting preview routes (avoids socket storms in cloud). */
function scheduleDeferredPreviewLoad(source: PreviewSource | null): void {
  cancelDeferredPreviewLoad();
  const run = (): void => {
    deferredPreviewLoadTimer = null;
    if (getFilePanelState().rightPaneMode !== 'preview') return;
    if (source) {
      loadPreviewSource(source);
    } else if (!usesElectronPreview()) {
      clearPreviewFrame();
    } else {
      void clearPreviewGuest();
    }
    if (usesElectronPreview()) {
      scheduleElectronPreviewHostLayoutSync();
    }
  };

  const defer = (): void => {
    deferredPreviewLoadTimer = setTimeout(run, DEFERRED_PREVIEW_LOAD_MS);
  };

  if (document.readyState === 'complete') {
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(defer, { timeout: 4000 });
    } else {
      defer();
    }
    return;
  }

  window.addEventListener('load', defer, { once: true });
}

/** Restore preview chrome without loading the guest until the app shell is idle. */
async function restorePreviewPanelFromPrefs(): Promise<void> {
  if (!(await dismissFileViewerForPreview())) {
    patchFilePanelState({ rightPaneMode: null, viewerOpen: false });
    return;
  }
  showPreviewSplit();
  const active = getActivePreviewTab();
  applyPersistedPreviewGuest(active?.source ?? null, { deferLoad: true });
}

/** Re-attach the Electron guest (or iframe) after the preview pane is visible again. */
export function resyncOpenPreviewPanelFromState(options?: { reload?: boolean }): void {
  const state = getFilePanelState();
  if (state.rightPaneMode !== 'preview') return;
  if (!isPreviewPaneDomVisible()) return;
  if (isCodeAppForeground() && !shouldAutoRestorePreviewPanel()) return;

  syncPreviewChromeFromState();

  if (usesElectronPreview()) {
    void showPreviewHost();
  }

  const source = getActivePreviewSource();
  if (!source) {
    if (!usesElectronPreview()) {
      const tabId = getActivePreviewTabId();
      if (tabId) clearPreviewFrame(tabId);
    }
    return;
  }

  if (options?.reload) {
    loadPreviewSource(source);
    if (usesElectronPreview()) {
      scheduleElectronPreviewHostVisibilitySync();
    }
    return;
  }

  if (!usesElectronPreview()) {
    const tabId = getActivePreviewTabId();
    const frame = tabId ? iframesByTabId.get(tabId) : null;
    const href = frame?.src?.trim() ?? '';
    if (!href || href === 'about:blank') {
      loadPreviewSource(source);
    }
  }
}

/** Show preview chrome and load persisted source (optional deferred guest fetch). */
function applyPersistedPreviewGuest(
  source: PreviewSource | null,
  options?: { deferLoad?: boolean },
): void {
  if (usesElectronPreview()) {
    void showPreviewHost();
  }
  syncPreviewChromeFromState();
  const input = getUrlInput();
  if (source && input) {
    input.value = sourceToAddressBar(source);
  }
  if (options?.deferLoad) {
    scheduleDeferredPreviewLoad(source);
    return;
  }
  if (source) {
    loadPreviewSource(source);
  } else if (!usesElectronPreview()) {
    clearPreviewFrame();
  } else {
    void clearPreviewGuest();
  }
}

// ── Init ─────────────────────────────────────────────────────────────────────

/** Wire preview UI after file panel boot. */
export async function initPreviewPanel(): Promise<void> {
  const state = getFilePanelState();
  const browserMeta = await loadBrowserMeta();

  if (!browserMeta.restoreBrowserTabs) {
    ensureDefaultPreviewTab();
  } else if (state.previewTabs.length > 0) {
    restorePreviewTabs(state.previewTabs, state.activePreviewTab);
  } else {
    migrateLegacyPreviewSource(state.previewSource);
    ensureDefaultPreviewTab();
  }

  bindPreviewControls();
  void import('./preview-context-menu-handler').then((m) => m.initPreviewContextMenuHandler());
  await syncPreviewDesignToolbarForSurface();
  await syncPreviewDevToolsDockToHost();

  if (shouldAutoRestorePreviewPanel()) {
    await restorePreviewPanelFromPrefs();
    if (usesElectronPreview()) {
      scheduleElectronPreviewHostVisibilitySync();
    }
    return;
  }
  if (isCodeAppForeground() || state.rightPaneMode === 'preview') {
    collapsePreviewPanelKeepingSource();
  }

  if (usesElectronPreview()) {
    scheduleElectronPreviewHostVisibilitySync();
  }
}

/** Open a workspace HTML file in the preview panel. */
export function openWorkspacePathInPreview(relativePath: string): void {
  void openPreviewTabFromUi({
    kind: 'workspace',
    path: normalizeWorkspacePath(relativePath),
  });
}
