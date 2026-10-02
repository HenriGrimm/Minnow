/**
 * Companion authentication bootstrap and host-only management routes.
 */

import { buildNetworkUrls } from '../system/network.js';
import { resolveMinnowPort } from '../constants/minnow-port.js';
import { listDevices, revokeDevice } from './device-store.js';
import {
  createPairingChallenge,
  exchangePairingChallenge,
  PairingError,
} from './pairing.js';

const MAX_BODY_BYTES = 8 * 1024;

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
    return JSON.parse(body);
  } catch {
    throw new PairingError('Invalid JSON', 400, 'invalid_json');
  }
}

function requestPort(req) {
  if (Number.isInteger(req.socket?.localPort) && req.socket.localPort > 0) {
    return req.socket.localPort;
  }
  try {
    const parsed = new URL(`http://${req.headers.host ?? ''}`);
    const port = Number(parsed.port);
    if (port > 0) return port;
  } catch {
    /* Host validation already ran in the auth gate. */
  }
  return resolveMinnowPort();
}

function pairingUrls(req, code, urlBuilder) {
  const fragment = `#pair=${encodeURIComponent(code)}`;
  return urlBuilder(requestPort(req)).map((url) => `${url.endsWith('/') ? url : `${url}/`}${fragment}`);
}

function requireHost(req, res) {
  if (req.minnowAuth?.kind === 'host') return true;
  sendJson(res, 403, { error: 'Host session required' });
  return false;
}

/**
 * @param {{
 *   buildNetworkUrls?: typeof buildNetworkUrls,
 *   createPairingChallenge?: typeof createPairingChallenge,
 *   exchangePairingChallenge?: typeof exchangePairingChallenge,
 *   listDevices?: typeof listDevices,
 *   revokeDevice?: typeof revokeDevice,
 * }} [deps]
 */
export function createAuthRoutesMiddleware(deps = {}) {
  const urlBuilder = deps.buildNetworkUrls ?? buildNetworkUrls;
  const createChallenge = deps.createPairingChallenge ?? createPairingChallenge;
  const exchangeChallenge = deps.exchangePairingChallenge ?? exchangePairingChallenge;
  const getDevices = deps.listDevices ?? listDevices;
  const removeDevice = deps.revokeDevice ?? revokeDevice;

  return async function authRoutesMiddleware(req, res, next) {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    if (!pathname.startsWith('/api/auth')) {
      next();
      return;
    }

    try {
      if (pathname === '/api/auth/session' && req.method === 'GET') {
        sendJson(res, 200, { authenticated: true, kind: req.minnowAuth.kind });
        return;
      }

      if (pathname === '/api/auth/pair' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const result = exchangeChallenge({
          code: body.code,
          source: req.socket?.remoteAddress ?? 'unknown',
        });
        sendJson(res, 200, {
          token: result.token,
          device: result.device,
          pairedAt: result.pairedAt,
        });
        return;
      }

      if (pathname === '/api/auth/pairings' && req.method === 'POST') {
        if (!requireHost(req, res)) return;
        const body = await readJsonBody(req);
        const pairing = createChallenge(body.deviceName);
        sendJson(res, 201, {
          code: pairing.code,
          deviceName: pairing.deviceName,
          expiresAt: new Date(pairing.expiresAt).toISOString(),
          urls: pairingUrls(req, pairing.code, urlBuilder),
        });
        return;
      }

      if (pathname === '/api/auth/devices' && req.method === 'GET') {
        if (!requireHost(req, res)) return;
        sendJson(res, 200, { devices: getDevices() });
        return;
      }

      const revokeMatch = /^\/api\/auth\/devices\/([0-9a-f]{24})$/.exec(pathname);
      if (revokeMatch && req.method === 'DELETE') {
        if (!requireHost(req, res)) return;
        if (!removeDevice(revokeMatch[1])) {
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
      sendJson(res, 500, { error: 'Authentication storage failed' });
    }
  };
}
