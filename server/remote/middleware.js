/**
 * /api/remote/* — remote-access status and toggles. Writes are host-only; a
 * paired device may read the addresses it could move to.
 */

import {
  getRemoteStatus,
  logoutAnywhere,
  setAnywhereEnabled,
  setLanEnabled,
} from './ingress-manager.js';

const MAX_BODY_BYTES = 4 * 1024;

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_BODY_BYTES) return null;
  }
  if (!body) return {};
  try {
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** What a paired device may know: where else it could reach this host. */
function deviceView(status) {
  return {
    lanUrl: status.lan.urls[0] ?? null,
    anywhereUrl: status.anywhere.state === 'ready' ? status.anywhere.url ?? null : null,
  };
}

/** @returns {import('connect').NextHandleFunction} */
export function createRemoteMiddleware() {
  return async function remoteMiddleware(req, res, next) {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    if (!pathname.startsWith('/api/remote/')) {
      next();
      return;
    }
    const method = req.method ?? 'GET';
    const auth = req.minnowAuth;
    try {
      if (pathname === '/api/remote/status' && method === 'GET') {
        const status = getRemoteStatus();
        sendJson(res, 200, auth?.kind === 'host' ? status : deviceView(status));
        return;
      }

      if (auth?.kind !== 'host') {
        sendJson(res, 403, { error: 'Host session required' });
        return;
      }

      if (pathname === '/api/remote/lan' && method === 'POST') {
        const body = await readJsonBody(req);
        if (!body || typeof body.enabled !== 'boolean') {
          sendJson(res, 400, { error: 'Send { "enabled": true | false }' });
          return;
        }
        sendJson(res, 200, await setLanEnabled(body.enabled));
        return;
      }

      if (pathname === '/api/remote/anywhere' && method === 'POST') {
        const body = await readJsonBody(req);
        if (!body || typeof body.enabled !== 'boolean' || (body.funnel !== undefined && typeof body.funnel !== 'boolean')) {
          sendJson(res, 400, { error: 'Send { "enabled": boolean, "funnel"?: boolean }' });
          return;
        }
        sendJson(res, 200, await setAnywhereEnabled(body.enabled, { funnel: body.funnel }));
        return;
      }

      if (pathname === '/api/remote/anywhere/logout' && method === 'POST') {
        sendJson(res, 200, await logoutAnywhere());
        return;
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : 'Remote access failed' });
    }
  };
}
