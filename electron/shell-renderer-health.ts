import type { BrowserWindow } from 'electron';

const HANG_GRACE_MS = 15_000;

type HangEvent = 'unresponsive' | 'unresponsive-sustained' | 'responsive' | 'restart-unresponsive-renderer';

interface Hang {
  rendererPid: number;
  since: number;
  controller: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  sustained: boolean;
  offered: boolean;
  prompting: boolean;
}

/** A frozen renderer cannot paint a dialog or acknowledge a session save. */
export function wireShellRendererHealth(win: BrowserWindow, options: {
  isQuitting: () => boolean;
  confirmRestart: (signal: AbortSignal) => Promise<boolean>;
  record: (kind: HangEvent, details: { windowId: number; webContentsId: number; rendererPid: number; elapsedMs: number }) => void;
}): () => boolean {
  const contents = win.webContents;
  const windowId = win.id;
  const webContentsId = contents.id;
  let hang: Hang | undefined;

  function record(kind: HangEvent, current: Hang): void {
    options.record(kind, {
      windowId, webContentsId, rendererPid: current.rendererPid,
      elapsedMs: Math.round(performance.now() - current.since),
    });
  }

  function clearHang(): void {
    const current = hang;
    hang = undefined;
    clearTimeout(current?.timer);
    current?.controller.abort();
  }

  function canRecover(current: Hang): boolean {
    return hang === current && !options.isQuitting() && !win.isDestroyed() && !contents.isDestroyed()
      && contents.getOSProcessId() === current.rendererPid;
  }

  function offerRestart(manual = false): boolean {
    const current = hang;
    if (!current?.sustained || !canRecover(current) || !win.isVisible() || win.isMinimized()) return false;
    if (current.prompting || (current.offered && !manual)) return true;
    current.offered = true;
    current.prompting = true;
    void options.confirmRestart(current.controller.signal).then(restart => {
      if (!restart || !canRecover(current)) return;
      record('restart-unresponsive-renderer', current);
      // The existing render-process-gone handler reloads the window and bounds restart loops.
      contents.forcefullyCrashRenderer();
      return true;
    }).catch(error => {
      if (canRecover(current)) console.error('[electron] Could not show renderer recovery', error);
    }).then(restarting => { if (!restarting) current.prompting = false; });
    return true;
  }

  contents.on('unresponsive', () => {
    if (hang || options.isQuitting() || win.isDestroyed() || contents.isDestroyed()) return;
    const rendererPid = contents.getOSProcessId();
    if (rendererPid <= 0) return;
    const current: Hang = hang = {
      rendererPid, since: performance.now(), controller: new AbortController(), sustained: false, offered: false, prompting: false,
    };
    record('unresponsive', current);
    current.timer = setTimeout(() => {
      if (!canRecover(current)) return;
      current.sustained = true;
      record('unresponsive-sustained', current);
      offerRestart();
    }, HANG_GRACE_MS);
  });
  contents.on('responsive', () => {
    if (hang) record('responsive', hang);
    clearHang();
  });
  contents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) clearHang();
  });
  contents.on('render-process-gone', clearHang);
  contents.on('destroyed', clearHang);
  win.on('focus', () => { offerRestart(); });
  return () => offerRestart(true);
}
