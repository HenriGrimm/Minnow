import {
  BrowserWindow,
  WebContentsView,
  ipcMain,
  session,
  shell,
  type IpcMainInvokeEvent,
  type WebContents,
} from 'electron';
import { randomUUID } from 'node:crypto';
import * as channels from './ipc-channels.js';
import {
  previewCapturePageBase64,
  previewClearGuest,
  previewExecJs,
  previewGetGuestInfo,
  previewNavigateAwait,
} from './preview-guest-actions.js';
import { PreviewInstanceRegistry, DEFAULT_PREVIEW_INSTANCE_ID } from './preview-instance-registry.js';
import {
  resolvePreviewGuestAttachMode,
  shouldKeepPreviewGuestVisibleAfterCapture,
} from './preview-guest-reveal.js';
import { configurePreviewSession, PREVIEW_SESSION_PARTITION } from './preview-session.js';
import { enableCdpPicking, type CdpPickSession } from './preview-cdp-pick.js';
import {
  handleGuestContextMenu,
  registerPreviewContextMenuIpc,
} from './preview-context-menu.js';
import { splitPreviewBounds, type DevToolsDockPosition } from './preview-devtools-layout.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface PreviewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PreviewLoadSourcePayload {
  kind: 'workspace' | 'url';
  path?: string;
  url?: string;
  cacheBust?: number;
}

interface PreviewHostEntry {
  view: WebContentsView;
  visible: boolean;
  devtools: WebContentsView | null;
  devtoolsPopout: BrowserWindow | null;
}

interface WindowPreviewState {
  tabs: Map<string, PreviewHostEntry>;
  activeTabId: string | null;
}

// ── Registry ─────────────────────────────────────────────────────────────────

const previewInstances = new PreviewInstanceRegistry<WindowPreviewState>({
  createState: () => ({ tabs: new Map(), activeTabId: null }),
  onEvict: (windowId, instanceId, state) => {
    evictInstanceState(windowId, instanceId, state);
  },
});

const wiredWindowIds = new Set<number>();

const cdpPickSessions = new Map<number, CdpPickSession>();

const lastBoundsByInstance = new Map<string, PreviewBounds>();

const devtoolsDockByWindow = new Map<number, DevToolsDockPosition>();

function resolveDevToolsDock(win: BrowserWindow): DevToolsDockPosition {
  return devtoolsDockByWindow.get(win.id) ?? 'bottom';
}

function normalizeDevToolsDock(dock: unknown): DevToolsDockPosition {
  if (dock === 'side' || dock === 'popout') return dock;
  return 'bottom';
}

function isEntryDevToolsOpen(entry: PreviewHostEntry): boolean {
  return Boolean(entry.devtools) || Boolean(entry.devtoolsPopout);
}

function relayoutAllVisibleEntries(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  const zoom = hostZoomFactor(win);
  for (const instanceId of previewInstances.listInstanceIds(win.id)) {
    const state = previewInstances.get(win.id, instanceId);
    if (!state) continue;
    const bounds = lastBoundsByInstance.get(boundsKey(win.id, instanceId));
    if (!isValidPreviewBounds(bounds)) continue;
    for (const entry of state.tabs.values()) {
      if (!entry.visible) continue;
      applyPreviewViewBounds(entry, bounds, zoom, resolveDevToolsDock(win));
    }
  }
}

function boundsKey(windowId: number, instanceId: string): string {
  return `${windowId}::${instanceId}`;
}

function rememberPreviewBounds(win: BrowserWindow, bounds: PreviewBounds, instanceId?: string): void {
  if (isValidPreviewBounds(bounds)) {
    const id = PreviewInstanceRegistry.resolveInstanceId(instanceId);
    lastBoundsByInstance.set(boundsKey(win.id, id), bounds);
  }
}

// ── Window wiring ────────────────────────────────────────────────────────────

function ensurePreviewSession(): void {
  configurePreviewSession(session.fromPartition(PREVIEW_SESSION_PARTITION));
}

function ensureWindowWiring(win: BrowserWindow): void {
  if (wiredWindowIds.has(win.id)) return;
  wiredWindowIds.add(win.id);
  win.webContents.on('did-finish-load', () => {
    detachAllInstanceViews(win);
  });
  win.once('closed', () => {
    destroyHostForWindow(win);
  });
}

function windowState(win: BrowserWindow, instanceId?: string): WindowPreviewState {
  ensureWindowWiring(win);
  return previewInstances.ensure(win.id, instanceId);
}

function windowFromInvoke(event: IpcMainInvokeEvent): BrowserWindow | null {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return null;
  return win;
}

function sendToRenderer(win: BrowserWindow, channel: string, ...args: unknown[]): void {
  if (win.isDestroyed()) return;
  win.webContents.send(channel, ...args);
}

function resolveTabId(win: BrowserWindow, tabId: string | undefined, instanceId?: string): string | null {
  const state = windowState(win, instanceId);
  if (typeof tabId === 'string' && tabId.trim()) return tabId.trim();
  if (state.activeTabId) return state.activeTabId;
  const first = state.tabs.keys().next().value as string | undefined;
  return first ?? null;
}

