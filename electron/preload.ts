import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import * as channels from './ipc-channels.js';
import type { CodeWindowCommand } from './code-window-command.js';
import type { CdpPickedElement } from './preview-cdp-adapt.js';
import type { PreviewContextMenuOpenPayload } from './preview-context-menu.js';
import type { PreviewContextMenuRole } from './preview-context-menu-items.js';
import type { UpdaterChannel, UpdaterStatus } from './updater-core.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface PreviewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PreviewLoadFailedDetail {
  errorCode: number;
  errorDescription: string;
  url?: string;
}

export interface PreviewGuestCrashedDetail {
  reason: string;
  exitCode: number;
}

export interface PreviewLoadSourcePayload {
  kind: 'workspace' | 'url';
  path?: string;
  url?: string;
  cacheBust?: number;
}

export interface PreviewNavigateAwaitResult {
  ok: boolean;
  url: string;
  title: string;
  errorCode?: number;
  errorDescription?: string;
}

export interface PreviewGuestInfo {
  url: string;
  title: string;
  loading: boolean;
}

export interface PreviewTabInfo {
  id: string;
  url: string;
  title: string;
  loading: boolean;
  active: boolean;
}

// ── View context ─────────────────────────────────────────────────────────────

/**
 * Which workspace this renderer is bound to. Passed as
 * `webPreferences.additionalArguments` by `createShellWindow`, so it is
 * available synchronously at preload time — no IPC round-trip, and it works in
 * dev and packaged alike.
 */
export interface MinnowViewContext {
  /** Absolute workspace folder, or `''` when the window booted with no folder. */
  workspacePath: string;
  /** Stable id for this view, for main-process window/tab lookup. */
  viewId: string;
  /** True when the SPA runs inside a tab view under host chrome (Phase 4). */
  hosted: boolean;
  /** Bound app when this renderer is an app-only window (`--minnow-app-window`). */
  appId?: string;
  /** True for the lightweight standalone Agent Browser viewer renderer. */
  agentBrowserViewer?: boolean;
}

function readArgvFlag(name: string): string {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : '';
}

const viewContext: MinnowViewContext = {
  workspacePath: readArgvFlag('minnow-workspace'),
  viewId: readArgvFlag('minnow-view-id'),
  hosted: process.argv.includes('--minnow-hosted'),
  appId: readArgvFlag('minnow-app-window') || undefined,
  agentBrowserViewer: process.argv.includes('--minnow-agent-browser-viewer') || undefined,
};

/** Preference for closing one of several open windows. */
export type WindowCloseActionPref = 'ask' | 'close' | 'background';

/** One open shell window, as the workspace pickers and tray see it. */
export interface WorkspaceWindowInfo {
  windowId: number;
  /** Absolute folder, or `''` for a window still at the folder gate. */
  workspacePath: string;
  /** False while the window is hidden in the system tray. */
  visible: boolean;
}

// ── Preview API ──────────────────────────────────────────────────────────────

