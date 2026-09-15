/**
 * Dedicated Electron app windows (rail "Open in new window").
 *
 * Availability matches `src/lib/open-workspace-windows.ts`: the browser build
 * has no `window.minnow.window` bridge, so callers hide the action instead of
 * offering a dead control.
 */

import { isDeveloperReleased } from './app-registry';
import type { AppId } from './types';

/** Code is the chat/session surface; a second window would 409-thrash sessions. */
const APP_WINDOW_EXCLUDED: ReadonlySet<AppId> = new Set(['code', 'home']);

/** Bound app id when this renderer booted as an app-only Electron window. */
export function getAppWindowId(): AppId | null {
  const raw = window.minnow?.viewContext?.appId?.trim() ?? '';
  return raw ? (raw as AppId) : null;
}

/** Whether this renderer should skip rail / workspace-gate chrome. */
export function isAppWindowRenderer(): boolean {
  return getAppWindowId() !== null;
}

/** True when the Electron bridge can open a dedicated app window. */
export function canOpenAppWindow(): boolean {
  return typeof window.minnow?.window?.openAppWindow === 'function';
}

/** Released rail apps except Code. */
export function isAppWindowEligible(appId: AppId): boolean {
  if (APP_WINDOW_EXCLUDED.has(appId)) return false;
  return isDeveloperReleased(appId);
}

/** Hash this window should boot (and stay) on. */
export function resolveAppWindowBootHash(appId: string): string {
  return `#/app/${appId}`;
}

/**
 * Stamp `data-app-window` and, when needed, the boot hash.
 * Returns the bound app id, or null when this is a normal shell window.
 */
export function applyAppWindowBoot(doc: Document = document): string | null {
  const appId = getAppWindowId();
  if (!appId) {
    delete doc.documentElement.dataset.appWindow;
    return null;
  }
  doc.documentElement.dataset.appWindow = appId;
  const next = resolveAppWindowBootHash(appId);
  const hash = window.location.hash;
  const staysOnApp = hash === next || hash.startsWith(`${next}/`);
  if (!staysOnApp) {
    window.location.replace(next);
  }
  return appId;
}

/** Whether `hash` still belongs to the bound app (including deep links). */
export function isHashInAppWindow(hash: string, appId: string): boolean {
  const prefix = resolveAppWindowBootHash(appId);
  return hash === prefix || hash.startsWith(`${prefix}/`) || hash.startsWith('#/wiki');
}

/** Menu label: open vs focus, depending on whether the window already exists. */
export function appWindowMenuLabel(alreadyOpen: boolean): string {
  return alreadyOpen ? 'Focus window' : 'Open in new window';
}

export async function hasOpenAppWindow(appId: string): Promise<boolean> {
  const query = window.minnow?.window?.hasAppWindow;
  if (!query) return false;
  try {
    const result = await query(appId);
    return result.open === true;
  } catch {
    return false;
  }
}

export async function openOrFocusAppWindow(
  appId: string,
): Promise<{ ok: true; focused: boolean } | { ok: false; error: string }> {
  const open = window.minnow?.window?.openAppWindow;
  if (!open) {
    return { ok: false, error: 'This build cannot open app windows' };
  }
  try {
    return await open(appId);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