function attachPermissionHandler(wc: WebContents): void {
  wc.session.setPermissionRequestHandler((_webContents, permission, callback) => {
    const denyByDefault = new Set([
      'media',
      'geolocation',
      'notifications',
      'microphone',
      'camera',
    ]);
    callback(!denyByDefault.has(permission));
  });
}

// ── DevTools ─────────────────────────────────────────────────────────────────

// closeDevTools() is a no-op when DevTools uses setDevToolsWebContents; destroy the view instead.
function teardownEntryDevTools(win: BrowserWindow | null, entry: PreviewHostEntry): void {
  const popout = entry.devtoolsPopout;
  if (popout && !popout.isDestroyed()) {
    entry.devtoolsPopout = null;
    popout.removeAllListeners('closed');
    popout.close();
    const wc = entry.view.webContents;
    if (!wc.isDestroyed()) {
      try {
        wc.closeDevTools();
      } catch {
      }
    }
    return;
  }
  entry.devtoolsPopout = null;

  const dt = entry.devtools;
  if (!dt) return;
  entry.devtools = null;
  if (win && !win.isDestroyed()) {
    try {
      win.contentView.removeChildView(dt);
    } catch {
    }
  }
  try {
    if (!dt.webContents.isDestroyed()) {
      dt.webContents.close();
    }
  } catch {
  }
}

function closeEntryDevTools(
  win: BrowserWindow,
  tabId: string,
  entry: PreviewHostEntry,
  instanceId?: string,
): void {
  if (!isEntryDevToolsOpen(entry)) return;
  const id = PreviewInstanceRegistry.resolveInstanceId(instanceId);
  teardownEntryDevTools(win.isDestroyed() ? null : win, entry);
  relayoutInstanceEntry(win, entry, id);
  sendToRenderer(win, channels.PREVIEW_DEVTOOLS_STATE, tabId, false, id);
}

function relayoutInstanceEntry(win: BrowserWindow, entry: PreviewHostEntry, instanceId?: string): void {
  if (!entry.visible || win.isDestroyed()) return;
  const id = PreviewInstanceRegistry.resolveInstanceId(instanceId);
  const bounds = lastBoundsByInstance.get(boundsKey(win.id, id));
  if (!isValidPreviewBounds(bounds)) return;
  applyPreviewViewBounds(entry, bounds, hostZoomFactor(win), resolveDevToolsDock(win));
}

function positionPopoutDevToolsWindow(parent: BrowserWindow, popout: BrowserWindow): void {
  const parentBounds = parent.getBounds();
  popout.setBounds({
    x: parentBounds.x + Math.min(parentBounds.width - 200, 80),
    y: parentBounds.y + 48,
    width: Math.max(640, Math.round(parentBounds.width * 0.55)),
    height: Math.max(480, Math.round(parentBounds.height * 0.7)),
  });
}

