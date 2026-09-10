/**
 * Renderer typings for window.minnow exposed by electron/preload.ts.
 */

export interface MinnowPreviewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MinnowPreviewLoadFailedDetail {
  errorCode: number;
  errorDescription: string;
  url?: string;
}

export interface MinnowPreviewGuestCrashedDetail {
  reason: string;
  exitCode: number;
}

export interface MinnowPreviewLoadSourcePayload {
  kind: 'workspace' | 'url';
  path?: string;
  url?: string;
  cacheBust?: number;
}

export interface MinnowPreviewNavigateAwaitResult {
  ok: boolean;
  url: string;
  title: string;
  errorCode?: number;
  errorDescription?: string;
}

export interface MinnowPreviewGuestInfo {
  url: string;
  title: string;
  loading: boolean;
}

export interface MinnowPreviewTabInfo {
  id: string;
  url: string;
  title: string;
  loading: boolean;
  active: boolean;
}

export interface MinnowPreviewTabsApi {
  create(tabId?: string, instanceId?: string): Promise<string>;
  close(id: string, instanceId?: string): Promise<void>;
  activate(id: string, instanceId?: string): Promise<void>;
  list(instanceId?: string): Promise<MinnowPreviewTabInfo[]>;
}

/**
 * Named preview instance lifecycle (MIN-364). Instances are parallel WebContentsView-backed
 * surfaces (workspace right pane, Design surface, future Studio live-component frames), each
 * with its own tab set. See electron/preview-instance-registry.ts for the default instance id
 * ('workspace-preview') and reserved id conventions.
 */
export interface MinnowPreviewInstancesApi {
  create(instanceId?: string): Promise<string>;
  destroy(instanceId: string): Promise<void>;
  list(): Promise<string[]>;
}

/**
 * CDP-adapted pick — structurally identical to `PickedElement` in
 * `src/design/element-picker.ts` (kept as a separate type here since electron.d.ts can't import
 * from src/design without creating a renderer↔main type coupling across build boundaries).
 */
export interface MinnowCdpPickedElement {
  uid: number | null;
  cssSelector: string;
  tagName: string;
  classList: string[];
  outerHTMLPreview: string;
  boundingRect: { x: number; y: number; width: number; height: number };
  devicePixelRatio: number;
  stylesDigest: string;
  shiftKey: boolean;
  accessibleName: string;
  contrastRatio: number | null;
  domPath: string;
  attributes: Record<string, string>;
  computedStyles: Record<string, string>;
}

/** Docked Chromium DevTools for the preview guest (MIN-177). Electron only. */
export interface MinnowPreviewDevToolsApi {
  toggle(tabId?: string, instanceId?: string): Promise<{ open: boolean }>;
  isOpen(tabId?: string, instanceId?: string): Promise<boolean>;
  setDock(dock: 'bottom' | 'side' | 'popout'): Promise<{ dock: 'bottom' | 'side' | 'popout' }>;
  getDock(): Promise<'bottom' | 'side' | 'popout'>;
  onState(
    callback: (open: boolean, tabId?: string, instanceId?: string) => void,
  ): () => void;
}

/** Native (script-free) element picking over CDP for cross-origin preview guests (MIN-370). */
export interface MinnowCdpPickerApi {
  enable(tabId?: string, instanceId?: string): Promise<{ ok: boolean; error?: string }>;
  disable(tabId?: string, instanceId?: string): Promise<void>;
  onPick(
    callback: (picked: MinnowCdpPickedElement, tabId?: string, instanceId?: string) => void,
  ): () => void;
  onError(callback: (message: string, tabId?: string, instanceId?: string) => void): () => void;
}

export type MinnowPreviewContextMenuRole =
  | 'goBack'
  | 'goForward'
  | 'reload'
  | 'openLinkInNewTab'
  | 'copyLink'
  | 'openExternal'
  | 'copyImage'
  | 'copyImageAddress'
  | 'saveImage'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'selectAll'
  | 'replaceMisspelling'
  | 'addToDictionary'
  | 'inspect'
  | 'sendToChat';

export type MinnowPreviewContextMenuItem =
  | { type: 'separator' }
  | {
      type: 'item';
      role: MinnowPreviewContextMenuRole;
      label: string;
      enabled: boolean;
      suggestion?: string;
    };

export interface MinnowPreviewContextMenuParams {
  linkURL?: string;
  srcURL?: string;
  mediaType?: string;
  isEditable?: boolean;
  selectionText?: string;
  misspelledWord?: string;
  dictionarySuggestions?: string[];
  editFlags?: {
    canCut?: boolean;
    canCopy?: boolean;
    canPaste?: boolean;
    canSelectAll?: boolean;
  };
}

