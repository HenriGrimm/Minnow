/**
 * The paired device's credential lives in a server-set HttpOnly cookie. Safari
 * deletes script-written storage after seven days without use and caps
 * script-written cookies; a server-set cookie survives, and page scripts never
 * see the secret.
 */

export const DEVICE_COOKIE = 'minnow_device';
/** Chromium caps cookie lifetime at 400 days. */
const MAX_AGE_SEC = 400 * 24 * 60 * 60;
/** Re-issue at most daily so an active device never reaches expiry. */
export const COOKIE_REFRESH_MS = 24 * 60 * 60 * 1000;

/** @type {Map<string, number>} credentialId → last refresh time */
const lastRefresh = new Map();

function appendSetCookie(res, value) {
  const existing = res.getHeader?.('Set-Cookie');
  if (!existing) {
    res.setHeader('Set-Cookie', value);
    return;
  }
  res.setHeader('Set-Cookie', [...(Array.isArray(existing) ? existing : [String(existing)]), value]);
}

/**
 * @param {import('http').ServerResponse} res
 * @param {string} token
 * @param {{ secure?: boolean, credentialId?: string, now?: () => number }} [opts]
 */
export function setDeviceCookie(res, token, opts = {}) {
  const parts = [
    `${DEVICE_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${MAX_AGE_SEC}`,
  ];
  if (opts.secure) parts.push('Secure');
  appendSetCookie(res, parts.join('; '));
  if (opts.credentialId) lastRefresh.set(opts.credentialId, (opts.now ?? Date.now)());
}

/**
 * @param {import('http').ServerResponse} res
 * @param {{ secure?: boolean }} [opts]
 */
export function clearDeviceCookie(res, opts = {}) {
  const parts = [`${DEVICE_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (opts.secure) parts.push('Secure');
  appendSetCookie(res, parts.join('; '));
}

/**
 * @param {import('http').IncomingMessage} req
 * @returns {string}
 */
export function readDeviceCookie(req) {
  const header = req.headers?.cookie;
  if (typeof header !== 'string' || !header) return '';
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    if (!trimmed.startsWith(`${DEVICE_COOKIE}=`)) continue;
    try {
      const value = decodeURIComponent(trimmed.slice(DEVICE_COOKIE.length + 1));
      if (value.startsWith('minnow_device_')) return value;
    } catch {
      /* Malformed escape — treat as absent. */
    }
  }
  return '';
}

/**
 * Whether a cookie-authenticated response should re-issue the cookie. The first
 * request after a restart refreshes too, which also upgrades a legacy
 * script-written cookie to HttpOnly.
 * @param {string} credentialId
 * @param {{ now?: () => number }} [deps]
 */
export function shouldRefreshDeviceCookie(credentialId, deps = {}) {
  const at = lastRefresh.get(credentialId);
  return at === undefined || (deps.now ?? Date.now)() - at >= COOKIE_REFRESH_MS;
}

/** Reset refresh bookkeeping (tests only). */
export function resetDeviceCookieState() {
  lastRefresh.clear();
}
