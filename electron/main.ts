import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  app,
  BrowserWindow,
  crashReporter,
  dialog,
  ipcMain,
  powerMonitor,
  session,
  shell,
} from 'electron';
import { configurePreviewSession } from './preview-session.js';
import * as channels from './ipc-channels.js';
import type { CodeWindowCommand } from './code-window-command.js';

const codeCommandReady = new Set<number>();
const pendingCodeCommands = new Map<number, CodeWindowCommand[]>();
const codeCommandOrigins = new Map<string, { originId: number; targetId: number; issueId: string }>();
let codeCommandSequence = 0;
import * as crashLog from './crash-log.js';
import {
  destroyAllPreviewHosts,
  registerPreviewHostIpc,
} from './preview-host.js';
import { getProjectRoot, importServerModule } from './server-import.js';
import { startInProcessServer, type InProcessServerHandle } from './server-host.js';
import {
  loadWindowSet,
  markWindowBackgrounded,
  selectRestorableWindows,
  setWindowStateQuitting,
  trackWindowState,
  type PersistedWindowState,
} from './window-state.js';
import { ShellWindowRegistry } from './shell-window-registry.js';
import { SingleViewerWindow } from './agent-browser-viewer-lifecycle.js';
import { appWindowDenialReason, isAppWindowAllowed } from './app-window-allowlist.js';
import { resolveMinnowPort } from './minnow-port.js';
import { disposeUpdater, initUpdater } from './updater.js';
import {
  readCloseToTrayPreference,
  readHardwareAccelerationPreference,
  readHardwareAccelerationSync,
  readShellZoomPercent,
  readWindowCloseAction,
  writeCloseToTrayPreference,
  writeHardwareAccelerationPreference,
  writeShellZoomPercent,
  writeWindowCloseAction,
} from './desktop-shell-config.js';
import { applyShellZoom, DEFAULT_SHELL_ZOOM_PERCENT, shellZoomFactorFromPercent, wireShellZoom } from './shell-zoom.js';
import { readLoginItemSnapshot, writeLoginItemOpenAtLogin } from './login-item.js';
import { createTrayManager, type TrayManager } from './tray.js';
import {
  resolveTrayIconFallbackPath,
  resolveTrayIconPath,
} from './tray-icon.js';
import {
  normalizeWindowCloseAction,
  shouldQuitOnWindowAllClosed,
  type WindowCloseAction,
} from './tray-close.js';
import { workspaceMenuLabel, type TrayWorkspaceEntry } from './tray-workspaces.js';
import {
  buildWindowClosePromptCopy,
  formatNativeWindowCloseDetail,
  parseWindowClosePromptIpc,
  type WindowClosePromptCopy,
  type WindowClosePromptReply,
} from './window-close-prompt.js';
import { revealAbsolutePathInExplorer } from './shell-reveal.js';
import { setAfkBoardPowerGuardActive } from './afk-power-guard.js';
import {
  EMPTY_TRAY_STATUS,
  type TrayRendererCommand,
  type TrayStatusSnapshot,
} from './tray-status.js';

// ── App paths ────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function appIconPath(): string {
  const root = app.isPackaged
    ? app.getAppPath()
    : getProjectRoot();
  if (process.platform === 'win32') {
    return path.join(root, 'build', 'icon.ico');
  }
  return path.join(
    root,
    'public',
    'logos',
    'minnow-logo',
    'minnow',
    'png',
    'minnow-1024.png',
  );
}

function appRoot(): string {
  return app.isPackaged ? app.getAppPath() : getProjectRoot();
}

function trayIconPath(): string {
  return resolveTrayIconPath(process.platform, appRoot());
}

function trayIconFallbackPath(): string {
  return resolveTrayIconFallbackPath(appRoot());
}

// ── Shell state ──────────────────────────────────────────────────────────────

const isDev = process.env.MINNOW_ELECTRON_DEV === '1';
// Vite HMR needs eval in dev; suppress Electron's expected CSP warning.
if (isDev) {
  process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';
}
const devUrl = (
  process.env.MINNOW_DEV_URL?.trim() || `http://localhost:${resolveMinnowPort()}/`
).replace(/\/?$/, '/');

let inProcessServer: InProcessServerHandle | null = null;
let quitInProgress = false;
let closeToTrayEnabled = true;
let windowCloseAction: WindowCloseAction = 'ask';
/**
 * Windows the user (or the tray) has decided really are going away. Without
 * this, close-to-tray would hide them right back and the workspace would stay
 * claimed forever — the pile-up this whole feature exists to stop.
 */
const forceClosingWindowIds = new Set<number>();
let shellZoomPercent = DEFAULT_SHELL_ZOOM_PERCENT;
let trayManager: TrayManager | null = null;
let bootstrapPromise: Promise<void> | null = null;
/** A viewer is auxiliary chrome, never a workspace/session shell window. */
const agentBrowserViewer = new SingleViewerWindow<BrowserWindow>();

/**
 * Which window is on which workspace. Keys must match the server's exactly, so
 * the normalizer is the server's own — see `installWorkspaceKeyNormalizer`.
 */
let normalizeWorkspaceKey: (absPath: string) => string = (absPath) => absPath;
const shellWindows = new ShellWindowRegistry({
  normalizeKey: (absPath) => normalizeWorkspaceKey(absPath),
});

/** Tray command queue per window — a window is not ready until its renderer says so. */
const trayReadyByWindow = new Map<number, { ready: boolean; queue: TrayRendererCommand[] }>();

function trayStateFor(windowId: number): { ready: boolean; queue: TrayRendererCommand[] } {
  let entry = trayReadyByWindow.get(windowId);
  if (!entry) {
    entry = { ready: false, queue: [] };
    trayReadyByWindow.set(windowId, entry);
  }
  return entry;
}

let closePromptSeq = 0;
const pendingClosePrompts = new Map<
  number,
  { requestId: string; resolve: (reply: WindowClosePromptReply | null) => void }
>();

function settleClosePrompt(
  windowId: number,
  requestId: string,
  reply: WindowClosePromptReply | null,
): void {
  const pending = pendingClosePrompts.get(windowId);
  if (!pending || pending.requestId !== requestId) return;
  pendingClosePrompts.delete(windowId);
  pending.resolve(reply);
}

/**
 * Ask the SPA to show the Minnow close dialog. Resolves `null` if send fails
 * so the native MessageBox can still run.
 */
function askRendererWindowClose(
  win: BrowserWindow,
  copy: WindowClosePromptCopy,
): Promise<WindowClosePromptReply | null> {
  return new Promise((resolve) => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) {
      resolve(null);
      return;
    }
    const requestId = `wcp-${win.id}-${++closePromptSeq}`;
    const previous = pendingClosePrompts.get(win.id);
    if (previous) {
      previous.resolve({ action: 'cancel', remember: false });
      pendingClosePrompts.delete(win.id);
    }

    const onClosed = () => {
      settleClosePrompt(win.id, requestId, { action: 'cancel', remember: false });
    };
    pendingClosePrompts.set(win.id, {
      requestId,
      resolve: (reply) => {
        win.removeListener('closed', onClosed);
        resolve(reply);
      },
    });
    win.once('closed', onClosed);
    try {
      win.webContents.send(channels.WINDOW_CLOSE_PROMPT, { requestId, ...copy });
    } catch {
      settleClosePrompt(win.id, requestId, null);
    }
  });
}

/** Every live shell window, most recently focused first. */
function listShellWindows(): BrowserWindow[] {
  const out: BrowserWindow[] = [];
  for (const record of shellWindows.list()) {
    const win = BrowserWindow.fromId(record.windowId);
    if (win && !win.isDestroyed()) out.push(win);
  }
  return out;
}

