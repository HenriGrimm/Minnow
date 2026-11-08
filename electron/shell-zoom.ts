import type { BrowserWindow, WebContents } from 'electron';

export const DEFAULT_SHELL_ZOOM_PERCENT = 100;

export const MIN_SHELL_ZOOM_PERCENT = 50;
export const MAX_SHELL_ZOOM_PERCENT = 300;

export const SHELL_ZOOM_PRESET_PERCENTS = [50, 67, 75, 80, 90, 100, 110, 125, 150, 200] as const;

let applyingShellZoom = false;
let afterShellZoomApplied: ((contents: WebContents, factor: number) => void) | null = null;

/** Height of the renderer menubar (`--os-menubar-h`) in CSS px. */
const MENUBAR_HEIGHT_CSS_PX = 46;
/** The native button frame is 16pt tall; its center sits 8pt below `y`. */
const TRAFFIC_LIGHT_HALF_HEIGHT_PT = 8;
/** Close-button inset from the window edge, in screen points (centers it over the Code rail at 100%). */
const TRAFFIC_LIGHT_X_PT = 17;

/**
 * macOS traffic-light position for a given shell zoom. Native buttons live in
 * screen points while the menubar scales with zoom, so `y` follows the bar's
 * zoomed center. The renderer clears them with `--mn-mac-traffic-lights-end`
 * divided by the same zoom (minnowos-tokens.css).
 */
export function macTrafficLightPosition(zoomFactor: number): { x: number; y: number } {
  const zoom = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
  const y = Math.round((MENUBAR_HEIGHT_CSS_PX * zoom) / 2 - TRAFFIC_LIGHT_HALF_HEIGHT_PT);
  return { x: TRAFFIC_LIGHT_X_PT, y: Math.max(0, y) };
}

/** Run after every shell zoom change (e.g. to re-center the macOS traffic lights). */
export function onShellZoomApplied(fn: ((contents: WebContents, factor: number) => void) | null): void {
  afterShellZoomApplied = fn;
}

export function clampShellZoomPercent(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return DEFAULT_SHELL_ZOOM_PERCENT;
  }
  const rounded = Math.round(raw);
  return Math.min(MAX_SHELL_ZOOM_PERCENT, Math.max(MIN_SHELL_ZOOM_PERCENT, rounded));
}

export function shellZoomFactorFromPercent(percent: number): number {
  return clampShellZoomPercent(percent) / 100;
}

export function shellZoomPercentFromFactor(factor: number): number {
  if (!Number.isFinite(factor) || factor <= 0) {
    return DEFAULT_SHELL_ZOOM_PERCENT;
  }
  return clampShellZoomPercent(Math.round(factor * 100));
}

export function nextShellZoomPercent(current: number, direction: 'in' | 'out'): number {
  const clamped = clampShellZoomPercent(current);
  if (direction === 'in') {
    return SHELL_ZOOM_PRESET_PERCENTS.find((p) => p > clamped) ?? MAX_SHELL_ZOOM_PERCENT;
  }
  return [...SHELL_ZOOM_PRESET_PERCENTS].reverse().find((p) => p < clamped) ?? MIN_SHELL_ZOOM_PERCENT;
}

export function isApplyingShellZoom(): boolean {
  return applyingShellZoom;
}

export function applyShellZoom(contents: WebContents, percent: number): void {
  if (contents.isDestroyed()) return;
  applyingShellZoom = true;
  try {
    contents.setZoomFactor(shellZoomFactorFromPercent(percent));
  } finally {
    applyingShellZoom = false;
  }
  afterShellZoomApplied?.(contents, shellZoomFactorFromPercent(percent));
}

export type ShellZoomWireDeps = {
  readPercent: () => Promise<number>;
  writePercent: (percent: number) => Promise<number>;
  notifyPercentChanged: (percent: number) => void;
};

export function wireShellZoom(win: BrowserWindow, deps: ShellZoomWireDeps): void {
  const contents = win.webContents;

  const applyConfigured = (): void => {
    void deps.readPercent().then((percent) => {
      applyShellZoom(contents, percent);
    });
  };

  applyConfigured();
  contents.on('did-finish-load', applyConfigured);

  contents.on('zoom-changed', (_event, zoomDirection) => {
    if (applyingShellZoom || contents.isDestroyed()) return;
    if (zoomDirection !== 'in' && zoomDirection !== 'out') return;
    const current = shellZoomPercentFromFactor(contents.getZoomFactor());
    const next = nextShellZoomPercent(current, zoomDirection);
    if (next === current) return;
    applyShellZoom(contents, next);
    void deps.writePercent(next).then((saved) => {
      deps.notifyPercentChanged(saved);
    });
  });
}
