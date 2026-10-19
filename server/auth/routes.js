/**
 * Device connection routes. Unauthenticated bootstrap (host-info, claim,
 * access requests, manifest) is allowlisted by the auth gate; device and
 * host-only routes check `req.minnowAuth` here.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getAppRoot } from '../workspace/root.js';
import { getRequestClientAddress, getRequestIngress, ingressScheme } from '../network/ingress.js';
import { getConnectTargets, getRemoteStatus } from '../remote/ingress-manager.js';
import { getHostDisplayName } from '../remote/host-name.js';
import { setDeviceCookie } from './cookie.js';
import { getDevice, listDevices, renameDevice, revokeDevice } from './device-store.js';
import { createHandoffTicket, peekHandoffTicket } from './handoff.js';
import {
  claimConnectSession,
  createConnectSession,
  getConnectSession,
  isPairingWindowOpen,
  PairingError,
} from './pairing.js';
import {
  approveAccessRequest,
  createAccessRequest,
  denyAccessRequest,
  listAccessRequests,
  pollAccessRequest,
} from './requests.js';

const MAX_BODY_BYTES = 8 * 1024;
const DEVICE_ID = '([0-9a-f]{24})';

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
    if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
      throw new PairingError('Request body too large', 413, 'body_too_large');
    }
  }
  if (!body) return {};
  try {
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    throw new PairingError('Invalid JSON', 400, 'invalid_json');
  }
}

function requireHost(req, res) {
  if (req.minnowAuth?.kind === 'host') return true;
  sendJson(res, 403, { error: 'Host session required' });
  return false;
}

function requireDevice(req, res) {
  if (req.minnowAuth?.kind === 'device') return true;
  sendJson(res, 403, { error: 'Paired device required' });
  return false;
}

function requestOrigin(req) {
  return `${ingressScheme(getRequestIngress(req))}://${String(req.headers.host ?? '')}`;
}

function clientContext(req) {
  return {
    ingress: getRequestIngress(req),
    origin: requestOrigin(req),
    source: getRequestClientAddress(req),
    userAgent: req.headers['user-agent'],
  };
}

function isSecure(req) {
  return ingressScheme(getRequestIngress(req)) === 'https';
}

let staticManifest = null;

function readStaticManifest() {
  if (staticManifest) return staticManifest;
  // Packaged builds serve dist/ (Vite copies public/ there); a checkout has public/.
  for (const dir of ['dist', 'public']) {
    try {
      staticManifest = JSON.parse(fs.readFileSync(path.join(getAppRoot(), dir, 'manifest.json'), 'utf8'));
      return staticManifest;
    } catch {
      /* try the next location */
    }
  }
  staticManifest = { name: 'Minnow', short_name: 'Minnow', id: '/', scope: '/', start_url: '/', display: 'standalone' };
  return staticManifest;
}

/**
 * Web app manifest. A valid handoff ticket goes into start_url so a Home Screen
 * app — which iOS gives an empty cookie jar — signs itself in on first launch.
 * The ticket is only peeked here; the navigation consumes it.
 * @param {URL} url
 */
function buildManifest(url) {
  const base = readStaticManifest();
  const ticket = url.searchParams.get('handoff');
  const valid = ticket && peekHandoffTicket(ticket)?.purpose === 'install';
  const icons = (Array.isArray(base.icons) ? base.icons : []).map((icon) => ({
    ...icon,
    src: String(icon.src ?? '').startsWith('/') ? icon.src : `/${icon.src}`,
  }));
  return {
    ...base,
    id: '/',
    scope: '/',
    icons,
    start_url: valid ? `/?handoff=${encodeURIComponent(ticket)}` : '/',
  };
}

function connectUrl(baseUrl, ticket) {
  return `${baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`}connect#t=${ticket}`;
}

/**
 * @param {{
 *   getConnectTargets?: typeof getConnectTargets,
 *   getHostDisplayName?: typeof getHostDisplayName,
 * }} [deps]
 */