/** Send to every shell window — for app-wide prefs and notifications. */
function broadcastToShellWindows(channel: string, ...args: unknown[]): void {
  for (const win of listShellWindows()) {
    win.webContents.send(channel, ...args);
  }
}

function focusedShellWindow(): BrowserWindow | null {
  const record = shellWindows.mostRecentlyFocused();
  if (!record) return null;
  const win = BrowserWindow.fromId(record.windowId);
  return win && !win.isDestroyed() ? win : null;
}

// ── Open workspaces ──────────────────────────────────────────────────────────

/**
 * Every shell window with the state the tray and the pickers need: which folder
 * it holds and whether it is still on screen. A window hidden to the tray is
 * reported as a background workspace rather than silently counted as open.
 */
function listWorkspaceWindows(): TrayWorkspaceEntry[] {
  const out: TrayWorkspaceEntry[] = [];
  for (const record of shellWindows.list()) {
    if (record.appId) continue;
    const win = BrowserWindow.fromId(record.windowId);
    if (!win || win.isDestroyed()) continue;
    out.push({
      windowId: record.windowId,
      workspacePath: record.workspacePath,
      visible: win.isVisible(),
    });
  }
  return out;
}

/** Rebuild the tray menu and let every renderer repaint its workspace lists. */
function notifyWorkspaceWindowsChanged(): void {
  if (quitInProgress) return;
  trayManager?.rebuildMenu();
  broadcastToShellWindows(channels.WINDOW_WORKSPACES_CHANGED, listWorkspaceWindows());
}

/**
 * Close a window for real. `forceClosingWindowIds` is what tells the
 * close-to-tray handler to step aside — otherwise this would just hide it.
 */
function closeWorkspaceWindow(windowId: number): boolean {
  const win = BrowserWindow.fromId(windowId);
  if (!win || win.isDestroyed()) {
    shellWindows.unregister(windowId);
    return false;
  }
  forceClosingWindowIds.add(windowId);
  win.close();
  return true;
}

/** Close whichever window holds this folder, if any. */
function closeWorkspaceByPath(
  workspacePath: string,
): { ok: true; closed: boolean } | { ok: false; error: string } {
  const record = shellWindows.findByWorkspace(workspacePath);
  if (!record) return { ok: true, closed: false };
  return { ok: true, closed: closeWorkspaceWindow(record.windowId) };
}

// ── Renderer recovery ────────────────────────────────────────────────────────

/** Per window, else one crashy window burns the others' reload allowance. */
const rendererCrashTimestamps = new Map<number, number[]>();
const RENDERER_CRASH_WINDOW_MS = 60_000;
const RENDERER_CRASH_RELOAD_CAP = 3;

