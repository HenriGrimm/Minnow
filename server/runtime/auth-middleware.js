/**
 * Central auth gate for every /api/* request: ingress + Host validation (anti
 * DNS rebinding), credential check (host per-boot token on the loopback desktop
 * listener, or a paired device's cookie/token), same-origin enforcement for
 * cookie auth, and the sole remaining OPTIONS handling. Inserted first in
 * applyMinnowMiddlewares so no downstream route handler ever runs for an
 * unauthenticated or cross-host request. No CORS header is ever emitted.
 */

import { authenticateMcpToken } from '../auth/mcp-store.js';
import { clearDeviceCookie, setDeviceCookie, shouldRefreshDeviceCookie } from '../auth/cookie.js';
import { checkIngressAccess } from '../network/access.js';
import { getRequestIngress, ingressScheme } from '../network/ingress.js';
import { extractWorkspace } from './workspace-scope-middleware.js';
import { resolveRequestAuth } from './request-auth.js';

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

/**
 * The only API operations a not-yet-paired device may call. Each is throttled
 * and validated by its own handler in server/auth/routes.js.
 * @param {string} method
 * @param {string} pathname
 */
export function isPairingBootstrapRoute(method, pathname) {
  if (method === 'POST' && (pathname === '/api/auth/claim' || pathname === '/api/auth/requests')) return true;
  if (method !== 'GET') return false;
  return (
    pathname === '/api/auth/host-info' ||
    pathname === '/api/auth/manifest' ||
    /^\/api\/auth\/requests\/[0-9a-f]{24}$/.test(pathname)
  );
}

/**
 * Hardening headers for pages served to remote ingress. The tailnet address is
 * reachable from the internet when Funnel is on.
 * @returns {import('connect').NextHandleFunction}
 */
export function createRemoteResponseHeadersMiddleware() {
  return function remoteResponseHeaders(req, res, next) {
    const ingress = getRequestIngress(req);
    if (ingress !== 'loopback') {
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (ingressScheme(ingress) === 'https') {
        res.setHeader('Strict-Transport-Security', 'max-age=31536000');
      }
    }
    next();
  };
}

/** @returns {import('connect').HandleFunction} */
export function createAuthMiddleware() {
  return function minnowAuthMiddleware(req, res, next) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (!url.pathname.startsWith('/api/')) {
      next();
      return;
    }

    if (req.method === 'OPTIONS') {
      if (!checkIngressAccess(req).allowed) {
        sendJson(res, 403, { error: 'Forbidden host' });
        return;
      }
      res.statusCode = 204;
      res.end();
      return;
    }

    const result = resolveRequestAuth(req, url);
    const secure = ingressScheme(result.ingress) === 'https';

    if (isPairingBootstrapRoute(req.method ?? 'GET', url.pathname)) {
      if (result.ok) {
        req.minnowAuth = result.auth;
      } else if (result.status === 403 && result.error === 'Forbidden host') {
        sendJson(res, 403, { error: 'Forbidden host' });
        return;
      }
      req.minnowIngress = result.ingress;
      next();
      return;
    }

    if (!result.ok && result.status !== 401) {
      if (result.status === 503) res.setHeader('Retry-After', '5');
      sendJson(res, result.status, { error: result.error });
      return;
    }

    let auth = result.ok ? result.auth : null;
    // MCP capabilities are deliberately absent from the global HTTP/WS authenticator.
    if (!auth && url.pathname === '/api/mcp/hub' && result.ingress === 'loopback') {
      try { auth = authenticateMcpToken(result.token, extractWorkspace(req, url)); } catch { /* fail closed */ }
    }
    if (!auth) {
      if (result.source === 'cookie') clearDeviceCookie(res, { secure });
      res.setHeader('X-Minnow-Auth', 'required');
      res.setHeader('Cache-Control', 'no-store');
      sendJson(res, 401, { error: 'Unauthorized' });
      return;
    }

    if (
      result.ok &&
      result.source === 'cookie' &&
      auth.kind === 'device' &&
      shouldRefreshDeviceCookie(auth.credentialId)
    ) {
      setDeviceCookie(res, result.token, { secure, credentialId: auth.credentialId });
    }

    req.minnowAuth = auth;
    req.minnowIngress = result.ingress;
    next();
  };
}