export interface MinnowPreviewContextMenuOpenPayload {
  tabId: string;
  instanceId: string;
  x: number;
  y: number;
  params: MinnowPreviewContextMenuParams;
  items: MinnowPreviewContextMenuItem[];
  canGoBack: boolean;
  canGoForward: boolean;
  pageUrl: string;
}

/** Right-click context menu for the Electron preview guest. */
export interface MinnowPreviewContextMenuApi {
  /** Legacy DOM menu path — main process uses native Menu.popup instead. */
  onOpen(callback: (payload: MinnowPreviewContextMenuOpenPayload) => void): () => void;
  /** Renderer-owned actions after the user picks Send to chat / Open in new tab. */
  onSelect(
    callback: (
      payload: MinnowPreviewContextMenuOpenPayload & {
        role: MinnowPreviewContextMenuRole;
        suggestion?: string;
      },
    ) => void,
  ): () => void;
  inspect(
    tabId: string,
    x: number,
    y: number,
    instanceId?: string,
  ): Promise<{ ok: boolean; error?: string }>;
  resolveElement(
    tabId: string,
    x: number,
    y: number,
    instanceId?: string,
  ): Promise<{
    ok: boolean;
    picked?: MinnowCdpPickedElement;
    pageUrl?: string;
    error?: string;
  }>;
  action(
    tabId: string,
    role: MinnowPreviewContextMenuRole,
    payload?: {
      x?: number;
      y?: number;
      linkURL?: string;
      srcURL?: string;
      suggestion?: string;
      misspelledWord?: string;
    },
    instanceId?: string,
  ): Promise<{ ok: boolean; error?: string }>;
}

export interface MinnowPreviewApi {
  show(bounds?: MinnowPreviewBounds, tabId?: string, instanceId?: string): Promise<void>;
  hide(tabId?: string, instanceId?: string): Promise<void>;
  clear(tabId?: string, instanceId?: string): Promise<void>;
  loadURL(url: string, tabId?: string, instanceId?: string): Promise<void>;
  loadSource(
    payload: MinnowPreviewLoadSourcePayload,
    tabId?: string,
    instanceId?: string,
  ): Promise<void>;
  reload(tabId?: string, instanceId?: string): Promise<void>;
  stop(tabId?: string, instanceId?: string): Promise<void>;
  goBack(tabId?: string, instanceId?: string): Promise<void>;
  goForward(tabId?: string, instanceId?: string): Promise<void>;
  setBounds(bounds: MinnowPreviewBounds, tabId?: string, instanceId?: string): Promise<void>;
  execJs(code: string, tabId?: string, instanceId?: string): Promise<unknown>;
  capturePage(tabId?: string, instanceId?: string): Promise<string>;
  getInfo(tabId?: string, instanceId?: string): Promise<MinnowPreviewGuestInfo>;
  navigateAndWait(
    url: string,
    tabId?: string,
    instanceId?: string,
  ): Promise<MinnowPreviewNavigateAwaitResult>;
  tabs: MinnowPreviewTabsApi;
  instances: MinnowPreviewInstancesApi;
  /** Optional: packaged shells older than MIN-177 lack the devtools bridge. */
  devtools?: MinnowPreviewDevToolsApi;
  cdpPicker: MinnowCdpPickerApi;
  /** Optional: packaged shells older than the context-menu bridge lack this. */
  contextMenu?: MinnowPreviewContextMenuApi;
  onNavigation(callback: (url: string, tabId?: string, instanceId?: string) => void): () => void;
  onLoading(callback: (loading: boolean, tabId?: string, instanceId?: string) => void): () => void;
  onPageTitle(callback: (title: string, tabId?: string, instanceId?: string) => void): () => void;
  onLoadFailed(
    callback: (detail: MinnowPreviewLoadFailedDetail, tabId?: string, instanceId?: string) => void,
  ): () => void;
  onGuestCrashed?(
    callback: (
      detail: MinnowPreviewGuestCrashedDetail,
      tabId?: string,
      instanceId?: string,
    ) => void,
  ): () => void;
}

export interface MinnowAppApi {
  platform: NodeJS.Platform;
  isElectron: true;
  openExternal(url: string): Promise<void>;
  /** Optional: absent on a preload from an older build until the shell restarts. */
  getHardwareAcceleration?(): Promise<boolean>;
  /** Persisted immediately; takes effect on the next launch. */
  setHardwareAcceleration?(enabled: boolean): Promise<boolean>;
  /** Clean teardown, then relaunch the shell. */
  restart?(): Promise<void>;
}

