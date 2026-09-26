import { URL } from 'node:url';

import { validateAllowedWorkspaceRoot } from '../chats-workspace/paths.js';
import { getEffectiveWorkspaceRoot } from '../runtime/path-access.js';
import { loadShipGateState, saveShipGateConfig, saveShipGateEvidence } from './config.js';

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 256 * 1024) {
        reject(new Error('Request body is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

async function resolveRoot(value) {
  if (typeof value === 'string' && value.trim()) return validateAllowedWorkspaceRoot(value.trim());
  return getEffectiveWorkspaceRoot();
}

export function createShipGateMiddleware() {
  return async (req, res, next) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith('/api/ship-gate')) return next();
    if (req.minnowAuth?.kind !== 'host') {
      sendJson(res, 403, { error: 'Host session required' });
      return;
    }
    try {
      if (url.pathname === '/api/ship-gate' && req.method === 'GET') {
        const root = await resolveRoot(url.searchParams.get('workspaceRoot'));
        sendJson(res, 200, await loadShipGateState(root));
        return;
      }
      if (url.pathname === '/api/ship-gate/config' && req.method === 'PUT') {
        const body = await readJsonBody(req);
        const root = await resolveRoot(body.workspaceRoot);
        const config = await saveShipGateConfig(root, body.config);
        sendJson(res, 200, { ok: true, config });
        return;
      }
      if (url.pathname === '/api/ship-gate/evidence' && req.method === 'PUT') {
        const body = await readJsonBody(req);
        const root = await resolveRoot(body.workspaceRoot);
        const evidence = await saveShipGateEvidence(root, body.evidence);
        sendJson(res, 200, { ok: true, evidence });
        return;
      }
      sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  };
}
