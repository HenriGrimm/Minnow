import { getViewWorkspacePath } from '../state/view-workspace.ts';

declare global {
  interface Window {
    __MINNOW_SESSION_TOKEN__?: string;
  }
}

/** Where builds before the cookie-based pairing kept the device credential. */
const LEGACY_DEVICE_TOKEN_STORAGE_KEY = 'minnow.auth.deviceToken';

let pairedDevice = false;

/**
 * A paired phone or tablet authenticates with a server-set HttpOnly cookie, so
 * page scripts never hold its secret. This flag only records that boot
 * confirmed the pairing.
 */
export function setPairedDevice(paired: boolean): void {
  pairedDevice = paired;
}

/** Whether this page is a paired device (not the host desktop). */
export function isPairedDevice(): boolean {
  return pairedDevice && !hasHostSessionToken();
}

/**
 * Move a pairing saved by an older build (localStorage) into the HttpOnly
 * cookie. Keeps the old value through network failures, drops it once the host
 * accepts or rejects it.
 * @returns whether a legacy credential was adopted
 */
export async function migrateLegacyDeviceToken(): Promise<boolean> {
  if (typeof window === 'undefined' || hasHostSessionToken()) return false;
  let token = '';
  try {
    token = window.localStorage.getItem(LEGACY_DEVICE_TOKEN_STORAGE_KEY) ?? '';
  } catch {
    return false;
  }
  if (!token.startsWith('minnow_device_')) return false;
  let response: Response;
  try {
    response = await fetch('/api/auth/adopt', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'X-Minnow-Token': token },
    });
  } catch {
    return false;
  }
  if (response.ok || response.status === 401 || response.status === 403) {
    try { window.localStorage.removeItem(LEGACY_DEVICE_TOKEN_STORAGE_KEY); } catch {}
  }
  return response.ok;
}

/** Whether this page received the local host's per-boot credential. */
export function hasHostSessionToken(): boolean {
  return typeof window !== 'undefined' && Boolean(window.__MINNOW_SESSION_TOKEN__);
}

/** The host's per-boot token, or empty string (paired devices use their cookie). */
export function getSessionToken(): string {
  if (typeof window === 'undefined') return '';
  return window.__MINNOW_SESSION_TOKEN__ ?? '';
}

/**
 * Append `?token=`/`&token=` and, in a workspace-bound view, `&workspace=` to a
 * same-origin URL. This is the choke point for every `EventSource` and the
 * PTY/STT/TTS sockets — neither transport can set request headers, so the
 * workspace rides the query string there. Paired devices send their cookie.
 */
export function withSessionToken(url: string): string {
  const token = getSessionToken();
  const workspace = getViewWorkspacePath();
  let out = url;
  if (token) {
    const sep = out.includes('?') ? '&' : '?';
    out = `${out}${sep}token=${encodeURIComponent(token)}`;
  }
  if (workspace) {
    const sep = out.includes('?') ? '&' : '?';
    out = `${out}${sep}workspace=${encodeURIComponent(workspace)}`;
  }
  return out;
}

/**
 * Remove auth query params added by `withSessionToken`.
 *
 * Used when serializing issue attachment `<img>` / `<a>` elements back to
 * markdown so a display-only token never lands in persisted description text.
 */
export function stripSessionFromUrl(url: string): string {
  if (!url.includes('token=') && !url.includes('workspace=')) return url;
  try {
    const parsed = new URL(url, 'http://localhost');
    parsed.searchParams.delete('token');
    parsed.searchParams.delete('workspace');
    const query = parsed.searchParams.toString();
    return query ? `${parsed.pathname}?${query}` : parsed.pathname;
  } catch {
    return url;
  }
}
