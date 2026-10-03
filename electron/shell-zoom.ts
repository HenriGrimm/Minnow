import type { BrowserWindow, WebContents } from 'electron';

export const DEFAULT_SHELL_ZOOM_PERCENT = 100;

export const MIN_SHELL_ZOOM_PERCENT = 50;
export const MAX_SHELL_ZOOM_PERCENT = 300;

export const SHELL_ZOOM_PRESET_PERCENTS = [50, 67, 75, 80, 90, 100, 110, 125, 150, 200] as const;

let applyingShellZoom = false;

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
