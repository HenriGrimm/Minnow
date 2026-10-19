/**
 * Resolve who is making a request, for both the HTTP auth gate and every
 * WebSocket upgrade: ingress + Host validation, credential lookup (header,
 * query, or the device cookie), and same-origin enforcement for cookie auth.
 *
 * Cookies are scoped by host, not port, so a page served by another program on
 * the same IP (LM Studio on :1234, a dev server) would send Minnow's device
 * cookie too. Cookie-authenticated requests therefore must prove they come from
 * Minnow's own origin.
 */

import { checkIngressAccess } from '../network/access.js';
import { ingressScheme } from '../network/ingress.js';
import { readDeviceCookie } from '../auth/cookie.js';
import { touchDevice } from '../auth/device-store.js';
import { authenticateMinnowToken } from './authenticate-token.js';

const SAFE_METHODS = new Set(['GET', 'HEAD']);

/**
 * @param {import('http').IncomingMessage} req
 * @param {URL} url
 * @returns {{ token: string, source: 'header' | 'query' | 'cookie' | 'none' }}
 */
export function extractCredential(req, url) {
  const header = req.headers['x-minnow-token'];
  if (typeof header === 'string' && header) return { token: header, source: 'header' };
  const fromQuery = url.searchParams.get('token');
  if (fromQuery) return { token: fromQuery, source: 'query' };
  const fromCookie = readDeviceCookie(req);
  if (fromCookie) return { token: fromCookie, source: 'cookie' };
  return { token: '', source: 'none' };
}

/** The origin a same-site page served by this listener would send. */
export function expectedOrigin(req, ingress) {
  return `${ingressScheme(ingress)}://${String(req.headers.host ?? '').toLowerCase()}`;
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('../network/ingress.js').IngressKind} ingress
 * @param {{ upgrade?: boolean }} opts
 */
export function isSameOriginRequest(req, ingress, { upgrade = false } = {}) {
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin.toLowerCase() : '';
  const fetchSite = typeof req.headers['sec-fetch-site'] === 'string' ? req.headers['sec-fetch-site'] : '';
  const expected = expectedOrigin(req, ingress);
  if (origin && origin !== expected) return false;
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return false;
  // Browsers always send Origin on WebSocket handshakes and on non-GET fetches.
  if (upgrade || !SAFE_METHODS.has(req.method ?? 'GET')) return Boolean(origin) || fetchSite === 'same-origin';
  return true;
}

/**
 * @typedef {{ kind: 'host' } | { kind: 'device', deviceId: string, credentialId: string, deviceName: string } | { kind: 'mcp', workspace: string | null }} MinnowAuth
 * @typedef {{
 *   ok: true,
 *   auth: MinnowAuth,
 *   ingress: import('../network/ingress.js').IngressKind,
 *   source: 'header' | 'query' | 'cookie',
 *   token: string,
 * } | {
 *   ok: false,
 *   status: 401 | 403 | 503,
 *   error: string,
 *   ingress: import('../network/ingress.js').IngressKind,
 *   source: 'header' | 'query' | 'cookie' | 'none',
 *   token: string,
 * }} RequestAuthResult
 */

/**
 * @param {import('http').IncomingMessage} req
 * @param {URL} url
 * @param {{ upgrade?: boolean }} [opts]
 * @returns {RequestAuthResult}
 */
export function resolveRequestAuth(req, url, opts = {}) {
  const { ingress, allowed } = checkIngressAccess(req);
  const { token, source } = extractCredential(req, url);
  if (!allowed) return { ok: false, status: 403, error: 'Forbidden host', ingress, source, token };

  let auth;
  try {
    auth = authenticateMinnowToken(token, { throwOnStorageError: true, ingress });
  } catch {
    // A temporarily unreadable registry must deny access without telling a
    // companion to permanently discard its still-valid device credential.
    return { ok: false, status: 503, error: 'Authentication storage unavailable', ingress, source, token };
  }
  if (!auth || source === 'none') return { ok: false, status: 401, error: 'Unauthorized', ingress, source, token };

  if (source === 'cookie' && !isSameOriginRequest(req, ingress, opts)) {
    return { ok: false, status: 403, error: 'Cross-origin request', ingress, source, token };
  }
  if (auth.kind === 'device') touchDevice(auth.deviceId, auth.credentialId, ingress);
  return { ok: true, auth, ingress, source, token };
}

/**
 * WebSocket upgrade gate. Writes the refusal and returns null, or returns the
 * authenticated identity.
 * @param {import('http').IncomingMessage} req
 * @param {import('node:stream').Duplex} socket
 * @returns {RequestAuthResult & { ok: true } | null}
 */
export function authorizeUpgrade(req, socket) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const result = resolveRequestAuth(req, url, { upgrade: true });
  if (result.ok) return result;
  const line = result.status === 403 ? '403 Forbidden' : result.status === 503 ? '503 Service Unavailable' : '401 Unauthorized';
  socket.end(`HTTP/1.1 ${line}\r\nConnection: close\r\n\r\n`);
  return null;
}
