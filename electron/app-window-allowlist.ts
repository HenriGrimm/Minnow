/**
 * Apps that may occupy a dedicated Electron window.
 *
 * Kept Electron-free so main-process validation can be unit-tested. Code is
 * excluded because that window *is* the chat/session surface; two views on
 * `sessions.db` would 409-thrash.
 *
 * Must cover every app the rail offers "Open in new window" for
 * (`isAppWindowEligible` in src/os/app-window.ts); the test enforces it.
 */

export const APP_WINDOW_ALLOWED_IDS = [
  'source-control',
  'research',
  'models',
  'brain',
  'scheduler',
  'issues',
  'settings',
] as const;

const ALLOWED = new Set<string>(APP_WINDOW_ALLOWED_IDS);

/** True when `appId` may open (or focus) a dedicated app window. */
export function isAppWindowAllowed(appId: unknown): appId is string {
  return typeof appId === 'string' && ALLOWED.has(appId);
}

/** Plain English rejection for IPC callers. */
export function appWindowDenialReason(appId: unknown): string {
  if (typeof appId !== 'string' || !appId.trim()) {
    return 'appId is required';
  }
  if (appId === 'code') {
    return 'Code cannot open in a separate window';
  }
  if (!ALLOWED.has(appId)) {
    return `Unknown or hidden app: ${appId}`;
  }
  return '';
}
