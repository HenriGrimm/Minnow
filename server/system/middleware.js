/**
 * System probes — VRAM and related machine metrics.
 */

import { resolveMinnowPort } from '../constants/minnow-port.js';
import { probeVram } from './vram.js';
import { detectHardware } from './hardware.js';
import { listDeadHosts } from '../generations/host-cooldown.js';
import { getNetworkStatus } from './network.js';

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string} pathname
 * @returns {Promise<boolean>}
 */
export async function handleSystemRequest(req, res, pathname) {

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return true;
  }

  if (pathname === '/api/system/vram' && req.method === 'GET') {
    const payload = await probeVram();
    sendJson(res, 200, payload);
    return true;
  }

  if (pathname === '/api/system/hardware' && req.method === 'GET') {
    const parsed = new URL(req.url ?? '/', 'http://127.0.0.1');
    const fresh = parsed.searchParams.get('fresh') === '1';
    const payload = await detectHardware({ fresh });
    sendJson(res, 200, payload);
    return true;
  }

  if (pathname === '/api/system/host-health' && req.method === 'GET') {
    sendJson(res, 200, { hosts: listDeadHosts() });
    return true;
  }

  if (pathname === '/api/system/network' && req.method === 'GET') {
    const parsed = new URL(req.url ?? '/', 'http://127.0.0.1');
    const port = req.socket?.localPort || Number(parsed.searchParams.get('port')) || resolveMinnowPort();
    const localUrl = parsed.searchParams.get('localUrl') ?? undefined;
    const payload = await getNetworkStatus({ port, localUrl: localUrl ?? undefined });
    sendJson(res, 200, payload);
    return true;
  }

  if (pathname.startsWith('/api/system')) {
    sendJson(res, 404, { error: 'Not found' });
    return true;
  }

  return false;
}

/** Vite connect middleware factory. */
export function createSystemMiddleware() {
  return async (req, res, next) => {
    const rawUrl = req.url ?? '/';
    const parsed = new URL(rawUrl, 'http://127.0.0.1');
    if (!parsed.pathname.startsWith('/api/system')) {
      next();
      return;
    }
    const handled = await handleSystemRequest(req, res, parsed.pathname);
    if (!handled) {
      next();
    }
  };
}