export function createAuthRoutesMiddleware(deps = {}) {
  const connectTargets = deps.getConnectTargets ?? getConnectTargets;
  const hostName = deps.getHostDisplayName ?? getHostDisplayName;

  return async function authRoutesMiddleware(req, res, next) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const { pathname } = url;
    if (!pathname.startsWith('/api/auth')) {
      next();
      return;
    }
    const method = req.method ?? 'GET';

    try {
      // ── Unauthenticated bootstrap ───────────────────────────────────────
      if (pathname === '/api/auth/host-info' && method === 'GET') {
        const ingress = getRequestIngress(req);
        const open = isPairingWindowOpen();
        // The public tailnet address is in Certificate Transparency logs; only
        // name the computer while the owner is actively connecting a device.
        const name = ingress === 'funnel' && !open && req.minnowAuth?.kind !== 'device' ? 'Minnow' : hostName();
        sendJson(res, 200, {
          hostName: name,
          ingress,
          codeEntry: ingress === 'lan',
          requestsOpen: ingress !== 'funnel' || open,
          paired: req.minnowAuth?.kind === 'device',
        });
        return;
      }

      if (pathname === '/api/auth/manifest' && method === 'GET') {
        res.statusCode = 200;
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('Content-Type', 'application/manifest+json');
        res.setHeader('Cache-Control', 'private, no-store');
        res.end(JSON.stringify(buildManifest(url)));
        return;
      }

      if (pathname === '/api/auth/claim' && method === 'POST') {
        const body = await readJsonBody(req);
        const result = claimConnectSession({
          ticket: body.ticket,
          code: body.code,
          name: body.name,
          installed: body.installed === true,
          ...clientContext(req),
        });
        setDeviceCookie(res, result.token, { secure: isSecure(req), credentialId: result.credentialId });
        sendJson(res, 200, { device: result.device });
        return;
      }

      if (pathname === '/api/auth/requests' && method === 'POST') {
        const body = await readJsonBody(req);
        const created = createAccessRequest({
          name: body.name,
          installed: body.installed === true,
          ...clientContext(req),
        });
        sendJson(res, 201, {
          id: created.id,
          secret: created.secret,
          verifyCode: created.verifyCode,
          expiresAt: new Date(created.expiresAt).toISOString(),
        });
        return;
      }

      const pollMatch = new RegExp(`^/api/auth/requests/${DEVICE_ID}$`).exec(pathname);
      if (pollMatch && method === 'GET') {
        const result = pollAccessRequest(pollMatch[1], req.headers['x-minnow-request-secret']);
        if (result.status === 'approved' && 'token' in result && result.token) {
          setDeviceCookie(res, result.token, { secure: isSecure(req), credentialId: result.credentialId ?? undefined });
          sendJson(res, 200, { status: 'approved', device: result.device });
          return;
        }
        sendJson(res, 200, {
          status: result.status,
          ...('expiresAt' in result && result.expiresAt ? { expiresAt: new Date(result.expiresAt).toISOString() } : {}),
        });
        return;
      }

      // ── Any authenticated caller ────────────────────────────────────────
      if (pathname === '/api/auth/session' && method === 'GET') {
        const auth = req.minnowAuth;
        const device = auth?.kind === 'device' ? getDevice(auth.deviceId) : null;
        sendJson(res, 200, {
          authenticated: true,
          kind: auth?.kind,
          ...(device ? { device: { id: device.id, name: device.name }, hostName: hostName() } : {}),
        });
        return;
      }

      // ── Paired device ───────────────────────────────────────────────────
      if (pathname === '/api/auth/adopt' && method === 'POST') {
        if (!requireDevice(req, res)) return;
        // A pairing saved by an older build in localStorage arrives as a header;
        // move it into the HttpOnly cookie so scripts never need it again.
        const token = req.headers['x-minnow-token'];
        if (typeof token !== 'string' || !token) {
          sendJson(res, 400, { error: 'Send the saved credential in X-Minnow-Token' });
          return;
        }
        setDeviceCookie(res, token, { secure: isSecure(req), credentialId: req.minnowAuth.credentialId });
        sendJson(res, 200, { adopted: true });
        return;
      }

      if (pathname === '/api/auth/handoff' && method === 'POST') {
        if (!requireDevice(req, res)) return;
        const body = await readJsonBody(req);
        const ticket = createHandoffTicket(req.minnowAuth.deviceId, { purpose: body.purpose === 'move' ? 'move' : 'install' });
        sendJson(res, 201, {
          ticket: ticket.ticket,
          purpose: ticket.purpose,
          expiresAt: new Date(ticket.expiresAt).toISOString(),
        });
        return;
      }

      // ── Host only ───────────────────────────────────────────────────────
      if (pathname === '/api/auth/connect-sessions' && method === 'POST') {
        if (!requireHost(req, res)) return;
        const targets = connectTargets();
        if (targets.length === 0) {
          sendJson(res, 409, { error: 'Turn on home network or Anywhere access first', code: 'no_remote_access' });
          return;
        }
        const session = createConnectSession();
        const hasLan = targets.some((target) => target.kind === 'lan');
        sendJson(res, 201, {
          id: session.id,
          expiresAt: new Date(session.expiresAt).toISOString(),
          ...(hasLan ? { code: session.code } : {}),
          targets: targets.map((target) => ({ kind: target.kind, url: connectUrl(target.url, session.ticket), baseUrl: target.url })),
        });
        return;
      }

      const sessionMatch = new RegExp(`^/api/auth/connect-sessions/${DEVICE_ID}$`).exec(pathname);
      if (sessionMatch && method === 'GET') {
        if (!requireHost(req, res)) return;
        const session = getConnectSession(sessionMatch[1]);
        sendJson(res, 200, {
          ...session,
          ...('expiresAt' in session && session.expiresAt ? { expiresAt: new Date(session.expiresAt).toISOString() } : {}),
        });
        return;
      }

      if (pathname === '/api/auth/requests' && method === 'GET') {
        if (!requireHost(req, res)) return;
        sendJson(res, 200, { requests: listAccessRequests() });
        return;
      }

      const answerMatch = new RegExp(`^/api/auth/requests/${DEVICE_ID}/(approve|deny)$`).exec(pathname);
      if (answerMatch && method === 'POST') {
        if (!requireHost(req, res)) return;
        const body = await readJsonBody(req);
        if (answerMatch[2] === 'approve') {
          const result = approveAccessRequest(answerMatch[1], {
            attachToDeviceId: body.attachToDeviceId,
            name: body.name,
          });
          sendJson(res, 200, { approved: true, device: result.device });
        } else {
          denyAccessRequest(answerMatch[1]);
          sendJson(res, 200, { denied: true });
        }
        return;
      }

      if (pathname === '/api/auth/devices' && method === 'GET') {
        if (!requireHost(req, res)) return;
        sendJson(res, 200, { devices: listDevices(), remote: getRemoteStatus() });
        return;
      }

      const deviceMatch = new RegExp(`^/api/auth/devices/${DEVICE_ID}$`).exec(pathname);
      if (deviceMatch && method === 'PATCH') {
        if (!requireHost(req, res)) return;
        const body = await readJsonBody(req);
        const renamed = renameDevice(deviceMatch[1], body.name);
        if (!renamed) {
          sendJson(res, 404, { error: 'Device not found' });
          return;
        }
        sendJson(res, 200, { device: renamed });
        return;
      }

      if (deviceMatch && method === 'DELETE') {
        if (!requireHost(req, res)) return;
        if (!revokeDevice(deviceMatch[1])) {
          sendJson(res, 404, { error: 'Device not found' });
          return;
        }
        sendJson(res, 200, { revoked: true });
        return;
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      if (err instanceof PairingError) {
        sendJson(res, err.statusCode, { error: err.message, code: err.code });
        return;
      }
      if (err instanceof TypeError) {
        sendJson(res, 400, { error: err.message });
        return;
      }
      sendJson(res, 500, { error: 'Authentication storage failed' });
    }
  };
}