function createPopoutDevToolsWindow(): BrowserWindow {
  return new BrowserWindow({
    show: false,
    title: 'DevTools',
    autoHideMenuBar: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
}

function wirePopoutDevToolsClosed(
  win: BrowserWindow,
  tabId: string,
  entry: PreviewHostEntry,
  instanceId: string,
  popout: BrowserWindow,
): void {
  const wc = entry.view.webContents;
  popout.on('closed', () => {
    if (entry.devtoolsPopout !== popout) return;
    entry.devtoolsPopout = null;
    if (!wc.isDestroyed()) {
      try {
        wc.closeDevTools();
      } catch {
      }
    }
    relayoutInstanceEntry(win, entry, instanceId);
    if (!win.isDestroyed()) {
      sendToRenderer(win, channels.PREVIEW_DEVTOOLS_STATE, tabId, false, instanceId);
    }
  });
}

function openPopoutEntryDevTools(
  win: BrowserWindow,
  tabId: string,
  entry: PreviewHostEntry,
  instanceId: string,
): void {
  const wc = entry.view.webContents;
  const popout = createPopoutDevToolsWindow();
  entry.devtoolsPopout = popout;
  positionPopoutDevToolsWindow(win, popout);
  wirePopoutDevToolsClosed(win, tabId, entry, instanceId, popout);

  wc.setDevToolsWebContents(popout.webContents);
  wc.openDevTools({ mode: 'detach', activate: true });
  popout.show();
  relayoutInstanceEntry(win, entry, instanceId);
  sendToRenderer(win, channels.PREVIEW_DEVTOOLS_STATE, tabId, true, instanceId);
}

function migrateEntryDevToolsDock(
  win: BrowserWindow,
  tabId: string,
  entry: PreviewHostEntry,
  instanceId: string,
  dock: DevToolsDockPosition,
): void {
  if (!isEntryDevToolsOpen(entry)) return;
  const wc = entry.view.webContents;
  if (wc.isDestroyed() || win.isDestroyed()) return;

  if (dock === 'popout') {
    if (entry.devtoolsPopout) return;
    if (!entry.devtools) {
      openPopoutEntryDevTools(win, tabId, entry, instanceId);
      return;
    }

    const embedded = entry.devtools;
    const popout = createPopoutDevToolsWindow();
    entry.devtoolsPopout = popout;
    positionPopoutDevToolsWindow(win, popout);
    wirePopoutDevToolsClosed(win, tabId, entry, instanceId, popout);

    wc.setDevToolsWebContents(popout.webContents);
    entry.devtools = null;
    try {
      win.contentView.removeChildView(embedded);
    } catch {
    }
    try {
      if (!embedded.webContents.isDestroyed()) {
        embedded.webContents.close();
      }
    } catch {
    }
    popout.show();
    relayoutInstanceEntry(win, entry, instanceId);
    return;
  }

  if (entry.devtools && !entry.devtoolsPopout) {
    relayoutInstanceEntry(win, entry, instanceId);
    return;
  }

  const popout = entry.devtoolsPopout;
  if (!popout) return;

  const devtoolsView = new WebContentsView();
  devtoolsView.setVisible(false);
  entry.devtools = devtoolsView;
  try {
    win.contentView.addChildView(devtoolsView);
  } catch {
  }

  wc.setDevToolsWebContents(devtoolsView.webContents);
  entry.devtoolsPopout = null;
  popout.removeAllListeners('closed');
  if (!popout.isDestroyed()) {
    popout.close();
  }
  relayoutInstanceEntry(win, entry, instanceId);
}

function openEntryDevTools(
  win: BrowserWindow,
  tabId: string,
  entry: PreviewHostEntry,
  instanceId?: string,
): void {
  if (isEntryDevToolsOpen(entry)) return;
  const wc = entry.view.webContents;
  if (wc.isDestroyed() || win.isDestroyed()) return;
  const id = PreviewInstanceRegistry.resolveInstanceId(instanceId);
  const dock = resolveDevToolsDock(win);

  if (dock === 'popout') {
    openPopoutEntryDevTools(win, tabId, entry, id);
    return;
  }

  const devtoolsView = new WebContentsView();
  devtoolsView.setVisible(false);
  entry.devtools = devtoolsView;
  try {
    win.contentView.addChildView(devtoolsView);
  } catch {
  }
  wc.setDevToolsWebContents(devtoolsView.webContents);
  wc.openDevTools({ mode: 'detach', activate: false });
  relayoutInstanceEntry(win, entry, id);
  sendToRenderer(win, channels.PREVIEW_DEVTOOLS_STATE, tabId, true, id);
}

// ── Guest events ─────────────────────────────────────────────────────────────

function wirePreviewGuestEvents(win: BrowserWindow, tabId: string, entry: PreviewHostEntry, instanceId: string): void {
  const wc = entry.view.webContents;
  let suppressNavigationUntilFailHandled = false;

  const emitNavigation = (url: string): void => {
    if (suppressNavigationUntilFailHandled) return;
    sendToRenderer(win, channels.PREVIEW_NAVIGATION, tabId, url, instanceId);
  };

  wc.on('did-start-loading', () => {
    suppressNavigationUntilFailHandled = false;
    sendToRenderer(win, channels.PREVIEW_LOADING, tabId, true, instanceId);
  });

  wc.on('did-stop-loading', () => {
    sendToRenderer(win, channels.PREVIEW_LOADING, tabId, false, instanceId);
    if (!suppressNavigationUntilFailHandled) {
      emitNavigation(wc.getURL());
    }
  });

  wc.on('did-navigate', (_event, url) => {
    emitNavigation(url);
  });

  wc.on('did-navigate-in-page', (_event, url) => {
    emitNavigation(url);
  });

  wc.on('page-title-updated', (_event, title) => {
    sendToRenderer(win, channels.PREVIEW_PAGE_TITLE, tabId, title, instanceId);
  });

  wc.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return;
      if (errorCode === -3) return;
      suppressNavigationUntilFailHandled = true;
      sendToRenderer(win, channels.PREVIEW_LOADING, tabId, false, instanceId);
      sendToRenderer(win, channels.PREVIEW_LOAD_FAILED, tabId, {
        errorCode,
        errorDescription,
        url: validatedURL,
      }, instanceId);
    },
  );

  wc.setWindowOpenHandler(({ url }) => {
    if (url) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  wc.on('render-process-gone', (_event, details) => {
    handleTabGuestCrash(win, tabId, details.reason, details.exitCode, instanceId);
  });

  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = input.key.toLowerCase();
    const combo =
      input.key === 'F12' ||
      (input.control && input.shift && key === 'i') ||
      (input.meta && input.alt && key === 'i');
    if (!combo) return;
    event.preventDefault();
    if (isEntryDevToolsOpen(entry)) {
      closeEntryDevTools(win, tabId, entry, instanceId);
    } else {
      openEntryDevTools(win, tabId, entry, instanceId);
    }
  });

  wc.on('devtools-closed', () => {
    if (!wc.isDestroyed() && wc.isDevToolsOpened()) return;
    if (!isEntryDevToolsOpen(entry)) return;
    teardownEntryDevTools(win.isDestroyed() ? null : win, entry);
    relayoutInstanceEntry(win, entry, instanceId);
    sendToRenderer(win, channels.PREVIEW_DEVTOOLS_STATE, tabId, false, instanceId);
  });

  wc.on('context-menu', (event, params) => {
    event.preventDefault();
    handleGuestContextMenu(win, tabId, instanceId, entry, params);
  });
}