const preview = {
  show: (bounds?: PreviewBounds, tabId?: string, instanceId?: string): Promise<void> =>
    ipcRenderer.invoke(channels.PREVIEW_SHOW, bounds, tabId, instanceId),
  hide: (tabId?: string, instanceId?: string): Promise<void> =>
    ipcRenderer.invoke(channels.PREVIEW_HIDE, tabId, instanceId),
  clear: (tabId?: string, instanceId?: string): Promise<void> =>
    ipcRenderer.invoke(channels.PREVIEW_CLEAR, tabId, instanceId),
  loadURL: (url: string, tabId?: string, instanceId?: string): Promise<void> =>
    ipcRenderer.invoke(channels.PREVIEW_LOAD_URL, url, tabId, instanceId),
  loadSource: (
    payload: PreviewLoadSourcePayload,
    tabId?: string,
    instanceId?: string,
  ): Promise<void> => ipcRenderer.invoke(channels.PREVIEW_LOAD_SOURCE, payload, tabId, instanceId),
  reload: (tabId?: string, instanceId?: string): Promise<void> =>
    ipcRenderer.invoke(channels.PREVIEW_RELOAD, tabId, instanceId),
  stop: (tabId?: string, instanceId?: string): Promise<void> =>
    ipcRenderer.invoke(channels.PREVIEW_STOP, tabId, instanceId),
  goBack: (tabId?: string, instanceId?: string): Promise<void> =>
    ipcRenderer.invoke(channels.PREVIEW_GO_BACK, tabId, instanceId),
  goForward: (tabId?: string, instanceId?: string): Promise<void> =>
    ipcRenderer.invoke(channels.PREVIEW_GO_FORWARD, tabId, instanceId),
  setBounds: (bounds: PreviewBounds, tabId?: string, instanceId?: string): Promise<void> =>
    ipcRenderer.invoke(channels.PREVIEW_SET_BOUNDS, bounds, tabId, instanceId),
  execJs: (code: string, tabId?: string, instanceId?: string): Promise<unknown> =>
    ipcRenderer.invoke(channels.PREVIEW_EXEC_JS, code, tabId, instanceId),
  capturePage: (tabId?: string, instanceId?: string): Promise<string> =>
    ipcRenderer.invoke(channels.PREVIEW_CAPTURE_PAGE, tabId, instanceId),
  getInfo: (tabId?: string, instanceId?: string): Promise<PreviewGuestInfo> =>
    ipcRenderer.invoke(channels.PREVIEW_GET_INFO, tabId, instanceId),
  navigateAndWait: (
    url: string,
    tabId?: string,
    instanceId?: string,
  ): Promise<PreviewNavigateAwaitResult> =>
    ipcRenderer.invoke(channels.PREVIEW_NAVIGATE_AWAIT, url, tabId, instanceId),
  tabs: {
    create: (tabId?: string, instanceId?: string): Promise<string> =>
      ipcRenderer.invoke(channels.PREVIEW_TAB_CREATE, tabId, instanceId),
    close: (id: string, instanceId?: string): Promise<void> =>
      ipcRenderer.invoke(channels.PREVIEW_TAB_CLOSE, id, instanceId),
    activate: (id: string, instanceId?: string): Promise<void> =>
      ipcRenderer.invoke(channels.PREVIEW_TAB_ACTIVATE, id, instanceId),
    list: (instanceId?: string): Promise<PreviewTabInfo[]> =>
      ipcRenderer.invoke(channels.PREVIEW_TAB_LIST, instanceId),
  },
  instances: {
    create: (instanceId?: string): Promise<string> =>
      ipcRenderer.invoke(channels.PREVIEW_INSTANCE_CREATE, instanceId),
    destroy: (instanceId: string): Promise<void> =>
      ipcRenderer.invoke(channels.PREVIEW_INSTANCE_DESTROY, instanceId),
    list: (): Promise<string[]> => ipcRenderer.invoke(channels.PREVIEW_INSTANCE_LIST),
  },
  devtools: {
    toggle: (tabId?: string, instanceId?: string): Promise<{ open: boolean }> =>
      ipcRenderer.invoke(channels.PREVIEW_DEVTOOLS_TOGGLE, tabId, instanceId),
    isOpen: (tabId?: string, instanceId?: string): Promise<boolean> =>
      ipcRenderer.invoke(channels.PREVIEW_DEVTOOLS_GET_STATE, tabId, instanceId),
    setDock: (dock: 'bottom' | 'side' | 'popout'): Promise<{ dock: 'bottom' | 'side' | 'popout' }> =>
      ipcRenderer.invoke(channels.PREVIEW_DEVTOOLS_SET_DOCK, dock),
    getDock: (): Promise<'bottom' | 'side' | 'popout'> =>
      ipcRenderer.invoke(channels.PREVIEW_DEVTOOLS_GET_DOCK),
    onState: (
      callback: (open: boolean, tabId?: string, instanceId?: string) => void,
    ): (() => void) => {
      const handler = (
        _event: IpcRendererEvent,
        tabId: string,
        open: boolean,
        instanceId?: string,
      ) => callback(open, tabId, instanceId);
      ipcRenderer.on(channels.PREVIEW_DEVTOOLS_STATE, handler);
      return () => {
        ipcRenderer.removeListener(channels.PREVIEW_DEVTOOLS_STATE, handler);
      };
    },
  },
  cdpPicker: {
    enable: (tabId?: string, instanceId?: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(channels.PREVIEW_CDP_PICK_ENABLE, tabId, instanceId),
    disable: (tabId?: string, instanceId?: string): Promise<void> =>
      ipcRenderer.invoke(channels.PREVIEW_CDP_PICK_DISABLE, tabId, instanceId),
    onPick: (
      callback: (picked: CdpPickedElement, tabId?: string, instanceId?: string) => void,
    ): (() => void) => {
      const handler = (
        _event: IpcRendererEvent,
        picked: CdpPickedElement,
        tabId?: string,
        instanceId?: string,
      ) => callback(picked, tabId, instanceId);
      ipcRenderer.on(channels.PREVIEW_CDP_PICK_EVENT, handler);
      return () => {
        ipcRenderer.removeListener(channels.PREVIEW_CDP_PICK_EVENT, handler);
      };
    },
    onError: (
      callback: (message: string, tabId?: string, instanceId?: string) => void,
    ): (() => void) => {
      const handler = (
        _event: IpcRendererEvent,
        message: string,
        tabId?: string,
        instanceId?: string,
      ) => callback(message, tabId, instanceId);
      ipcRenderer.on(channels.PREVIEW_CDP_PICK_ERROR, handler);
      return () => {
        ipcRenderer.removeListener(channels.PREVIEW_CDP_PICK_ERROR, handler);
      };
    },
  },
  contextMenu: {
    onOpen: (callback: (payload: PreviewContextMenuOpenPayload) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, payload: PreviewContextMenuOpenPayload) => {
        callback(payload);
      };
      ipcRenderer.on(channels.PREVIEW_CONTEXT_MENU_OPEN, handler);
      return () => {
        ipcRenderer.removeListener(channels.PREVIEW_CONTEXT_MENU_OPEN, handler);
      };
    },
    onSelect: (
      callback: (
        payload: PreviewContextMenuOpenPayload & {
          role: PreviewContextMenuRole;
          suggestion?: string;
        },
      ) => void,
    ): (() => void) => {
      const handler = (
        _event: IpcRendererEvent,
        payload: PreviewContextMenuOpenPayload & {
          role: PreviewContextMenuRole;
          suggestion?: string;
        },
      ) => {
        callback(payload);
      };
      ipcRenderer.on(channels.PREVIEW_CONTEXT_MENU_SELECT, handler);
      return () => {
        ipcRenderer.removeListener(channels.PREVIEW_CONTEXT_MENU_SELECT, handler);
      };
    },
    inspect: (
      tabId: string,
      x: number,
      y: number,
      instanceId?: string,
    ): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(channels.PREVIEW_CONTEXT_INSPECT, tabId, instanceId, x, y),
    resolveElement: (
      tabId: string,
      x: number,
      y: number,
      instanceId?: string,
    ): Promise<{
      ok: boolean;
      picked?: CdpPickedElement;
      pageUrl?: string;
      error?: string;
    }> => ipcRenderer.invoke(channels.PREVIEW_CONTEXT_RESOLVE_ELEMENT, tabId, instanceId, x, y),
    action: (
      tabId: string,
      role: PreviewContextMenuRole,
      payload?: {
        x?: number;
        y?: number;
        linkURL?: string;
        srcURL?: string;
        suggestion?: string;
        misspelledWord?: string;
      },
      instanceId?: string,
    ): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(channels.PREVIEW_CONTEXT_ACTION, tabId, instanceId, role, payload ?? {}),
  },
  onNavigation: (callback: (url: string, tabId?: string, instanceId?: string) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, tabId: string, url: string, instanceId?: string) => {
      callback(url, tabId, instanceId);
    };
    ipcRenderer.on(channels.PREVIEW_NAVIGATION, handler);
    return () => {
      ipcRenderer.removeListener(channels.PREVIEW_NAVIGATION, handler);
    };
  },
  onLoading: (
    callback: (loading: boolean, tabId?: string, instanceId?: string) => void,
  ): (() => void) => {
    const handler = (
      _event: IpcRendererEvent,
      tabId: string,
      loading: boolean,
      instanceId?: string,
    ) => {
      callback(loading, tabId, instanceId);
    };
    ipcRenderer.on(channels.PREVIEW_LOADING, handler);
    return () => {
      ipcRenderer.removeListener(channels.PREVIEW_LOADING, handler);
    };
  },
  onPageTitle: (
    callback: (title: string, tabId?: string, instanceId?: string) => void,
  ): (() => void) => {
    const handler = (
      _event: IpcRendererEvent,
      tabId: string,
      title: string,
      instanceId?: string,
    ) => {
      callback(title, tabId, instanceId);
    };
    ipcRenderer.on(channels.PREVIEW_PAGE_TITLE, handler);
    return () => {
      ipcRenderer.removeListener(channels.PREVIEW_PAGE_TITLE, handler);
    };
  },
  onLoadFailed: (
    callback: (detail: PreviewLoadFailedDetail, tabId?: string, instanceId?: string) => void,
  ): (() => void) => {
    const handler = (
      _event: IpcRendererEvent,
      tabId: string,
      detail: PreviewLoadFailedDetail,
      instanceId?: string,
    ) => {
      callback(detail, tabId, instanceId);
    };
    ipcRenderer.on(channels.PREVIEW_LOAD_FAILED, handler);
    return () => {
      ipcRenderer.removeListener(channels.PREVIEW_LOAD_FAILED, handler);
    };
  },
  onGuestCrashed: (
    callback: (detail: PreviewGuestCrashedDetail, tabId?: string, instanceId?: string) => void,
  ): (() => void) => {
    const handler = (
      _event: IpcRendererEvent,
      tabId: string,
      detail: PreviewGuestCrashedDetail,
      instanceId?: string,
    ) => {
      callback(detail, tabId, instanceId);
    };
    ipcRenderer.on(channels.PREVIEW_GUEST_CRASHED, handler);
    return () => {
      ipcRenderer.removeListener(channels.PREVIEW_GUEST_CRASHED, handler);
    };
  },
};

