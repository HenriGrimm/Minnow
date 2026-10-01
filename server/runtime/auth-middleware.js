/**
 * Central auth gate for every /api/* request: Host validation (anti DNS
 * rebinding), per-boot session token check, and the sole remaining OPTIONS
 * handling. Inserted first in applyMinnowMiddlewares so no downstream route
 * handler ever runs for an unauthenticated or cross-host request. No CORS
 * header is ever emitted — same-origin requests don't need one, and cross-
 * origin requests are rejected before reaching here in spirit (they still
 * hit this middleware, but fail the token check and get no readable body
 * thanks to the browser's same-origin policy on the missing header).
 */

import { authenticateMinnowToken } from './authenticate-token.js';
import { authenticateMcpToken } from '../auth/mcp-store.js';
import { extractWorkspace } from './workspace-scope-middleware.js';
import {
  getNetworkAccess,
  isClientAllowed,
  isHostAllowed,
} from '../network/access.js';

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {URL} url
 * @returns {string}
 */
function extractToken(req, url) {
  const header = req.headers['x-minnow-token'];
  if (typeof header === 'string' && header) return header;
  const fromQuery = url.searchParams.get('token');
  return fromQuery ?? '';
}

/**
 * POST /api/auth/pair is the only unauthenticated API path, and only on LAN from a private peer.
 * @returns {import('connect').HandleFunction}
 */
export function createAuthMiddleware() {
  return function minnowAuthMiddleware(req, res, next) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (!url.pathname.startsWith('/api/')) {
      next();
      return;
    }

    if (!isHostAllowed(req.headers.host ?? '', getNetworkAccess())) {
      sendJson(res, 403, { error: 'Forbidden host' });
      return;
    }

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    if (url.pathname === '/api/auth/pair' && req.method === 'POST') {
      if (getNetworkAccess() !== 'lan' || !isClientAllowed(req, getNetworkAccess())) {
        sendJson(res, 403, { error: 'LAN pairing only' });
        return;
      }
      next();
      return;
    }

    const token = extractToken(req, url);
    let auth = authenticateMinnowToken(token);
    // MCP capabilities are deliberately absent from the global HTTP/WS authenticator.
    if (!auth && url.pathname === '/api/mcp/hub') {
      try { auth = authenticateMcpToken(token, extractWorkspace(req, url)); } catch { /* fail closed */ }
    }
    if (!auth) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return;
    }

    req.minnowAuth = auth;
    next();
  };
}