// ── Destroy guests ───────────────────────────────────────────────────────────

function destroyGuestEntry(win: BrowserWindow | null, entry: PreviewHostEntry): void {
  teardownEntryDevTools(win, entry);
  if (win && !win.isDestroyed()) {
    try {
      win.contentView.removeChildView(entry.view);
    } catch {
    }
  }
  if (!entry.view.webContents.isDestroyed()) {
    entry.view.webContents.close();
  }
}

function handleTabGuestCrash(
  win: BrowserWindow,
  tabId: string,
  reason: string,
  exitCode: number,
  instanceId?: string,
): void {
  const state = previewInstances.get(win.id, instanceId);
  const entry = state?.tabs.get(tabId);
  if (!entry || !state) return;

  state.tabs.delete(tabId);
  destroyGuestEntry(win, entry);

  sendToRenderer(win, channels.PREVIEW_GUEST_CRASHED, tabId, {
    reason,
    exitCode,
  }, PreviewInstanceRegistry.resolveInstanceId(instanceId));
}

function destroyTabGuest(win: BrowserWindow, tabId: string, instanceId?: string): void {
  const state = windowState(win, instanceId);
  const entry = state.tabs.get(tabId);
  if (!entry) return;
  state.tabs.delete(tabId);
  if (state.activeTabId === tabId) {
    state.activeTabId = state.tabs.keys().next().value ?? null;
  }
  destroyGuestEntry(win, entry);
}

function evictInstanceState(windowId: number, instanceId: string, state: WindowPreviewState): void {
  const win = BrowserWindow.fromId(windowId);
  for (const entry of state.tabs.values()) {
    destroyGuestEntry(win && !win.isDestroyed() ? win : null, entry);
  }
  lastBoundsByInstance.delete(boundsKey(windowId, instanceId));
}

function destroyInstance(win: BrowserWindow, instanceId?: string): void {
  const state = previewInstances.delete(win.id, instanceId);
  if (!state) return;
  for (const entry of state.tabs.values()) {
    destroyGuestEntry(win, entry);
  }
  lastBoundsByInstance.delete(boundsKey(win.id, PreviewInstanceRegistry.resolveInstanceId(instanceId)));
}

function destroyHostForWindow(win: BrowserWindow): void {
  const removed = previewInstances.deleteWindow(win.id);
  for (const [, state] of removed) {
    for (const entry of state.tabs.values()) {
      destroyGuestEntry(win.isDestroyed() ? null : win, entry);
    }
  }
  for (const key of [...lastBoundsByInstance.keys()]) {
    if (key.startsWith(`${win.id}::`)) lastBoundsByInstance.delete(key);
  }
  wiredWindowIds.delete(win.id);
  devtoolsDockByWindow.delete(win.id);
}

async function loadSourceInGuest(
  wc: WebContents,
  payload: PreviewLoadSourcePayload,
): Promise<void> {
  const url = payload.url?.trim();
  if (!url) return;
  await wc.loadURL(url);
}

// ── Bounds ───────────────────────────────────────────────────────────────────

function roundBounds(bounds: PreviewBounds): { x: number; y: number; width: number; height: number } {
  const w = Math.max(0, Math.round(bounds.width));
  const h = Math.max(0, Math.round(bounds.height));
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: w,
    height: h,
  };
}

function isValidPreviewBounds(bounds: PreviewBounds | undefined): bounds is PreviewBounds {
  if (!bounds) return false;
  const { x, y, width, height } = bounds;
  return (
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    width > 0 &&
    height > 0
  );
}

function hostZoomFactor(win: BrowserWindow | null): number {
  if (!win || win.isDestroyed()) return 1;
  try {
    const z = win.webContents.getZoomFactor();
    return Number.isFinite(z) && z > 0 ? z : 1;
  } catch {
    return 1;
  }
}

function applyPreviewViewBounds(
  entry: PreviewHostEntry,
  bounds: PreviewBounds,
  zoomFactor: number,
  dock: DevToolsDockPosition = 'bottom',
): boolean {
  const rounded = roundBounds({
    x: bounds.x * zoomFactor,
    y: bounds.y * zoomFactor,
    width: bounds.width * zoomFactor,
    height: bounds.height * zoomFactor,
  });
  if (rounded.width <= 0 || rounded.height <= 0) {
    entry.visible = false;
    entry.view.setVisible(false);
    entry.devtools?.setVisible(false);
    return false;
  }
  const split = splitPreviewBounds(rounded, Boolean(entry.devtools), dock);
  entry.view.setBounds(split.guest);
  entry.visible = true;
  entry.view.setVisible(true);
  if (entry.devtools) {
    if (split.devtools) {
      entry.devtools.setBounds(split.devtools);
      entry.devtools.setVisible(true);
    } else {
      entry.devtools.setVisible(false);
      entry.devtools.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    }
  }
  return true;
}