function recoverRenderer(win: BrowserWindow): void {
  if (win.isDestroyed()) return;

  const now = Date.now();
  let timestamps = rendererCrashTimestamps.get(win.id);
  if (!timestamps) {
    timestamps = [];
    rendererCrashTimestamps.set(win.id, timestamps);
  }
  timestamps.push(now);
  while (timestamps.length > 0 && now - timestamps[0]! > RENDERER_CRASH_WINDOW_MS) {
    timestamps.shift();
  }

  if (timestamps.length > RENDERER_CRASH_RELOAD_CAP) {
    const recoveryHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Minnow — recovery</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #0e0e10; color: #e8e8ea; margin: 0; padding: 2rem; }
    h1 { font-size: 1.25rem; margin-bottom: 0.5rem; }
    p { color: #a0a0a8; line-height: 1.5; }
    button { margin-top: 1rem; padding: 0.5rem 1rem; font-size: 1rem; cursor: pointer; }
    code { background: #1a1a1e; padding: 0.15rem 0.35rem; border-radius: 4px; }
  </style>
</head>
<body>
  <h1>Minnow keeps crashing</h1>
  <p>The renderer restarted too many times. Check <code>~/.minnow/logs/crash.jsonl</code> for details.</p>
  <button type="button" onclick="location.reload()">Reload</button>
</body>
</html>`;
    void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(recoveryHtml)}`);
    return;
  }

  win.webContents.reload();
}

function wirePowerWakeNotifications(): void {
  const notify = (): void => {
    broadcastToShellWindows(channels.POWER_SCREEN_UNLOCKED);
  };
  powerMonitor.on('resume', notify);
  powerMonitor.on('unlock-screen', notify);
}

// ── IPC handlers ─────────────────────────────────────────────────────────────

function registerIpcHandlers(): void {
  registerPreviewHostIpc();
  ipcMain.handle(channels.APP_OPEN_EXTERNAL, async (_event, url: string) => {
    if (typeof url === 'string' && url.trim()) {
      await shell.openExternal(url);
    }
  });

  ipcMain.handle(
    channels.SHELL_REVEAL_IN_EXPLORER,
    async (_event, absolutePath: unknown, kind: unknown) => {
      if (typeof absolutePath !== 'string' || !absolutePath.trim()) {
        return { ok: false, error: 'path is required' };
      }
      if (kind !== 'file' && kind !== 'dir') {
        return { ok: false, error: 'kind must be file or dir' };
      }
      return revealAbsolutePathInExplorer(absolutePath.trim(), kind);
    },
  );

  ipcMain.on(channels.DIAGNOSTICS_REPORT_ERROR, (_event, payload: unknown) => {
    if (!payload || typeof payload !== 'object') return;
    const p = payload as Record<string, unknown>;
    const kind = typeof p.kind === 'string' ? p.kind : 'renderer-error';
    const message = typeof p.message === 'string' ? p.message : '';
    const stack = typeof p.stack === 'string' ? p.stack : undefined;
    crashLog.logCrash({ source: 'renderer', kind, message, stack });
  });

  ipcMain.handle(channels.DIAGNOSTICS_LAST_CRASH, () => {
    const marker = crashLog.readLastCrashMarker();
    crashLog.clearLastCrashMarker();
    return marker;
  });

  ipcMain.handle(channels.DIAGNOSTICS_OOM_PAUSE, () => crashLog.readOomPauseMarker());

  ipcMain.handle(channels.DIAGNOSTICS_CLEAR_OOM_PAUSE, () => {
    crashLog.clearOomPauseMarker();
  });

  ipcMain.handle(channels.POWER_SET_AFK_GUARD, (_event, active: unknown) => {
    setAfkBoardPowerGuardActive(active === true);
  });

  ipcMain.handle(channels.WINDOW_MINIMIZE, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });

  ipcMain.handle(channels.WINDOW_MAXIMIZE, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });

  ipcMain.handle(channels.WINDOW_CLOSE, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });

  ipcMain.handle(channels.WINDOW_IS_MAXIMIZED, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return win?.isMaximized() ?? false;
  });

  ipcMain.handle(channels.WINDOW_RESTORE_FOCUS, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    restoreShellWindowFocus(win);
    setTimeout(() => restoreShellWindowFocus(win), 0);
  });

  ipcMain.on(channels.TRAY_PUBLISH_STATUS, (_event, payload: unknown) => {
    if (!payload || typeof payload !== 'object') return;
    const p = payload as Record<string, unknown>;
    const names = Array.isArray(p.localModelNames)
      ? p.localModelNames.filter((n): n is string => typeof n === 'string')
      : [];
    const status: TrayStatusSnapshot = {
      agentCount: typeof p.agentCount === 'number' ? p.agentCount : 0,
      localModelCount: typeof p.localModelCount === 'number' ? p.localModelCount : 0,
      localModelNames: names,
    };
    trayManager?.updateStatus(status);
  });

  ipcMain.on(channels.TRAY_NOTIFY_READY, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    trayStateFor(win.id).ready = true;
    flushQueuedTrayCommands(win);
  });

  ipcMain.on(channels.WINDOW_CLOSE_PROMPT_RESULT, (event, payload: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    const parsed = parseWindowClosePromptIpc(payload);
    settleClosePrompt(win.id, parsed.requestId, parsed);
  });

  ipcMain.handle(channels.TRAY_GET_CLOSE_TO_TRAY, () => closeToTrayEnabled);

  ipcMain.handle(channels.TRAY_SET_CLOSE_TO_TRAY, async (_event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') return closeToTrayEnabled;
    closeToTrayEnabled = await writeCloseToTrayPreference(enabled);
    trayManager?.rebuildMenu();
    broadcastToShellWindows(channels.TRAY_CLOSE_TO_TRAY_CHANGED, closeToTrayEnabled);
    return closeToTrayEnabled;
  });

  ipcMain.handle(channels.TRAY_GET_WINDOW_CLOSE_ACTION, () => windowCloseAction);

  ipcMain.handle(channels.TRAY_SET_WINDOW_CLOSE_ACTION, async (_event, action: unknown) => {
    windowCloseAction = await writeWindowCloseAction(normalizeWindowCloseAction(action));
    return windowCloseAction;
  });

  ipcMain.handle(channels.TRAY_GET_LOGIN_ITEM, () => readLoginItemSnapshot());

  ipcMain.handle(channels.TRAY_SET_LOGIN_ITEM, (_event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') return readLoginItemSnapshot();
    const next = writeLoginItemOpenAtLogin(enabled);
    trayManager?.rebuildMenu();
    return next;
  });

  ipcMain.handle(channels.APP_GET_HARDWARE_ACCELERATION, () =>
    readHardwareAccelerationPreference(),
  );

  ipcMain.handle(channels.APP_SET_HARDWARE_ACCELERATION, async (_event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') return readHardwareAccelerationPreference();
    return writeHardwareAccelerationPreference(enabled);
  });

  ipcMain.handle(channels.APP_RESTART, async () => {
    await prepareQuitForUpdate();
    app.relaunch();
    app.exit(0);
  });

  ipcMain.handle(channels.SHELL_GET_ZOOM_PERCENT, () => shellZoomPercent);

  // Shell zoom stays an app-wide preference, so apply it everywhere — but this
  // used to ignore `event.sender` entirely and zoom whichever window happened to
  // be `mainWindow`.
  ipcMain.handle(channels.SHELL_SET_ZOOM_PERCENT, async (event, percent: unknown) => {
    if (typeof percent !== 'number' || !Number.isFinite(percent)) return shellZoomPercent;
    shellZoomPercent = await writeShellZoomPercent(percent);
    const sender = BrowserWindow.fromWebContents(event.sender);
    if (sender && !sender.isDestroyed()) {
      applyShellZoom(sender.webContents, shellZoomPercent);
    }
    for (const win of listShellWindows()) {
      if (sender && win.id === sender.id) {
        win.webContents.send(channels.SHELL_ZOOM_PERCENT_CHANGED, shellZoomPercent);
        continue;
      }
      applyShellZoom(win.webContents, shellZoomPercent);
      win.webContents.send(channels.SHELL_ZOOM_PERCENT_CHANGED, shellZoomPercent);
    }
    return shellZoomPercent;
  });

  ipcMain.handle(channels.WINDOW_NEW, async () => openNewShellWindow());

  ipcMain.handle(channels.WINDOW_CODE_READY, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || shellWindows.get(win.id)?.appId) return;
    codeCommandReady.add(win.id);
    for (const command of pendingCodeCommands.get(win.id) ?? []) {
      event.sender.send(channels.WINDOW_CODE_COMMAND, command);
    }
    pendingCodeCommands.delete(win.id);
  });

  ipcMain.handle(channels.WINDOW_CODE_LINK, (event, requestId: string, chatId: string) => {
    const source = codeCommandOrigins.get(requestId);
    if (!source || source.targetId !== event.sender.id || typeof chatId !== 'string') return;
    codeCommandOrigins.delete(requestId);
    const origin = BrowserWindow.getAllWindows().find((win) => win.webContents.id === source.originId);
    if (origin && !origin.isDestroyed()) origin.webContents.send(channels.WINDOW_CODE_LINK, source.issueId, chatId);
  });

  ipcMain.handle(channels.WINDOW_CODE_COMMAND, async (event, command: CodeWindowCommand) => {
    if (!command || typeof command.workspacePath !== 'string' || !command.workspacePath.trim() ||
        !['seed', 'file', 'chat', 'board', 'activity'].includes(command.kind)) {
      return { ok: false, error: 'Invalid Code window command' };
    }
    const opened = await openOrFocusWorkspaceWindow(command.workspacePath.trim());
    if (!opened.ok) return opened;
    const record = shellWindows.findByWorkspace(command.workspacePath.trim());
    const win = record && BrowserWindow.fromId(record.windowId);
    if (!win || win.isDestroyed()) return { ok: false, error: 'Code window unavailable' };
    if (command.kind === 'seed' && command.issueId) {
      const requestId = String(++codeCommandSequence);
      codeCommandOrigins.set(requestId, { originId: event.sender.id, targetId: win.webContents.id, issueId: command.issueId });
      command = { ...command, requestId };
      setTimeout(() => codeCommandOrigins.delete(requestId), 60 * 60 * 1000).unref();
    }
    if (codeCommandReady.has(win.id)) win.webContents.send(channels.WINDOW_CODE_COMMAND, command);
    else pendingCodeCommands.set(win.id, [...(pendingCodeCommands.get(win.id) ?? []), command]);
    return { ok: true };
  });

  ipcMain.handle(channels.WINDOW_OPEN_WORKSPACE, async (_event, workspacePath: unknown) => {
    if (typeof workspacePath !== 'string' || !workspacePath.trim()) {
      return { ok: false, error: 'workspacePath is required' };
    }
    return openOrFocusWorkspaceWindow(workspacePath.trim());
  });

  ipcMain.handle(channels.WINDOW_LIST_WORKSPACES, () =>
    shellWindows
      .list()
      .filter((record) => record.workspacePath && !record.appId)
      .map((record) => record.workspacePath),
  );

  ipcMain.handle(channels.WINDOW_LIST_WORKSPACE_WINDOWS, () => listWorkspaceWindows());

  ipcMain.handle(channels.WINDOW_CLOSE_WORKSPACE, (_event, workspacePath: unknown) => {
    if (typeof workspacePath !== 'string' || !workspacePath.trim()) {
      return { ok: false, error: 'workspacePath is required' };
    }
    return closeWorkspaceByPath(workspacePath.trim());
  });

  ipcMain.handle(channels.WINDOW_SWITCH_WORKSPACE, async (event, workspacePath: unknown) => {
    if (typeof workspacePath !== 'string' || !workspacePath.trim()) {
      return { ok: false, error: 'workspacePath is required' };
    }
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return { ok: false, error: 'No window' };
    return retargetShellWindow(win, workspacePath.trim());
  });

  ipcMain.handle(channels.WINDOW_OPEN_APP, async (event, appId: unknown) => {
    return openOrFocusAppWindow(appId, BrowserWindow.fromWebContents(event.sender));
  });

  ipcMain.handle(channels.WINDOW_HAS_APP, (_event, appId: unknown) => {
    if (!isAppWindowAllowed(appId)) return { open: false };
    return { open: Boolean(shellWindows.findAppWindow(appId)) };
  });

  ipcMain.handle(channels.WINDOW_OPEN_AGENT_BROWSER_VIEWER, async (event) => {
    const sender = BrowserWindow.fromWebContents(event.sender);
    // Only a Minnow shell renderer may create auxiliary desktop windows. This
    // avoids handing a generic loaded page a window-creation capability.
    if (!sender || sender.isDestroyed() || !shellWindows.get(sender.id)) {
      return { ok: false, error: 'Open the Agent Browser from a Minnow workspace window' };
    }
    try {
      const host = new URL(await shellLoadUrl()).origin;
      if (new URL(event.sender.getURL()).origin !== host) {
        return { ok: false, error: 'Open the Agent Browser from a Minnow workspace window' };
      }
    } catch {
      return { ok: false, error: 'Open the Agent Browser from a Minnow workspace window' };
    }
    return openOrFocusAgentBrowserViewer(shellWindows.get(sender.id)?.workspacePath ?? '');
  });
}

