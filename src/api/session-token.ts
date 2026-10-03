import { getViewWorkspacePath } from '../state/view-workspace.ts';

declare global {
  interface Window {
    __MINNOW_SESSION_TOKEN__?: string;
  }
}

const DEVICE_TOKEN_STORAGE_KEY = 'minnow.auth.deviceToken';
const DEVICE_TOKEN_COOKIE_NAME = 'minnow_device';
const DEVICE_TOKEN_COOKIE_MAX_AGE_SEC = 60 * 60 * 24 * 365;

function isValidDeviceToken(token: string): boolean {
  return token.startsWith('minnow_device_');
}

/** Parse the companion device cookie when localStorage is empty. */
function readDeviceTokenCookie(): string {
  if (typeof document === 'undefined') return '';
  const prefix = `${DEVICE_TOKEN_COOKIE_NAME}=`;
  try {
    for (const part of document.cookie.split(';')) {
      const trimmed = part.trim();
      if (!trimmed.startsWith(prefix)) continue;
      const value = decodeURIComponent(trimmed.slice(prefix.length));
      return isValidDeviceToken(value) ? value : '';
    }
  } catch {}
  return '';
}

/** Mirror the device token into a first-party cookie for cross-context hydration. */
function writeDeviceTokenCookie(token: string): void {
  if (typeof document === 'undefined') return;
  const secure = window.isSecureContext ? '; Secure' : '';
  document.cookie = [
    `${DEVICE_TOKEN_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${DEVICE_TOKEN_COOKIE_MAX_AGE_SEC}`,
    secure,
  ].join('; ');
}

/** Drop the mirrored cookie when the device credential is cleared. */
function clearDeviceTokenCookie(): void {
  if (typeof document === 'undefined') return;
  const secure = window.isSecureContext ? '; Secure' : '';
  document.cookie = [
    `${DEVICE_TOKEN_COOKIE_NAME}=`,
    'Path=/',
    'Max-Age=0',
    secure,
  ].join('; ');
}

/** Read the paired-device credential without throwing in private storage modes. */
export function getDeviceToken(): string {
  if (typeof window === 'undefined') return '';
  try {
    const stored = window.localStorage.getItem(DEVICE_TOKEN_STORAGE_KEY) ?? '';
    if (isValidDeviceToken(stored)) return stored;
  } catch {}
  const fromCookie = readDeviceTokenCookie();
  if (fromCookie) {
    try { window.localStorage.setItem(DEVICE_TOKEN_STORAGE_KEY, fromCookie); } catch {}
  }
  return fromCookie;
}

/** Persist the credential returned by a successful one-time pairing exchange. */
export function saveDeviceToken(token: string): void {
  if (typeof window === 'undefined' || !isValidDeviceToken(token)) {
    throw new Error('Invalid companion device token');
  }
  // Either first-party store can persist pairing when the other is restricted.
  try { window.localStorage.setItem(DEVICE_TOKEN_STORAGE_KEY, token); } catch {}
  try { writeDeviceTokenCookie(token); } catch {}
  if (getDeviceToken() !== token) throw new Error('Allow browser storage to remember this device');
}

/** Remove a revoked or rejected paired-device credential. */
export function clearDeviceToken(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(DEVICE_TOKEN_STORAGE_KEY);
  } catch {}
  try { clearDeviceTokenCookie(); } catch {}
}

/** Whether this page received the local host's per-boot credential. */
export function hasHostSessionToken(): boolean {
  return typeof window !== 'undefined' && Boolean(window.__MINNOW_SESSION_TOKEN__);
}

/** The host or paired-device token, or empty string when authentication is required. */
export function getSessionToken(): string {
  if (typeof window === 'undefined') return '';
  return window.__MINNOW_SESSION_TOKEN__ ?? getDeviceToken();
}

/**
 * Append `?token=`/`&token=` and, in a workspace-bound view, `&workspace=` to a
 * same-origin URL. This is the choke point for every `EventSource` and the
 * PTY/STT/TTS sockets — neither transport can set request headers, so the
 * workspace rides the query string there.
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