function hidePreviewHostEntry(entry: PreviewHostEntry): void {
  entry.visible = false;
  entry.view.setVisible(false);
  entry.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  if (entry.devtools) {
    entry.devtools.setVisible(false);
    entry.devtools.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  }
}

function isChildView(win: BrowserWindow, view: WebContentsView): boolean {
  return win.contentView.children.includes(view);
}

/**
 * Attach only what is not attached yet. Re-adding a child view (or hiding it
 * first) drops keyboard focus from the guest, so a layout sync that re-attached
 * on every call stole focus from whatever the user was typing into.
 */
function attachPreviewHostEntry(win: BrowserWindow, entry: PreviewHostEntry): void {
  if (!isChildView(win, entry.view)) {
    try {
      win.contentView.addChildView(entry.view);
    } catch {
    }
  }
  if (entry.devtools && !isChildView(win, entry.devtools)) {
    try {
      win.contentView.addChildView(entry.devtools);
    } catch {
    }
  }
}

function detachAllTabViews(
  win: BrowserWindow,
  instanceId?: string,
  keep?: PreviewHostEntry,
): void {
  const state = previewInstances.get(win.id, instanceId);
  if (!state) return;
  for (const entry of state.tabs.values()) {
    if (entry === keep) continue;
    hidePreviewHostEntry(entry);
    try {
      win.contentView.removeChildView(entry.view);
    } catch {
    }
    if (entry.devtools) {
      try {
        win.contentView.removeChildView(entry.devtools);
      } catch {
      }
    }
  }
}

function detachAllInstanceViews(win: BrowserWindow): void {
  for (const instanceId of previewInstances.listInstanceIds(win.id)) {
    detachAllTabViews(win, instanceId);
  }
}

// ── Tabs ─────────────────────────────────────────────────────────────────────

function createTabGuest(win: BrowserWindow, tabId: string, instanceId: string): PreviewHostEntry {
  ensurePreviewSession();
  const view = new WebContentsView({
    webPreferences: {
      partition: PREVIEW_SESSION_PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
    },
  });
  view.setBackgroundColor('#ffffff');
  view.setVisible(false);
  attachPermissionHandler(view.webContents);
  const entry: PreviewHostEntry = { view, visible: false, devtools: null, devtoolsPopout: null };
  wirePreviewGuestEvents(win, tabId, entry, instanceId);
  return entry;
}

function getOrCreateTab(win: BrowserWindow, tabId: string, instanceId?: string): PreviewHostEntry {
  const state = windowState(win, instanceId);
  const existing = state.tabs.get(tabId);
  if (existing) return existing;
  const entry = createTabGuest(win, tabId, PreviewInstanceRegistry.resolveInstanceId(instanceId));
  state.tabs.set(tabId, entry);
  return entry;
}

function showActiveTab(win: BrowserWindow, bounds?: PreviewBounds, instanceId?: string): PreviewHostEntry | null {
  const id = PreviewInstanceRegistry.resolveInstanceId(instanceId);
  const state = windowState(win, id);
  const tabId = resolveTabId(win, state.activeTabId ?? undefined, id);
  if (!tabId) return null;
  const entry = getOrCreateTab(win, tabId, id);
  const instanceAlreadyVisible =
    previewInstances.isVisible(win.id, id) ||
    [...state.tabs.values()].some((tab) => tab.visible);
  // The active tab stays attached: show() runs on every renderer layout sync
  // (resize, capture-phase scroll, sidebar changes), not just on reveal.
  detachAllTabViews(win, id, entry);
  const key = boundsKey(win.id, id);
  const explicitBoundsValid = isValidPreviewBounds(bounds);
  const attachMode = resolvePreviewGuestAttachMode({
    explicitBoundsValid,
    instanceAlreadyVisible,
  });
  const layoutBounds = explicitBoundsValid ? bounds : lastBoundsByInstance.get(key);
  const hasLayout = isValidPreviewBounds(layoutBounds);
  const shouldPaint = attachMode === 'paint' && hasLayout;
  if (shouldPaint) {
    applyPreviewViewBounds(entry, layoutBounds!, hostZoomFactor(win), resolveDevToolsDock(win));
    rememberPreviewBounds(win, layoutBounds!, id);
  } else {
    entry.visible = false;
    entry.view.setVisible(false);
  }
  attachPreviewHostEntry(win, entry);
  state.activeTabId = tabId;
  previewInstances.setVisible(win.id, id, shouldPaint);
  return entry;
}

function getActiveEntry(event: IpcMainInvokeEvent, tabId?: string, instanceId?: string): PreviewHostEntry | null {
  const win = windowFromInvoke(event);
  if (!win) return null;
  if (typeof tabId === 'string' && tabId.trim()) {
    return getOrCreateTab(win, tabId.trim(), instanceId);
  }
  const resolved = resolveTabId(win, undefined, instanceId);
  if (!resolved) return null;
  return getOrCreateTab(win, resolved, instanceId);
}