// ── Bridge ───────────────────────────────────────────────────────────────────

const minnowBridge = {
  viewContext,
  preview,
  shell: {
    revealInExplorer: (
      absolutePath: string,
      kind: 'file' | 'dir',
    ): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke(channels.SHELL_REVEAL_IN_EXPLORER, absolutePath, kind),
  },
  app: {
    platform: process.platform,
    isElectron: true as const,
    openExternal: (url: string): Promise<void> =>
      ipcRenderer.invoke(channels.APP_OPEN_EXTERNAL, url),
    getHardwareAcceleration: (): Promise<boolean> =>
      ipcRenderer.invoke(channels.APP_GET_HARDWARE_ACCELERATION),
    setHardwareAcceleration: (enabled: boolean): Promise<boolean> =>
      ipcRenderer.invoke(channels.APP_SET_HARDWARE_ACCELERATION, enabled),
    restart: (): Promise<void> => ipcRenderer.invoke(channels.APP_RESTART),
  },
  window: {
    reportCodeIssueLink: (requestId: string, chatId: string): Promise<void> =>
      ipcRenderer.invoke(channels.WINDOW_CODE_LINK, requestId, chatId),
    onCodeIssueLink: (callback: (issueId: string, chatId: string) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, issueId: string, chatId: string) => callback(issueId, chatId);
      ipcRenderer.on(channels.WINDOW_CODE_LINK, handler);
      return () => ipcRenderer.removeListener(channels.WINDOW_CODE_LINK, handler);
    },
    sendCodeCommand: (command: CodeWindowCommand): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(channels.WINDOW_CODE_COMMAND, command),
    onCodeCommand: (callback: (command: CodeWindowCommand) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, command: CodeWindowCommand) => callback(command);
      ipcRenderer.on(channels.WINDOW_CODE_COMMAND, handler);
      void ipcRenderer.invoke(channels.WINDOW_CODE_READY);
      return () => ipcRenderer.removeListener(channels.WINDOW_CODE_COMMAND, handler);
    },
    minimize: (): Promise<void> => ipcRenderer.invoke(channels.WINDOW_MINIMIZE),
    maximize: (): Promise<void> => ipcRenderer.invoke(channels.WINDOW_MAXIMIZE),
    close: (): Promise<void> => ipcRenderer.invoke(channels.WINDOW_CLOSE),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke(channels.WINDOW_IS_MAXIMIZED),
    restoreFocus: (): Promise<void> => ipcRenderer.invoke(channels.WINDOW_RESTORE_FOCUS),
    /** Open a fresh window at the folder gate. */
    newWindow: (): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke(channels.WINDOW_NEW),
    /** Open a folder in a window, or focus the window already on it. */
    openWorkspace: (
      workspacePath: string,
    ): Promise<{ ok: true; focused: boolean } | { ok: false; error: string }> =>
      ipcRenderer.invoke(channels.WINDOW_OPEN_WORKSPACE, workspacePath),
    /** Folders currently open in some window. */
    listWorkspaces: (): Promise<string[]> =>
      ipcRenderer.invoke(channels.WINDOW_LIST_WORKSPACES),
    /** The same list with window ids and whether each window is on screen. */
    listWorkspaceWindows: (): Promise<WorkspaceWindowInfo[]> =>
      ipcRenderer.invoke(channels.WINDOW_LIST_WORKSPACE_WINDOWS),
    /** Close the window on a folder for real — never hide it to the tray. */
    closeWorkspace: (
      workspacePath: string,
    ): Promise<{ ok: true; closed: boolean } | { ok: false; error: string }> =>
      ipcRenderer.invoke(channels.WINDOW_CLOSE_WORKSPACE, workspacePath),
    onWorkspacesChanged: (
      callback: (windows: WorkspaceWindowInfo[]) => void,
    ): (() => void) => {
      const handler = (_event: IpcRendererEvent, windows: WorkspaceWindowInfo[]) =>
        callback(windows);
      ipcRenderer.on(channels.WINDOW_WORKSPACES_CHANGED, handler);
      return () => {
        ipcRenderer.removeListener(channels.WINDOW_WORKSPACES_CHANGED, handler);
      };
    },
    /** Point this window at a different folder (main replaces the view). */
    switchWorkspace: (
      workspacePath: string,
    ): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke(channels.WINDOW_SWITCH_WORKSPACE, workspacePath),
    /** Open or focus a dedicated window for one released app (not Code). */
    openAppWindow: (
      appId: string,
    ): Promise<{ ok: true; focused: boolean } | { ok: false; error: string }> =>
      ipcRenderer.invoke(channels.WINDOW_OPEN_APP, appId),
    /** Whether that app already has a dedicated window. */
    hasAppWindow: (appId: string): Promise<{ open: boolean }> =>
      ipcRenderer.invoke(channels.WINDOW_HAS_APP, appId),
    /** Open or focus the read-only/operator window for headless agent tabs. */
    openAgentBrowserViewer: (): Promise<{ ok: true; focused: boolean } | { ok: false; error: string }> =>
      ipcRenderer.invoke(channels.WINDOW_OPEN_AGENT_BROWSER_VIEWER),
    onMaximizedChanged: (callback: (maximized: boolean) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, maximized: boolean) => callback(maximized);
      ipcRenderer.on(channels.WINDOW_MAXIMIZED_CHANGED, handler);
      return () => {
        ipcRenderer.removeListener(channels.WINDOW_MAXIMIZED_CHANGED, handler);
      };
    },
    onVisibilityChanged: (callback: (visible: boolean) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, visible: boolean) => callback(visible);
      ipcRenderer.on(channels.WINDOW_VISIBILITY_CHANGED, handler);
      return () => {
        ipcRenderer.removeListener(channels.WINDOW_VISIBILITY_CHANGED, handler);
      };
    },
  },
  updater: {
    getStatus: (): Promise<UpdaterStatus | null> =>
      ipcRenderer.invoke(channels.UPDATER_GET_STATUS),
    checkNow: (): Promise<UpdaterStatus | null> =>
      ipcRenderer.invoke(channels.UPDATER_CHECK_NOW),
    restart: (): Promise<boolean> => ipcRenderer.invoke(channels.UPDATER_RESTART),
    setChannel: (channel: UpdaterChannel): Promise<UpdaterStatus | null> =>
      ipcRenderer.invoke(channels.UPDATER_SET_CHANNEL, channel),
    onStatusChanged: (callback: (status: UpdaterStatus) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, next: UpdaterStatus) => callback(next);
      ipcRenderer.on(channels.UPDATER_STATUS_CHANGED, handler);
      return () => {
        ipcRenderer.removeListener(channels.UPDATER_STATUS_CHANGED, handler);
      };
    },
  },
  diagnostics: {
    reportError: (payload: { kind: string; message: string; stack?: string }): void => {
      ipcRenderer.send(channels.DIAGNOSTICS_REPORT_ERROR, payload);
    },
    getLastCrash: (): Promise<unknown> =>
      ipcRenderer.invoke(channels.DIAGNOSTICS_LAST_CRASH),
    getOomPause: (): Promise<unknown> =>
      ipcRenderer.invoke(channels.DIAGNOSTICS_OOM_PAUSE),
    clearOomPause: (): Promise<void> =>
      ipcRenderer.invoke(channels.DIAGNOSTICS_CLEAR_OOM_PAUSE),
  },
  tray: {
    publishStatus: (snapshot: {
      agentCount: number;
      localModelCount: number;
      localModelNames: string[];
    }): void => {
      ipcRenderer.send(channels.TRAY_PUBLISH_STATUS, snapshot);
    },
    notifyReady: (): void => {
      ipcRenderer.send(channels.TRAY_NOTIFY_READY);
    },
    getCloseToTray: (): Promise<boolean> =>
      ipcRenderer.invoke(channels.TRAY_GET_CLOSE_TO_TRAY),
    setCloseToTray: (enabled: boolean): Promise<boolean> =>
      ipcRenderer.invoke(channels.TRAY_SET_CLOSE_TO_TRAY, enabled),
    /** What closing one of several windows does: ask, close, or background. */
    getWindowCloseAction: (): Promise<WindowCloseActionPref> =>
      ipcRenderer.invoke(channels.TRAY_GET_WINDOW_CLOSE_ACTION),
    setWindowCloseAction: (action: WindowCloseActionPref): Promise<WindowCloseActionPref> =>
      ipcRenderer.invoke(channels.TRAY_SET_WINDOW_CLOSE_ACTION, action),
    getLoginItem: (): Promise<{ openAtLogin: boolean; supported: boolean }> =>
      ipcRenderer.invoke(channels.TRAY_GET_LOGIN_ITEM),
    setLoginItem: (enabled: boolean): Promise<{ openAtLogin: boolean; supported: boolean }> =>
      ipcRenderer.invoke(channels.TRAY_SET_LOGIN_ITEM, enabled),
    onCommand: (
      callback: (command: {
        type: 'new_chat' | 'open_settings' | 'unload_local_models';
      }) => void,
    ): (() => void) => {
      const handler = (
        _event: IpcRendererEvent,
        command: { type: 'new_chat' | 'open_settings' | 'unload_local_models' },
      ) => callback(command);
      ipcRenderer.on(channels.TRAY_COMMAND, handler);
      return () => ipcRenderer.removeListener(channels.TRAY_COMMAND, handler);
    },
    onCloseToTrayChanged: (callback: (enabled: boolean) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, enabled: boolean) => callback(enabled);
      ipcRenderer.on(channels.TRAY_CLOSE_TO_TRAY_CHANGED, handler);
      return () => ipcRenderer.removeListener(channels.TRAY_CLOSE_TO_TRAY_CHANGED, handler);
    },
    onWindowClosePrompt: (
      callback: (payload: {
        requestId: string;
        title: string;
        heading: string;
        folder: string;
        detail: string;
        checkboxLabel: string;
      }) => void,
    ): (() => void) => {
      const handler = (
        _event: IpcRendererEvent,
        payload: {
          requestId: string;
          title: string;
          heading: string;
          folder: string;
          detail: string;
          checkboxLabel: string;
        },
      ) => callback(payload);
      ipcRenderer.on(channels.WINDOW_CLOSE_PROMPT, handler);
      return () => ipcRenderer.removeListener(channels.WINDOW_CLOSE_PROMPT, handler);
    },
    replyWindowClosePrompt: (
      requestId: string,
      result: { action: 'close' | 'background' | 'cancel'; remember: boolean },
    ): void => {
      ipcRenderer.send(channels.WINDOW_CLOSE_PROMPT_RESULT, { requestId, ...result });
    },
    getZoomPercent: (): Promise<number> => ipcRenderer.invoke(channels.SHELL_GET_ZOOM_PERCENT),
    setZoomPercent: (percent: number): Promise<number> =>
      ipcRenderer.invoke(channels.SHELL_SET_ZOOM_PERCENT, percent),
    onZoomPercentChanged: (callback: (percent: number) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, percent: number) => callback(percent);
      ipcRenderer.on(channels.SHELL_ZOOM_PERCENT_CHANGED, handler);
      return () => ipcRenderer.removeListener(channels.SHELL_ZOOM_PERCENT_CHANGED, handler);
    },
  },
  power: {
    setAfkBoardGuard: (active: boolean): void => {
      void ipcRenderer.invoke(channels.POWER_SET_AFK_GUARD, active);
    },
    onScreenUnlocked: (callback: () => void): (() => void) => {
      const handler = () => callback();
      ipcRenderer.on(channels.POWER_SCREEN_UNLOCKED, handler);
      return () => ipcRenderer.removeListener(channels.POWER_SCREEN_UNLOCKED, handler);
    },
  },
  board: {
    onPauseForShutdown: (callback: () => void): (() => void) => {
      const handler = () => callback();
      ipcRenderer.on(channels.BOARD_PAUSE_FOR_SHUTDOWN, handler);
      return () => ipcRenderer.removeListener(channels.BOARD_PAUSE_FOR_SHUTDOWN, handler);
    },
  },
};

contextBridge.exposeInMainWorld('minnow', minnowBridge);