/** OS file manager integration (Explorer / Finder). */
export interface MinnowShellApi {
  revealInExplorer(
    absolutePath: string,
    kind: 'file' | 'dir',
  ): Promise<{ ok: true } | { ok: false; error: string }>;
}

export interface MinnowWindowApi {
  reportCodeIssueLink?: (requestId: string, chatId: string) => Promise<void>;
  onCodeIssueLink?: (callback: (issueId: string, chatId: string) => void) => () => void;
  sendCodeCommand?: (command: import('../electron/code-window-command').CodeWindowCommand) => Promise<{ ok: boolean; error?: string }>;
  onCodeCommand?: (callback: (command: import('../electron/code-window-command').CodeWindowCommand) => void) => () => void;
  minimize(): Promise<void>;
  maximize(): Promise<void>;
  close(): Promise<void>;
  isMaximized(): Promise<boolean>;
  /** Restore shell and renderer focus after a blocking native dialog. */
  restoreFocus?(): Promise<void>;
  onMaximizedChanged(callback: (maximized: boolean) => void): () => void;
  /** Optional: absent on a preload from an older build until the shell restarts. */
  onVisibilityChanged?(callback: (visible: boolean) => void): () => void;
  /** Open a fresh window at the folder gate. */
  newWindow?: () => Promise<{ ok: true } | { ok: false; error: string }>;
  /** Open a folder in a window, or focus the window already on it. */
  openWorkspace?: (
    workspacePath: string,
  ) => Promise<{ ok: true; focused: boolean } | { ok: false; error: string }>;
  /** Folders currently open in some window. */
  listWorkspaces?: () => Promise<string[]>;
  /** The same list with window ids and whether each window is on screen. */
  listWorkspaceWindows?: () => Promise<MinnowWorkspaceWindow[]>;
  /** Close the window on a folder for real — never hide it to the tray. */
  closeWorkspace?: (
    workspacePath: string,
  ) => Promise<{ ok: true; closed: boolean } | { ok: false; error: string }>;
  /** Fires whenever a workspace window opens, closes, or is backgrounded. */
  onWorkspacesChanged?: (
    callback: (windows: MinnowWorkspaceWindow[]) => void,
  ) => () => void;
  /** Point this window at a different folder. */
  switchWorkspace?: (
    workspacePath: string,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** Open or focus a dedicated window for one released app (not Code). */
  openAppWindow?: (
    appId: string,
  ) => Promise<{ ok: true; focused: boolean } | { ok: false; error: string }>;
  /** Whether that app already has a dedicated window. */
  hasAppWindow?: (appId: string) => Promise<{ open: boolean }>;
  /** Open or focus the standalone Agent Browser viewer. */
  openAgentBrowserViewer?: () => Promise<
    { ok: true; focused: boolean } | { ok: false; error: string }
  >;
}

/** One open shell window, as the workspace pickers see it. */
export interface MinnowWorkspaceWindow {
  windowId: number;
  /** Absolute folder, or `''` for a window still at the folder gate. */
  workspacePath: string;
  /** False while the window is hidden in the system tray. */
  visible: boolean;
}

export interface MinnowLastCrashMarker {
  kind: string;
  reason?: string;
  exitCode?: number;
  message?: string;
  ts: string;
}

export interface MinnowDiagnosticsApi {
  reportError(payload: { kind: string; message: string; stack?: string }): void;
  getLastCrash(): Promise<MinnowLastCrashMarker | null>;
  getOomPause(): Promise<MinnowLastCrashMarker | null>;
  clearOomPause(): Promise<void>;
}

export type MinnowUpdaterChannel = 'stable' | 'beta';

export type MinnowUpdaterState =
  | 'unsupported'
  | 'idle'
  | 'checking'
  | 'downloading'
  | 'ready'
  | 'error';

/**
 * Renderer copy of electron/updater-core.ts UpdaterStatus (same cross-boundary type
 * convention as MinnowCdpPickedElement above).
 */
export interface MinnowUpdaterStatus {
  state: MinnowUpdaterState;
  supported: boolean;
  unsupportedReason: 'dev' | 'macos-signing' | null;
  installedVersion: string;
  channel: MinnowUpdaterChannel;
  pendingVersion: string | null;
  releaseNotes: string | null;
  progressPercent: number | null;
  lastCheckedAt: number | null;
  nextCheckAt: number | null;
  errorMessage: string | null;
}

/** Auto-update controls (MIN-384). Only present on shells built with the updater bridge. */
export interface MinnowUpdaterApi {
  getStatus(): Promise<MinnowUpdaterStatus | null>;
  checkNow(): Promise<MinnowUpdaterStatus | null>;
  restart(): Promise<boolean>;
  setChannel(channel: MinnowUpdaterChannel): Promise<MinnowUpdaterStatus | null>;
  onStatusChanged(callback: (status: MinnowUpdaterStatus) => void): () => void;
}

export interface MinnowTrayStatusSnapshot {
  agentCount: number;
  localModelCount: number;
  localModelNames: string[];
}

export type MinnowTrayCommand =
  | { type: 'new_chat' }
  | { type: 'open_settings' }
  | { type: 'unload_local_models' };

/** Preference for closing one of several open windows. */
export type MinnowWindowCloseAction = 'ask' | 'close' | 'background';

/** Copy for the in-app close-workspace dialog (mirrors electron/window-close-prompt.ts). */
export interface MinnowWindowClosePrompt {
  requestId: string;
  title: string;
  heading: string;
  folder: string;
  detail: string;
  checkboxLabel: string;
}

export interface MinnowWindowClosePromptReply {
  action: 'close' | 'background' | 'cancel';
  remember: boolean;
}

export interface MinnowLoginItemSnapshot {
  openAtLogin: boolean;
  supported: boolean;
}

/** System tray integration (close-to-tray, status, native commands). */
export interface MinnowTrayApi {
  publishStatus(snapshot: MinnowTrayStatusSnapshot): void;
  notifyReady(): void;
  getCloseToTray(): Promise<boolean>;
  setCloseToTray(enabled: boolean): Promise<boolean>;
  /** What closing one of several windows does. Absent on an older preload. */
  getWindowCloseAction?(): Promise<MinnowWindowCloseAction>;
  setWindowCloseAction?(
    action: MinnowWindowCloseAction,
  ): Promise<MinnowWindowCloseAction>;
  getLoginItem(): Promise<MinnowLoginItemSnapshot>;
  setLoginItem(enabled: boolean): Promise<MinnowLoginItemSnapshot>;
  onCommand(callback: (command: MinnowTrayCommand) => void): () => void;
  onCloseToTrayChanged(callback: (enabled: boolean) => void): () => void;
  /** In-app close-workspace dialog. Absent on an older preload. */
  onWindowClosePrompt?(
    callback: (payload: MinnowWindowClosePrompt) => void,
  ): () => void;
  replyWindowClosePrompt?(
    requestId: string,
    result: MinnowWindowClosePromptReply,
  ): void;
  getZoomPercent(): Promise<number>;
  setZoomPercent(percent: number): Promise<number>;
  onZoomPercentChanged(callback: (percent: number) => void): () => void;
}

/** macOS display sleep / system resume hooks for AFK board reliability. */
export interface MinnowPowerApi {
  setAfkBoardGuard(active: boolean): void;
  onScreenUnlocked(callback: () => void): () => void;
}

/** Orchestrate board lifecycle hooks from the main process. */
export interface MinnowBoardApi {
  onPauseForShutdown(callback: () => void): () => void;
}

/** Which workspace (and view) this renderer is bound to. */
export interface MinnowViewContext {
  /** Absolute workspace folder, or `''` when the window booted with no folder. */
  workspacePath: string;
  /** Stable id for this view, for main-process window/tab lookup. */
  viewId: string;
  /** True when the SPA runs inside a tab view under host chrome. */
  hosted: boolean;
  /** Bound app when this renderer is an app-only window. */
  appId?: string;
  /** True when this is the lightweight standalone Agent Browser viewer. */
  agentBrowserViewer?: boolean;
}

export interface MinnowElectronBridge {
  /** Optional: shells built before multi-workspace do not set it. */
  viewContext?: MinnowViewContext;
  preview: MinnowPreviewApi;
  /** Optional: shells built before MIN-543 lack host reveal. */
  shell?: MinnowShellApi;
  app: MinnowAppApi;
  window?: MinnowWindowApi;
  diagnostics?: MinnowDiagnosticsApi;
  updater?: MinnowUpdaterApi;
  tray?: MinnowTrayApi;
  power?: MinnowPowerApi;
  board?: MinnowBoardApi;
}

declare global {
  interface Window {
    minnow?: MinnowElectronBridge;
  }

  /** Electron frameless shell uses -webkit-app-region for draggable title bars. */
  interface CSSStyleDeclaration {
    webkitAppRegion: 'drag' | 'no-drag' | string;
  }
}

export {};