// ── Window chrome ────────────────────────────────────────────────────────────

function wireShellWindowState(win: BrowserWindow): void {
  const emit = (): void => {
    if (win.isDestroyed()) return;
    win.webContents.send(channels.WINDOW_MAXIMIZED_CHANGED, win.isMaximized());
  };

  win.on('maximize', emit);
  win.on('unmaximize', emit);
  win.on('enter-full-screen', emit);
  win.on('leave-full-screen', emit);
  win.webContents.on('did-finish-load', emit);
}

function wireShellWindowVisibility(win: BrowserWindow): void {
  const emit = (): void => {
    if (win.isDestroyed()) return;
    const visible = win.isVisible() && !win.isMinimized();
    win.webContents.send(channels.WINDOW_VISIBILITY_CHANGED, visible);
  };

  // Minimizing is not backgrounding: only hide/show move a window in and out of
  // the tray, and only that decides whether the next launch restores it.
  win.on('show', () => {
    markWindowBackgrounded(win.id, false);
    notifyWorkspaceWindowsChanged();
    emit();
  });
  win.on('hide', () => {
    markWindowBackgrounded(win.id, true);
    notifyWorkspaceWindowsChanged();
    emit();
  });
  win.on('minimize', emit);
  win.on('restore', emit);
  win.webContents.on('did-finish-load', emit);
}

async function pauseOrchestrateBoardsInRenderer(win: BrowserWindow): Promise<void> {
  if (win.isDestroyed()) return;
  try {
    win.webContents.send(channels.BOARD_PAUSE_FOR_SHUTDOWN);
    await win.webContents.executeJavaScript(
      '(typeof globalThis.__minnowPrepareForShutdown==="function"&&globalThis.__minnowPrepareForShutdown())||(typeof globalThis.__minnowPauseBoardsForShutdown==="function"&&globalThis.__minnowPauseBoardsForShutdown())',
      true,
    );
  } catch {
  }
}

// ── Shutdown ─────────────────────────────────────────────────────────────────

async function shutdownRuntime(): Promise<void> {
  await Promise.all(listShellWindows().map((win) => pauseOrchestrateBoardsInRenderer(win)));
  destroyAllPreviewHosts();
  await shutdownAgentBrowserRuntime().catch((err) => {
    console.error('[electron] shutdown Agent Browser failed:', err);
  });
  const [ptyHost, generationsStore, modelsIndex, serversIndex] = await Promise.all([
    importServerModule<{ destroyAllPtySessions: () => void }>('terminal/pty-host.js'),
    importServerModule<{ deleteGenerationsForProviderShutdown: () => void }>(
      'generations/store.js',
    ),
    importServerModule<{ shutdownAllModelServes: () => Promise<void> }>('models/index.js'),
    importServerModule<{ shutdownAllServers: () => Promise<void> }>('servers/index.js'),
  ]);
  const { destroyAllPtySessions } = ptyHost;
  const { deleteGenerationsForProviderShutdown } = generationsStore;
  const { shutdownAllModelServes } = modelsIndex;
  const { shutdownAllServers } = serversIndex;
  destroyAllPtySessions();
  deleteGenerationsForProviderShutdown();
  await shutdownAllModelServes().catch((err) => {
    console.error('[electron] shutdown model serves failed:', err);
  });
  await shutdownAllServers().catch((err) => {
    console.error('[electron] shutdown managed servers failed:', err);
  });
  if (inProcessServer) {
    const close = inProcessServer.close;
    inProcessServer = null;
    await close();
  }
}

/**
 * Dev Electron talks to the separate `server.js` process over its authenticated
 * route. Packaged Electron owns that server process, so it closes the singleton
 * directly and cannot accidentally import a second service instance.
 */