function reopenOpenDevToolsForDockChange(win: BrowserWindow): void {
  const dock = resolveDevToolsDock(win);
  for (const instanceId of previewInstances.listInstanceIds(win.id)) {
    const state = previewInstances.get(win.id, instanceId);
    if (!state) continue;
    for (const [tabId, entry] of state.tabs) {
      migrateEntryDevToolsDock(win, tabId, entry, instanceId, dock);
    }
  }
}

// ── IPC ──────────────────────────────────────────────────────────────────────

export function registerPreviewHostIpc(): void {
  registerPreviewContextMenuIpc({
    windowFromEvent: windowFromInvoke,
    getEntry: getActiveEntry,
    openDevTools: openEntryDevTools,
    isCdpPickActive: (webContentsId) => cdpPickSessions.has(webContentsId),
  });

  ipcMain.handle(channels.PREVIEW_TAB_CREATE, (event, tabId?: string, instanceId?: string) => {
    const win = windowFromInvoke(event);
    if (!win) return null;
    const id = typeof tabId === 'string' && tabId.trim() ? tabId.trim() : randomUUID();
    getOrCreateTab(win, id, instanceId);
    const state = windowState(win, instanceId);
    if (!state.activeTabId) state.activeTabId = id;
    return id;
  });

  ipcMain.handle(channels.PREVIEW_TAB_CLOSE, (event, tabId: string, instanceId?: string) => {
    const win = windowFromInvoke(event);
    if (!win || typeof tabId !== 'string') return;
    destroyTabGuest(win, tabId, instanceId);
  });

  ipcMain.handle(channels.PREVIEW_TAB_ACTIVATE, (event, tabId: string, instanceId?: string) => {
    const win = windowFromInvoke(event);
    if (!win || typeof tabId !== 'string') return;
    const state = windowState(win, instanceId);
    if (!state.tabs.has(tabId)) getOrCreateTab(win, tabId, instanceId);
    state.activeTabId = tabId;
    showActiveTab(win, undefined, instanceId);
  });

  ipcMain.handle(channels.PREVIEW_TAB_LIST, (event, instanceId?: string) => {
    const win = windowFromInvoke(event);
    if (!win) return [];
    const state = windowState(win, instanceId);
    return [...state.tabs.entries()].map(([id, entry]) => {
      const info = previewGetGuestInfo(entry.view.webContents);
      return {
        id,
        url: info.url,
        title: info.title,
        loading: info.loading,
        active: id === state.activeTabId,
      };
    });
  });

  ipcMain.handle(
    channels.PREVIEW_INSTANCE_CREATE,
    (event, instanceId?: string) => {
      const win = windowFromInvoke(event);
      if (!win) return null;
      windowState(win, instanceId);
      return PreviewInstanceRegistry.resolveInstanceId(instanceId);
    },
  );

  ipcMain.handle(channels.PREVIEW_INSTANCE_DESTROY, (event, instanceId?: string) => {
    const win = windowFromInvoke(event);
    if (!win) return;
    destroyInstance(win, instanceId);
  });

  ipcMain.handle(channels.PREVIEW_INSTANCE_LIST, (event) => {
    const win = windowFromInvoke(event);
    if (!win) return [];
    return previewInstances.listInstanceIds(win.id);
  });

  ipcMain.handle(
    channels.PREVIEW_SHOW,
    (event, bounds?: PreviewBounds, tabId?: string, instanceId?: string) => {
      const win = windowFromInvoke(event);
      if (!win) return;
      const state = windowState(win, instanceId);
      if (tabId && typeof tabId === 'string') {
        state.activeTabId = tabId;
      }
      if (bounds && isValidPreviewBounds(bounds)) {
        rememberPreviewBounds(win, bounds, instanceId);
      }
      showActiveTab(win, bounds, instanceId);
    },
  );

  ipcMain.handle(channels.PREVIEW_HIDE, (event, tabId?: string, instanceId?: string) => {
    const win = windowFromInvoke(event);
    if (!win) return;
    if (tabId && typeof tabId === 'string') {
      const state = previewInstances.get(win.id, instanceId);
      const entry = state?.tabs.get(tabId);
      if (entry) hidePreviewHostEntry(entry);
      return;
    }
    detachAllTabViews(win, instanceId);
    previewInstances.setVisible(win.id, instanceId, false);
  });

  ipcMain.handle(channels.PREVIEW_CLEAR, async (event, tabId?: string, instanceId?: string) => {
    const entry = getActiveEntry(event, tabId, instanceId);
    if (!entry) return;
    try {
      await previewClearGuest(entry.view.webContents);
    } catch (err) {
      console.warn('[preview] clear failed:', err instanceof Error ? err.message : err);
    }
  });

  ipcMain.handle(
    channels.PREVIEW_LOAD_SOURCE,
    async (event, payload: PreviewLoadSourcePayload, tabId?: string, instanceId?: string) => {
      const win = windowFromInvoke(event);
      const entry = getActiveEntry(event, tabId, instanceId);
      if (!entry || !win || !payload || typeof payload !== 'object') return;
      const instance = PreviewInstanceRegistry.resolveInstanceId(instanceId);
      if (tabId && typeof tabId === 'string') {
        windowState(win, instanceId).activeTabId = tabId;
      }
      try {
        await loadSourceInGuest(entry.view.webContents, payload);
        showActiveTab(win, undefined, instanceId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const id = resolveTabId(win, tabId, instanceId) ?? 'unknown';
        sendToRenderer(win, channels.PREVIEW_LOAD_FAILED, id, {
          errorCode: -2,
          errorDescription: message,
          url: payload.kind === 'url' ? payload.url : payload.path,
        }, instance);
      }
    },
  );

  ipcMain.handle(
    channels.PREVIEW_LOAD_URL,
    async (event, url: string, tabId?: string, instanceId?: string) => {
      const win = windowFromInvoke(event);
      const entry = getActiveEntry(event, tabId, instanceId);
      if (!entry || typeof url !== 'string' || !url.trim()) return;
      const instance = PreviewInstanceRegistry.resolveInstanceId(instanceId);
      if (win && tabId && typeof tabId === 'string') {
        windowState(win, instanceId).activeTabId = tabId;
      }
      try {
        await entry.view.webContents.loadURL(url);
        if (win) {
          showActiveTab(win, undefined, instanceId);
        }
      } catch (err) {
        if (!win) return;
        const message = err instanceof Error ? err.message : String(err);
        const id = resolveTabId(win, tabId, instanceId) ?? 'unknown';
        sendToRenderer(win, channels.PREVIEW_LOAD_FAILED, id, {
          errorCode: -2,
          errorDescription: message,
          url,
        }, instance);
      }
    },
  );

  ipcMain.handle(channels.PREVIEW_RELOAD, (event, tabId?: string, instanceId?: string) => {
    const entry = getActiveEntry(event, tabId, instanceId);
    if (!entry) return;
    const wc = entry.view.webContents;
    if (wc.isLoading()) wc.stop();
    wc.reload();
  });

  ipcMain.handle(channels.PREVIEW_STOP, (event, tabId?: string, instanceId?: string) => {
    const entry = getActiveEntry(event, tabId, instanceId);
    if (!entry) return;
    entry.view.webContents.stop();
  });

  ipcMain.handle(channels.PREVIEW_GO_BACK, (event, tabId?: string, instanceId?: string) => {
    const entry = getActiveEntry(event, tabId, instanceId);
    const wc = entry?.view.webContents;
    if (!wc?.canGoBack()) return;
    wc.goBack();
  });

  ipcMain.handle(channels.PREVIEW_GO_FORWARD, (event, tabId?: string, instanceId?: string) => {
    const entry = getActiveEntry(event, tabId, instanceId);
    const wc = entry?.view.webContents;
    if (!wc?.canGoForward()) return;
    wc.goForward();
  });

  ipcMain.handle(
    channels.PREVIEW_SET_BOUNDS,
    (event, bounds: PreviewBounds, tabId?: string, instanceId?: string) => {
      const win = windowFromInvoke(event);
      const entry = getActiveEntry(event, tabId, instanceId);
      if (!entry || !bounds || !win) return;
      if (!isValidPreviewBounds(bounds)) {
        const { width, height } = bounds;
        if (Number.isFinite(width) && Number.isFinite(height) && (width <= 0 || height <= 0)) {
          entry.view.setVisible(false);
          entry.visible = false;
        }
        return;
      }
      rememberPreviewBounds(win, bounds, instanceId);
      if (!entry.visible) return;
      applyPreviewViewBounds(entry, bounds, hostZoomFactor(win), resolveDevToolsDock(win));
    },
  );

  ipcMain.handle(
    channels.PREVIEW_EXEC_JS,
    async (event, code: string, tabId?: string, instanceId?: string) => {
      const entry = getActiveEntry(event, tabId, instanceId);
      if (!entry || typeof code !== 'string') {
        throw new Error('Preview guest is not available');
      }
      return previewExecJs(entry.view.webContents, code);
    },
  );

  ipcMain.handle(
    channels.PREVIEW_CAPTURE_PAGE,
    async (event, tabId?: string, instanceId?: string) => {
      const win = windowFromInvoke(event);
      const entry = getActiveEntry(event, tabId, instanceId);
      if (!entry) {
        throw new Error('Preview guest is not available');
      }
      const wasVisible = entry.visible;
      let temporarilyShown = false;
      if (win && !wasVisible) {
        const id = PreviewInstanceRegistry.resolveInstanceId(instanceId);
        const bounds = lastBoundsByInstance.get(boundsKey(win.id, id));
        if (isValidPreviewBounds(bounds)) {
          applyPreviewViewBounds(entry, bounds, hostZoomFactor(win), resolveDevToolsDock(win));
          rememberPreviewBounds(win, bounds, id);
          attachPreviewHostEntry(win, entry);
          temporarilyShown = true;
        }
      }
      try {
        return await previewCapturePageBase64(entry.view.webContents);
      } finally {
        if (temporarilyShown && !shouldKeepPreviewGuestVisibleAfterCapture(wasVisible)) {
          hidePreviewHostEntry(entry);
          if (win && !win.isDestroyed()) {
            const id = PreviewInstanceRegistry.resolveInstanceId(instanceId);
            previewInstances.setVisible(win.id, id, false);
          }
        }
      }
    },
  );

  ipcMain.handle(channels.PREVIEW_GET_INFO, (event, tabId?: string, instanceId?: string) => {
    const entry = getActiveEntry(event, tabId, instanceId);
    if (!entry) {
      return { url: '', title: '', loading: false };
    }
    return previewGetGuestInfo(entry.view.webContents);
  });

  ipcMain.handle(
    channels.PREVIEW_NAVIGATE_AWAIT,
    async (event, url: string, tabId?: string, instanceId?: string) => {
      const win = windowFromInvoke(event);
      const entry = getActiveEntry(event, tabId, instanceId);
      if (!entry) {
        return {
          ok: false,
          url: typeof url === 'string' ? url : '',
          title: '',
          errorDescription: 'Preview guest is not available',
        };
      }
      if (win && tabId && typeof tabId === 'string') {
        windowState(win, instanceId).activeTabId = tabId;
        showActiveTab(win, undefined, instanceId);
      }
      if (typeof url !== 'string') {
        return previewNavigateAwait(entry.view.webContents, '');
      }
      return previewNavigateAwait(entry.view.webContents, url);
    },
  );

  ipcMain.handle(
    channels.PREVIEW_CDP_PICK_ENABLE,
    async (event, tabId?: string, instanceId?: string) => {
      const win = windowFromInvoke(event);
      const entry = getActiveEntry(event, tabId, instanceId);
      if (!entry || !win) {
        return { ok: false, error: 'Preview guest is not available' };
      }
      const wc = entry.view.webContents;
      if (cdpPickSessions.has(wc.id)) {
        return { ok: true };
      }
      try {
        const session = await enableCdpPicking(
          wc,
          (picked) => {
            if (win.isDestroyed()) return;
            win.webContents.send(channels.PREVIEW_CDP_PICK_EVENT, picked, tabId, instanceId);
          },
          (message) => {
            if (win.isDestroyed()) return;
            win.webContents.send(channels.PREVIEW_CDP_PICK_ERROR, message, tabId, instanceId);
          },
        );
        cdpPickSessions.set(wc.id, session);
        wc.once('destroyed', () => {
          cdpPickSessions.delete(wc.id);
        });
        return { ok: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, error: message };
      }
    },
  );

  ipcMain.handle(
    channels.PREVIEW_DEVTOOLS_TOGGLE,
    (event, tabId?: string, instanceId?: string) => {
      const win = windowFromInvoke(event);
      if (!win) return { open: false };
      const resolved = resolveTabId(win, tabId, instanceId);
      if (!resolved) return { open: false };
      const entry = getOrCreateTab(win, resolved, instanceId);
      if (isEntryDevToolsOpen(entry)) {
        closeEntryDevTools(win, resolved, entry, instanceId);
        return { open: false };
      }
      openEntryDevTools(win, resolved, entry, instanceId);
      return { open: isEntryDevToolsOpen(entry) };
    },
  );

  ipcMain.handle(
    channels.PREVIEW_DEVTOOLS_GET_STATE,
    (event, tabId?: string, instanceId?: string) => {
      const win = windowFromInvoke(event);
      if (!win) return false;
      const state = previewInstances.get(win.id, instanceId);
      if (!state) return false;
      const id = typeof tabId === 'string' && tabId.trim() ? tabId.trim() : state.activeTabId;
      const entry = id ? state.tabs.get(id) : undefined;
      return Boolean(entry && isEntryDevToolsOpen(entry));
    },
  );

  ipcMain.handle(channels.PREVIEW_DEVTOOLS_SET_DOCK, (event, dock: unknown) => {
    const win = windowFromInvoke(event);
    if (!win) return { dock: 'bottom' as DevToolsDockPosition };
    const prev = resolveDevToolsDock(win);
    const next = normalizeDevToolsDock(dock);
    devtoolsDockByWindow.set(win.id, next);
    if (prev !== next) {
      reopenOpenDevToolsForDockChange(win);
    } else {
      relayoutAllVisibleEntries(win);
    }
    return { dock: next };
  });

  ipcMain.handle(channels.PREVIEW_DEVTOOLS_GET_DOCK, (event) => {
    const win = windowFromInvoke(event);
    if (!win) return 'bottom' as DevToolsDockPosition;
    return resolveDevToolsDock(win);
  });

  ipcMain.handle(
    channels.PREVIEW_CDP_PICK_DISABLE,
    async (event, tabId?: string, instanceId?: string) => {
      const entry = getActiveEntry(event, tabId, instanceId);
      if (!entry) return;
      const wc = entry.view.webContents;
      const session = cdpPickSessions.get(wc.id);
      if (!session) return;
      cdpPickSessions.delete(wc.id);
      await session.disable();
    },
  );
}

export function destroyAllPreviewHosts(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    destroyHostForWindow(win);
  }
}

export { DEFAULT_PREVIEW_INSTANCE_ID };
