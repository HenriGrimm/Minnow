import type { Session, WebContents } from 'electron';

export const MIN_PREVIEW_ZOOM_PERCENT = 25;
export const MAX_PREVIEW_ZOOM_PERCENT = 500;
export const PREVIEW_ZOOM_PRESET_PERCENTS = [
  25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500,
] as const;

export function clampPreviewZoomPercent(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 100;
  return Math.min(MAX_PREVIEW_ZOOM_PERCENT, Math.max(MIN_PREVIEW_ZOOM_PERCENT, Math.round(raw)));
}

export function previewZoomPercentFromFactor(factor: number): number {
  if (!Number.isFinite(factor) || factor <= 0) return 100;
  return clampPreviewZoomPercent(factor * 100);
}

export function nextPreviewZoomPercent(current: number, direction: 'in' | 'out'): number {
  const clamped = clampPreviewZoomPercent(current);
  if (direction === 'in') {
    return PREVIEW_ZOOM_PRESET_PERCENTS.find((value) => value > clamped) ?? MAX_PREVIEW_ZOOM_PERCENT;
  }
  return [...PREVIEW_ZOOM_PRESET_PERCENTS]
    .reverse()
    .find((value) => value < clamped) ?? MIN_PREVIEW_ZOOM_PERCENT;
}

export function getPreviewZoomPercent(contents: WebContents): number {
  if (contents.isDestroyed()) return 100;
  return previewZoomPercentFromFactor(contents.getZoomFactor());
}

export function setPreviewZoomPercent(contents: WebContents, percent: number): number {
  const next = clampPreviewZoomPercent(percent);
  if (!contents.isDestroyed()) contents.setZoomFactor(next / 100);
  return next;
}

export async function clearPreviewCookies(previewSession: Session): Promise<void> {
  await previewSession.clearStorageData({ storages: ['cookies'] });
}

export async function clearPreviewCache(previewSession: Session): Promise<void> {
  await previewSession.clearCache();
}