async function shutdownAgentBrowserRuntime(): Promise<void> {
  await whenServerTransportKnown();
  if (inProcessServer) {
    const api = await importServerModule<{
      shutdownAgentBrowserService: () => Promise<void>;
    }>('browser-agent-api.js');
    await api.shutdownAgentBrowserService();
    return;
  }

  const token = readServerSessionToken();
  const response = await fetch(`${devUrl.replace(/\/$/, '')}/api/browser-agent/shutdown`, {
    method: 'POST',
    headers: token ? { 'X-Minnow-Token': token } : {},
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Agent Browser shutdown failed (HTTP ${response.status})`);
}

async function prepareQuitForUpdate(): Promise<void> {
  if (quitInProgress) return;
  quitInProgress = true;
  setWindowStateQuitting(true);
  disposeUpdater();
  await shutdownRuntime();
}

function restoreShellWindowFocus(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  win.webContents.focus();
}

/** Focus a specific window, else the most recently focused one. */
function focusWindow(target?: BrowserWindow | null): void {
  const win = target && !target.isDestroyed() ? target : focusedShellWindow();
  if (!win) return;
  restoreShellWindowFocus(win);
}

/** Tray commands go to the focused window. */
function sendTrayCommand(command: TrayRendererCommand): void {
  const win = focusedShellWindow();
  if (!win) return;
  const state = trayStateFor(win.id);
  if (!state.ready) {
    state.queue.push(command);
    return;
  }
  win.webContents.send(channels.TRAY_COMMAND, command);
}

function flushQueuedTrayCommands(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  const state = trayStateFor(win.id);
  while (state.queue.length > 0) {
    const command = state.queue.shift();
    if (command) win.webContents.send(channels.TRAY_COMMAND, command);
  }
}

function requestExplicitQuit(): void {
  if (quitInProgress) return;
  quitInProgress = true;
  setWindowStateQuitting(true);
  for (const win of listShellWindows()) {
    win.close();
  }
  app.quit();
}

// ── Tray ─────────────────────────────────────────────────────────────────────

async function persistWindowCloseAnswer(
  answer: WindowClosePromptReply,
): Promise<WindowClosePromptReply> {
  if (answer.remember && answer.action !== 'cancel') {
    windowCloseAction = await writeWindowCloseAction(answer.action);
  }
  return answer;
}

/**
 * Ask what closing one of several windows should do.
 *
 * Prefers the in-app Minnow dialog in that window. Native MessageBox is only
 * used when the renderer is not ready yet. "Remember" writes the answer to
 * `config.json`; the Desktop settings section can set it back to asking.
 */
async function promptWindowClose(
  win: BrowserWindow,
): Promise<WindowClosePromptReply> {
  const record = shellWindows.get(win.id);
  const folder = record?.workspacePath?.trim() ?? '';
  const name = folder ? workspaceMenuLabel(folder) : 'this window';
  const copy = buildWindowClosePromptCopy(folder, name);

  if (!win.isDestroyed() && trayStateFor(win.id).ready) {
    restoreShellWindowFocus(win);
    const inApp = await askRendererWindowClose(win, copy);
    if (inApp) return persistWindowCloseAnswer(inApp);
  }

  const { response, checkboxChecked } = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['Close workspace', 'Keep in background', 'Cancel'],
    defaultId: 1,
    cancelId: 2,
    title: copy.title,
    message: copy.heading,
    detail: formatNativeWindowCloseDetail(copy),
    checkboxLabel: copy.checkboxLabel,
    checkboxChecked: false,
    noLink: true,
  });

  const action: WindowClosePromptReply['action'] =
    response === 0 ? 'close' : response === 1 ? 'background' : 'cancel';
  return persistWindowCloseAnswer({ action, remember: checkboxChecked === true });
}

function ensureTrayManager(): TrayManager {
  if (!trayManager) {
    trayManager = createTrayManager({
      trayIconPath,
      trayIconFallbackPath,
      // Closing every workspace can now really leave zero windows, so the tray
      // has to be able to bring one back rather than clicking into nothing.
      focusMainWindow: () => {
        if (shellWindows.size > 0) {
          focusWindow();
          return;
        }
        bootstrap()
          .then(() => restoreShellWindows())
          .catch(failBootstrap);
      },
      newWindow: () => {
        void openNewShellWindow();
      },
      requestQuit: requestExplicitQuit,
      sendTrayCommand: (command) => {
        focusWindow();
        sendTrayCommand(command);
      },
      getCloseToTray: () => closeToTrayEnabled,
      setCloseToTray: async (enabled) => {
        closeToTrayEnabled = await writeCloseToTrayPreference(enabled);
        broadcastToShellWindows(channels.TRAY_CLOSE_TO_TRAY_CHANGED, closeToTrayEnabled);
        return closeToTrayEnabled;
      },
      getLoginItem: readLoginItemSnapshot,
      setLoginItem: writeLoginItemOpenAtLogin,
      isQuitInProgress: () => quitInProgress,
      listWorkspaceWindows,
      focusWorkspaceWindow: (windowId) => {
        const win = BrowserWindow.fromId(windowId);
        if (win && !win.isDestroyed()) focusWindow(win);
      },
      closeWorkspaceWindow: (windowId) => {
        closeWorkspaceWindow(windowId);
      },
      isForceClosing: (windowId) => forceClosingWindowIds.has(windowId),
      getWindowCloseAction: () => windowCloseAction,
      promptWindowClose: promptWindowClose,
    });
  }
  return trayManager;
}

// ── Main window ──────────────────────────────────────────────────────────────

/**
 * One SPA renderer per workspace.
 *
 * The workspace reaches the renderer through `webPreferences.additionalArguments`,
 * read in preload from `process.argv` and exposed as `window.minnow.viewContext`.
 * No IPC round-trip, and it works in dev and packaged alike.
 *
 * Preload is electron/preload.mjs; Electron treats .js preloads as CommonJS.
 */
async function createShellWindow(
  options: { workspacePath?: string; bounds?: PersistedWindowState; appId?: string } = {},
): Promise<BrowserWindow> {
  const workspacePath = options.workspacePath?.trim() ?? '';
  const saved = options.bounds ?? (await loadWindowSet()).windows[0]!;
  const preloadPath = path.join(__dirname, 'preload.mjs');
  const viewId = shellWindows.nextViewId();
  const appId = options.appId?.trim() || undefined;

  const extraArgs = [
    `--minnow-workspace=${workspacePath}`,
    `--minnow-view-id=${viewId}`,
  ];
  if (appId) extraArgs.push(`--minnow-app-window=${appId}`);

  const win = new BrowserWindow({
    width: saved.width,
    height: saved.height,
    x: saved.x,
    y: saved.y,
    show: false,
    icon: appIconPath(),
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hiddenInset' as const,
          trafficLightPosition: { x: 14, y: 14 },
        }
      : { frame: false, thickFrame: true }),
    backgroundColor: '#0e0e10',
    webPreferences: {
      preload: preloadPath,
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      zoomFactor: shellZoomFactorFromPercent(shellZoomPercent),
      backgroundThrottling: false,
      additionalArguments: extraArgs,
    },
  });

  // Window-local, not a `globalShortcut` — that would take Ctrl/Cmd+Shift+N
  // away from every other app on the machine.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.key?.toLowerCase() !== 'n') return;
    if (!input.shift) return;
    const modifier = process.platform === 'darwin' ? input.meta : input.control;
    if (!modifier) return;
    event.preventDefault();
    void openNewShellWindow();
  });

  shellWindows.register(win.id, workspacePath, viewId, appId);
  if (appId) {
    win.setTitle(`Minnow — ${appId.charAt(0).toUpperCase()}${appId.slice(1)}`);
  }
  // App windows ride the main window's filesystem claim. Claiming here would
  // bump the refcount; releasing on close could drop the allowlist while Code
  // is still open. v1 does not persist app windows across restarts.
  // The renderer's first API requests already carry X-Minnow-Workspace, so the
  // server must admit this folder before the page starts loading.
  if (workspacePath && !appId) {
    try {
      await claimWorkspaceOnServer(workspacePath);
    } catch (err) {
      shellWindows.unregister(win.id);
      win.destroy();
      throw err;
    }
  }
  notifyWorkspaceWindowsChanged();
  win.on('focus', () => shellWindows.markFocused(win.id));

  wireShellWindowVisibility(win);

  wireShellZoom(win, {
    readPercent: async () => shellZoomPercent,
    writePercent: async (percent) => {
      shellZoomPercent = await writeShellZoomPercent(percent);
      return shellZoomPercent;
    },
    notifyPercentChanged: (percent) => {
      if (win.isDestroyed()) return;
      win.webContents.send(channels.SHELL_ZOOM_PERCENT_CHANGED, percent);
    },
  });

  if (saved.isMaximized) {
    win.maximize();
  }

  if (!appId) {
    trackWindowState(win, () => shellWindows.get(win.id)?.workspacePath ?? '');
  }
  wireShellWindowState(win);

  const showFallbackTimer = setTimeout(() => {
    if (!win.isDestroyed() && !win.isVisible()) {
      console.warn('[electron] Showing window after load timeout');
      win.show();
    }
  }, 15_000);

  win.once('ready-to-show', () => {
    clearTimeout(showFallbackTimer);
    win.show();
  });

  win.on('closed', () => {
    clearTimeout(showFallbackTimer);
    codeCommandReady.delete(win.id);
    pendingCodeCommands.delete(win.id);
    const record = shellWindows.unregister(win.id);
    trayReadyByWindow.delete(win.id);
    rendererCrashTimestamps.delete(win.id);
    forceClosingWindowIds.delete(win.id);
    if (record?.workspacePath && !record.appId) void releaseWorkspaceOnServer(record.workspacePath);
    notifyWorkspaceWindowsChanged();
  });

  ensureTrayManager().wireWindowClose(win);

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error(
      `[electron] Failed to load ${validatedURL}: ${errorDescription} (${errorCode})`,
    );
    if (!win.isDestroyed() && !win.isVisible()) {
      win.show();
    }
  });

  win.webContents.on('render-process-gone', (_event, details) => {
    crashLog.logCrash({
      source: 'renderer',
      kind: 'render-process-gone',
      reason: details.reason,
      exitCode: details.exitCode,
      message: `Renderer process gone: ${details.reason}`,
    });
    crashLog.writeLastCrashMarker({
      kind: 'render-process-gone',
      reason: details.reason,
      exitCode: details.exitCode,
      message: `Renderer process gone: ${details.reason}`,
    });
    if (details.reason === 'oom') {
      crashLog.writeOomPauseMarker();
    }
    crashLog.flushCrashLogSync();
    if (details.reason === 'clean-exit' || win.isDestroyed()) return;
    recoverRenderer(win);
  });

  win.webContents.on('unresponsive', () => {
    crashLog.logCrash({
      source: 'renderer',
      kind: 'unresponsive',
      message: 'Renderer became unresponsive',
    });
    crashLog.flushCrashLogSync();
  });

  win.webContents.on('responsive', () => {
    crashLog.logCrash({
      source: 'renderer',
      kind: 'responsive',
      message: 'Renderer became responsive again',
    });
  });

  return win;
}

/**
 * Tell the server a view is on this folder. Membership in that registry is the
 * filesystem security boundary — a folder no window has open is not writable.
 *
 * Packaged Minnow runs the HTTP server in this process, so calling the module
 * directly reaches the live registry. In dev the server is a *separate* process
 * (`npm run desktop` spawns `node server.js`), where the module import would
 * register into a second, unused copy — so that case goes over HTTP.
 */
function minnowHomeDir(): string {
  const override = process.env.MINNOW_HOME;
  if (typeof override === 'string' && override.trim()) return override.trim();
  const homedir = os.homedir();
  if (homedir) return path.join(homedir, '.minnow');
  return path.join(os.tmpdir(), '.minnow');
}

/** The per-boot credential the server writes at startup. */
function readServerSessionToken(): string {
  try {
    return fs.readFileSync(path.join(minnowHomeDir(), 'session-token'), 'utf8').trim();
  } catch {
    return '';
  }
}

async function callOpenWorkspaceApi(
  method: 'POST' | 'DELETE',
  workspacePath: string,
): Promise<void> {
  const base = (inProcessServer?.url ?? devUrl).replace(/\/$/, '');
  const token = readServerSessionToken();
  const response = await fetch(`${base}/api/workspace/open`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'X-Minnow-Token': token } : {}),
    },
    body: JSON.stringify({ path: workspacePath }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      `workspace registration failed (${response.status})${detail ? `: ${detail}` : ''}`,
    );
  }
}

/**
 * Wait for the runtime to pick a transport before deciding how to reach it.
 *
 * `inProcessServer` is only assigned once `resolveLoadUrl()` has started the
 * packaged server, and `bootstrapInner` deliberately does not await that — so a
 * claim fired from `createShellWindow` used to see `inProcessServer === null` in
 * a packaged build and POST to the *dev* port, which nothing is listening on.
 * The folder then never entered the open-workspace registry and every request
 * from that window fell back to the persisted global.
 */
async function whenServerTransportKnown(): Promise<void> {
  try {
    await shellLoadUrl();
  } catch {
    // Load-URL failures surface when a window tries to load; the claim below
    // still has the HTTP fallback to try.
  }
}

async function claimWorkspaceOnServer(workspacePath: string): Promise<void> {
  await whenServerTransportKnown();
  if (inProcessServer) {
    try {
      const mod = await importServerModule<{ openWorkspace: (p: string) => string }>(
        'workspace/open-workspaces.js',
      );
      mod.openWorkspace(workspacePath);
      return;
    } catch (err) {
      console.warn('[electron] in-process workspace registration failed:', err);
    }
  }
  try {
    await callOpenWorkspaceApi('POST', workspacePath);
  } catch (err) {
    console.warn('[electron] could not register open workspace:', err);
    throw err;
  }
}

async function releaseWorkspaceOnServer(workspacePath: string): Promise<void> {
  await whenServerTransportKnown();
  if (inProcessServer) {
    try {
      const mod = await importServerModule<{ closeWorkspace: (p: string) => boolean }>(
        'workspace/open-workspaces.js',
      );
      mod.closeWorkspace(workspacePath);
      return;
    } catch {
      // The runtime may already be torn down.
    }
  }
  try {
    await callOpenWorkspaceApi('DELETE', workspacePath);
  } catch {
    // The server may already be gone; the registry is in-memory anyway.
  }
}

/**
 * Use the server's own path normalizer so window keys and allowlist keys agree.
 * Writing a third normalizer here is how the duplicate-open rule would quietly
 * stop working on Windows and macOS.
 */
async function installWorkspaceKeyNormalizer(): Promise<void> {
  try {
    const mod = await importServerModule<{
      normalizeWorkspacePathKey: (absPath: string) => string;
    }>('workspace/root.js');
    normalizeWorkspaceKey = mod.normalizeWorkspacePathKey;
  } catch (err) {
    console.warn('[electron] falling back to identity workspace keys:', err);
  }
}

/**
 * A fresh window at the folder gate. The user picks a folder there, and that
 * pick goes through `WINDOW_OPEN_WORKSPACE`, so the duplicate-open rule still
 * applies.
 */
async function openNewShellWindow(): Promise<
  { ok: true } | { ok: false; error: string }
> {
  try {
    await bootstrap();
    const win = await openShellWindow({});
    focusWindow(win);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function wireAgentBrowserViewerState(win: BrowserWindow): void {
  const emitMaximized = (): void => {
    if (!win.isDestroyed()) {
      win.webContents.send(channels.WINDOW_MAXIMIZED_CHANGED, win.isMaximized());
    }
  };
  const emitVisibility = (): void => {
    if (!win.isDestroyed()) {
      win.webContents.send(channels.WINDOW_VISIBILITY_CHANGED, win.isVisible() && !win.isMinimized());
    }
  };
  win.on('maximize', emitMaximized);
  win.on('unmaximize', emitMaximized);
  win.on('enter-full-screen', emitMaximized);
  win.on('leave-full-screen', emitMaximized);
  win.on('show', emitVisibility);
  win.on('hide', emitVisibility);
  win.on('minimize', emitVisibility);
  win.on('restore', emitVisibility);
  win.webContents.on('did-finish-load', () => {
    emitMaximized();
    emitVisibility();
  });
}

/** Open the single optional viewer without registering a workspace/session view. */
async function openOrFocusAgentBrowserViewer(workspacePath: string): Promise<
  { ok: true; focused: boolean } | { ok: false; error: string }
> {
  const existing = agentBrowserViewer.live();
  if (existing) {
    restoreShellWindowFocus(existing);
    return { ok: true, focused: true };
  }

  return agentBrowserViewer.begin(async (): Promise<{ ok: true; focused: boolean } | { ok: false; error: string }> => {
    let win: BrowserWindow | null = null;
    let showFallbackTimer: ReturnType<typeof setTimeout> | null = null;
    try {
      await bootstrap();
      const baseUrl = await shellLoadUrl();
      const preloadPath = path.join(__dirname, 'preload.mjs');
      const viewerWindow = new BrowserWindow({
        width: 1240,
        height: 860,
        minWidth: 840,
        minHeight: 600,
        show: false,
        icon: appIconPath(),
        ...(process.platform === 'darwin'
          ? {
              titleBarStyle: 'hiddenInset' as const,
              trafficLightPosition: { x: 14, y: 14 },
            }
          : { frame: false, thickFrame: true }),
        backgroundColor: '#0e0e10',
        webPreferences: {
          preload: preloadPath,
          sandbox: false,
          contextIsolation: true,
          nodeIntegration: false,
          webviewTag: false,
          zoomFactor: shellZoomFactorFromPercent(shellZoomPercent),
          backgroundThrottling: false,
          additionalArguments: [
            '--minnow-agent-browser-viewer',
            `--minnow-workspace=${workspacePath}`,
            '--minnow-view-id=agent-browser-viewer',
          ],
        },
      });
      win = viewerWindow;
      agentBrowserViewer.set(viewerWindow);
      viewerWindow.setTitle('Minnow — Agent Browser');
      wireAgentBrowserViewerState(viewerWindow);
      showFallbackTimer = setTimeout(() => {
        if (!viewerWindow.isDestroyed() && !viewerWindow.isVisible()) viewerWindow.show();
      }, 15_000);
      viewerWindow.once('ready-to-show', () => {
        if (showFallbackTimer) clearTimeout(showFallbackTimer);
        showFallbackTimer = null;
        viewerWindow.show();
      });
      viewerWindow.once('closed', () => {
        if (showFallbackTimer) clearTimeout(showFallbackTimer);
        agentBrowserViewer.clear(viewerWindow);
      });
      viewerWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      const viewerUrl = `${baseUrl}#/agent-browser`;
      const preventOffRouteNavigation = (event: Electron.Event, targetUrl: string): void => {
        if (targetUrl === viewerUrl) return;
        event.preventDefault();
      };
      viewerWindow.webContents.on('will-navigate', preventOffRouteNavigation);
      viewerWindow.webContents.on('will-redirect', preventOffRouteNavigation);
      await viewerWindow.loadURL(viewerUrl);
      return { ok: true, focused: false };
    } catch (err) {
      if (showFallbackTimer) clearTimeout(showFallbackTimer);
      if (win) agentBrowserViewer.clear(win);
      if (win && !win.isDestroyed()) win.destroy();
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

/**
 * A folder opens in exactly one view. Opening it again focuses the window that
 * already has it — this is the rule that keeps two views from owning the same
 * `sessions.db` chat rows and 409-thrashing each other.
 */
async function openOrFocusWorkspaceWindow(
  workspacePath: string,
): Promise<{ ok: true; focused: boolean } | { ok: false; error: string }> {
  const existing = shellWindows.findByWorkspace(workspacePath);
  if (existing) {
    const win = BrowserWindow.fromId(existing.windowId);
    if (win && !win.isDestroyed()) {
      focusWindow(win);
      return { ok: true, focused: true };
    }
    shellWindows.unregister(existing.windowId);
  }

  // A window still sitting at the folder gate adopts the folder rather than
  // spawning a second, empty window beside itself.
  const gateWindow = listShellWindows().find(
    (win) => !shellWindows.get(win.id)?.workspacePath,
  );
  if (gateWindow) {
    // The gate window is destroyed by the retarget, so focus whatever replaced
    // it rather than a handle that is already gone.
    const retargeted = await retargetShellWindow(gateWindow, workspacePath);
    if (!retargeted.ok) return retargeted;
    const adopted = shellWindows.findByWorkspace(workspacePath);
    focusWindow(adopted ? BrowserWindow.fromId(adopted.windowId) : null);
    return { ok: true, focused: false };
  }

  try {
    await openShellWindow({ workspacePath });
    return { ok: true, focused: false };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * One dedicated window per app. Opening again focuses the existing window.
 * App windows share the caller's folder but do not claim it on the server.
 */
async function openOrFocusAppWindow(
  appId: unknown,
  sender: BrowserWindow | null,
): Promise<{ ok: true; focused: boolean } | { ok: false; error: string }> {
  const denial = appWindowDenialReason(appId);
  if (denial) return { ok: false, error: denial };
  const id = appId as string;

  const existing = shellWindows.findAppWindow(id);
  if (existing) {
    const win = BrowserWindow.fromId(existing.windowId);
    if (win && !win.isDestroyed()) {
      focusWindow(win);
      return { ok: true, focused: true };
    }
    shellWindows.unregister(existing.windowId);
  }

  const senderRecord = sender && !sender.isDestroyed() ? shellWindows.get(sender.id) : undefined;
  const workspacePath =
    senderRecord?.workspacePath?.trim() ||
    shellWindows.list().find((record) => record.workspacePath && !record.appId)?.workspacePath ||
    '';
  if (!workspacePath) {
    return { ok: false, error: 'Open a workspace folder first' };
  }

  try {
    await bootstrap();
    await openShellWindow({ workspacePath, appId: id });
    return { ok: true, focused: false };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Switching folders inside a window is "tell main this view is now folder X,
 * then reload the renderer". Everything the old in-renderer teardown rebuilt is
 * persisted per workspace on disk, so a reload is strictly safer than a partial
 * reset.
 */
async function retargetShellWindow(
  win: BrowserWindow,
  workspacePath: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (shellWindows.get(win.id)?.appId) {
    return { ok: false, error: 'Cannot switch the folder of an app window' };
  }

  // Already this view: focusing is enough. Replacing the window made Open plan
  // (and any other launch that passed the same folder with different spelling)
  // look like the workspace opened a second time.
  if (shellWindows.isWindowOnWorkspace(win.id, workspacePath)) {
    focusWindow(win);
    return { ok: true };
  }

  const clash = shellWindows.findByWorkspace(workspacePath);
  if (clash && clash.windowId !== win.id) {
    const other = BrowserWindow.fromId(clash.windowId);
    if (other && !other.isDestroyed()) {
      focusWindow(other);
      return { ok: false, error: 'That folder is already open in another window' };
    }
    shellWindows.unregister(clash.windowId);
  }

  const previous = shellWindows.get(win.id)?.workspacePath ?? '';

  // additionalArguments are fixed at window creation, so a retarget needs a new
  // window rather than a reload of this one.
  //
  // The replacement claims the folder itself in `createShellWindow`, and
  // `openShellWindow` unregisters the outgoing window before destroying it — so
  // its `closed` handler releases nothing. Claiming here as well left the new
  // folder on refcount 2 and pinned inside the filesystem allowlist forever;
  // releasing the old folder is this function's only registry work.
  try {
    await openShellWindow({ workspacePath, replacing: win });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (previous && previous !== workspacePath) {
    await releaseWorkspaceOnServer(previous);
  }
  return { ok: true };
}

// ── Bootstrap ────────────────────────────────────────────────────────────────

function resolveElectronAppRoot(): string {
  if (app.isPackaged) {
    return app.getAppPath();
  }
  return getProjectRoot();
}

async function resolveLoadUrl(): Promise<string> {
  if (isDev) {
    return devUrl;
  }

  const { setAppRoot } = await importServerModule<{ setAppRoot: (dir: string) => void }>(
    'workspace/root.js',
  );
  const { bootstrapMinnowRuntime } = await importServerModule<{
    bootstrapMinnowRuntime: () => Promise<{
      workspacePath: string;
      homePath: string;
    }>;
  }>('runtime/bootstrap.js');
  setAppRoot(resolveElectronAppRoot());
  const { workspacePath, homePath } = await bootstrapMinnowRuntime();
  console.log(`Workspace: ${workspacePath}`);
  console.log(`Minnow data: ${homePath}`);

  inProcessServer = await startInProcessServer();
  return inProcessServer.url;
}

async function bootstrap(): Promise<void> {
  if (bootstrapPromise) return bootstrapPromise;
  bootstrapPromise = bootstrapInner();
  try {
    await bootstrapPromise;
  } catch (err) {
    bootstrapPromise = null;
    throw err;
  }
}

/**
 * Runtime init, exactly once. Split from `openShellWindow` because `bootstrap()`
 * memoizes its promise and only clears it on failure — so on macOS, after a real
 * close, `activate` resolved the cached promise and never recreated a window.
 */
async function bootstrapInner(): Promise<void> {
  configurePreviewSession(session.fromPartition('persist:minnow-preview'));
  registerIpcHandlers();
  wirePowerWakeNotifications();
  initUpdater({ prepareQuitForUpdate });

  closeToTrayEnabled = await readCloseToTrayPreference();
  windowCloseAction = await readWindowCloseAction();
  shellZoomPercent = await readShellZoomPercent();
  const tray = ensureTrayManager();
  tray.ensureTray();
  tray.updateStatus({ ...EMPTY_TRAY_STATUS });

  // Kick the server (and therefore the URL every window loads) once.
  shellLoadUrlPromise = resolveLoadUrl();
  shellLoadUrlPromise.catch(() => {});
  await installWorkspaceKeyNormalizer();
}

let shellLoadUrlPromise: Promise<string> | null = null;

async function shellLoadUrl(): Promise<string> {
  if (!shellLoadUrlPromise) {
    shellLoadUrlPromise = resolveLoadUrl();
    shellLoadUrlPromise.catch(() => {});
  }
  return shellLoadUrlPromise;
}

/** Create one shell window bound to a workspace (or to the folder gate). */
async function openShellWindow(
  options: {
    workspacePath?: string;
    bounds?: PersistedWindowState;
    replacing?: BrowserWindow;
    appId?: string;
  } = {},
): Promise<BrowserWindow> {
  const replacing = options.replacing;
  const bounds =
    options.bounds ??
    (replacing && !replacing.isDestroyed()
      ? {
          ...replacing.getBounds(),
          isMaximized: replacing.isMaximized(),
        }
      : undefined);

  const win = await createShellWindow({
    workspacePath: options.workspacePath,
    bounds,
    appId: options.appId,
  });
  const baseUrl = await shellLoadUrl();
  const hash = options.appId ? `#/app/${options.appId}` : '';
  await win.loadURL(`${baseUrl}${hash}`);
  if (replacing && !replacing.isDestroyed()) {
    // Drop the old view only once its replacement is live, so the user never
    // sees the app with no window.
    shellWindows.unregister(replacing.id);
    replacing.destroy();
  }
  return win;
}

/**
 * The folder a cold boot should land in, read straight off `config.json`.
 *
 * Not via `importServerModule`: in dev the server is a separate process, so the
 * module imported here would be a fresh copy that never ran `initWorkspaceRoot()`
 * and would answer with the app cwd.
 */
function readPersistedDefaultWorkspace(): string {
  try {
    const raw = fs.readFileSync(path.join(minnowHomeDir(), 'config.json'), 'utf8');
    const meta = JSON.parse(raw) as { workspace?: { path?: unknown; userChosen?: unknown } };
    const saved = meta?.workspace?.path;
    if (typeof saved !== 'string' || !saved.trim()) return '';
    if (meta.workspace?.userChosen === false) return '';
    return path.resolve(saved.trim());
  } catch {
    return '';
  }
}

/**
 * Restore the previous window set, skipping folders that no longer exist. Falls
 * back to a single gate window.
 */
async function restoreShellWindows(): Promise<void> {
  const { windows } = await loadWindowSet();
  const fsPromises = await import('node:fs/promises');
  /** @type {PersistedWindowState[]} */
  const usable: PersistedWindowState[] = [];
  // A window the user parked in the tray is not reopened: restoring those is
  // what made every folder ever opened come back on the next launch.
  for (const entry of selectRestorableWindows(windows)) {
    const folder = entry.workspacePath?.trim() ?? '';
    if (!folder) {
      usable.push(entry);
      continue;
    }
    try {
      const stat = await fsPromises.stat(folder);
      if (stat.isDirectory()) usable.push(entry);
    } catch {
      // The folder was moved or deleted since last run — skip it silently.
    }
  }

  if (usable.length === 0) {
    await openShellWindow({ workspacePath: readPersistedDefaultWorkspace() });
    return;
  }

  // A v1 window-state file names no folder. Upgrading users should still boot
  // into their persisted workspace rather than being sent back to the gate.
  const soleUnbound = usable.length === 1 && !usable[0]!.workspacePath?.trim();
  if (soleUnbound) {
    await openShellWindow({
      workspacePath: readPersistedDefaultWorkspace(),
      bounds: usable[0],
    });
    return;
  }

  for (const entry of usable) {
    const folder = entry.workspacePath?.trim() ?? '';
    if (folder && shellWindows.findByWorkspace(folder)) continue;
    await openShellWindow({ workspacePath: folder, bounds: entry });
  }
}

function failBootstrap(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  crashLog.logCrash({
    source: 'main',
    kind: 'bootstrap-failed',
    message,
    stack,
  });
  crashLog.flushCrashLogSync();
  console.error('[electron] bootstrap failed:', err);
  dialog.showErrorBox(
    'Minnow failed to start',
    `${message}\n\nDetails may be in ~/.minnow/logs/crash.jsonl`,
  );
  app.exit(1);
}

// ── App lifecycle ────────────────────────────────────────────────────────────

// Must run before Electron ready; disableHardwareAcceleration is a no-op after that.
if (!readHardwareAccelerationSync()) app.disableHardwareAcceleration();

// App identity, also before ready so every path below resolves under the final
// name. Windows attributes toasts by AppUserModelID, and the first notification
// makes Electron write a per-user Start Menu shortcut to hang that ID on, named
// after the running exe's version resource. A dev run's exe is the bare Electron
// binary with no app path attached, so that shortcut opens Electron's own
// welcome screen — and while it was branded `Minnow` it landed as a per-user
// `Minnow` entry that shadows the installer's all-users one, quietly taking over
// the Start Menu for an installed build. `scripts/brand-electron-win.mjs` keeps
// the dev binary named `Minnow Dev`; the id is split here to match, so dev toasts
// never bind to the shipped app's shortcut either.
app.setName('Minnow');
if (process.platform === 'win32') {
  app.setAppUserModelId(app.isPackaged ? 'org.grimmedia.minnow' : 'org.grimmedia.minnow.dev');
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  crashReporter.start({ uploadToServer: false, compress: true });

  process.on('uncaughtException', (err) => {
    crashLog.logCrash({
      source: 'main',
      kind: 'uncaughtException',
      message: err?.message ?? String(err),
      stack: err?.stack,
    });
    crashLog.flushCrashLogSync();
    console.error('[electron] uncaughtException:', err);
  });

  process.on('unhandledRejection', (reason) => {
    const message =
      reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : String(reason);
    const stack = reason instanceof Error ? reason.stack : undefined;
    crashLog.logCrash({
      source: 'main',
      kind: 'unhandledRejection',
      message,
      stack,
    });
    console.error('[electron] unhandledRejection:', reason);
  });

  app.on('child-process-gone', (_event, details) => {
    crashLog.logCrash({
      source: 'child',
      kind: 'child-process-gone',
      reason: details.reason,
      exitCode: details.exitCode,
      message: `Child process gone: ${details.type}`,
      extra: {
        type: details.type,
        name: details.name,
        serviceName: details.serviceName,
      },
    });
    console.error('[electron] child-process-gone:', details);
  });

  // `minnow <path>` focuses that folder's window if it is open, else opens one.
  // This used to drop argv entirely and just focus whatever was in front.
  app.on('second-instance', (_event, argv) => {
    const folder = argv
      .slice(1)
      .find((arg) => typeof arg === 'string' && arg.trim() && !arg.startsWith('-'));
    if (folder) {
      void bootstrap()
        .then(() => openOrFocusWorkspaceWindow(path.resolve(folder.trim())))
        .catch(failBootstrap);
      return;
    }
    focusWindow();
  });

  app.whenReady().then(() => {
    bootstrap()
      .then(() => restoreShellWindows())
      .catch(failBootstrap);
  });

  app.on('window-all-closed', () => {
    if (process.platform === 'darwin') return;
    if (quitInProgress) {
      app.quit();
      return;
    }
    if (!shouldQuitOnWindowAllClosed(closeToTrayEnabled)) return;
    app.quit();
  });

  app.on('activate', () => {
    if (shellWindows.size === 0) {
      // Runtime init is memoized; window creation is not, so this really does
      // bring a window back after the last one was closed on macOS.
      bootstrap()
        .then(() => restoreShellWindows())
        .catch(failBootstrap);
    } else {
      focusWindow();
    }
  });

  app.on('before-quit', (event) => {
    if (quitInProgress) return;
    event.preventDefault();
    quitInProgress = true;
    setWindowStateQuitting(true);
    disposeUpdater();
    trayManager?.destroyTray();
    shutdownRuntime()
      .catch((err) => {
        console.error('[electron] shutdown error:', err);
      })
      .finally(() => {
        // app.exit skips the `quit` event electron-updater uses to run the
        // downloaded NSIS installer. A second app.quit() is a no-op loop
        // because quitInProgress is already true.
        app.quit();
      });
  });
}
