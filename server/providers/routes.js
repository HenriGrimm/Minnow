/**
 * HTTP routes for /api/providers/* (Vite configureServer middleware).
 */

import { ensureProviderRegistry } from './store.js';
import {
  createProvider,
  deleteProvider,
  getProvider,
  listProviders,
  setActiveProviderId,
  updateProvider,
  updateProviderSecrets,
} from './store.js';
import { readCapabilities } from './capabilities-store.js';
import { runCapabilityProbe } from './capability-probe.js';
import { proxyModelLoad, proxyModelUnload, proxyModels } from './proxy.js';
import {
  probeProviderCapabilities,
  readProviderCapabilitiesFile,
} from './capability-probe.js';
import { isSafeProviderPathSegment } from './validate.js';

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
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

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string} pathname
 * @returns {Promise<boolean>}
 */
export async function handleProviderRequest(req, res, pathname) {
  if (!pathname.startsWith('/api/providers')) {
    return false;
  }

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return true;
  }

  try {
    await ensureProviderRegistry();

    if (pathname === '/api/providers' && req.method === 'GET') {
      const data = await listProviders();
      sendJson(res, 200, data);
      return true;
    }

    if (pathname === '/api/providers' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const created = await createProvider(body);
      sendJson(res, 201, created);
      return true;
    }

    const idMatch = pathname.match(/^\/api\/providers\/([^/]+)$/);
    if (idMatch) {
      const id = idMatch[1];
      if (!isSafeProviderPathSegment(id)) {
        sendJson(res, 400, { error: 'Invalid provider id' });
        return true;
      }

      if (req.method === 'GET') {
        sendJson(res, 200, await getProvider(id));
        return true;
      }
      if (req.method === 'PUT') {
        const body = await readJsonBody(req);
        sendJson(res, 200, await updateProvider(id, body));
        return true;
      }
      if (req.method === 'DELETE') {
        try {
          await deleteProvider(id);
          res.statusCode = 204;
          res.end();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const status = message.includes('last provider') ? 409 : 404;
          sendJson(res, status, { error: message });
        }
        return true;
      }
    }

    const secretsMatch = pathname.match(/^\/api\/providers\/([^/]+)\/secrets$/);
    if (secretsMatch && req.method === 'PUT') {
      const id = secretsMatch[1];
      if (!isSafeProviderPathSegment(id)) {
        sendJson(res, 400, { error: 'Invalid provider id' });
        return true;
      }
      const body = await readJsonBody(req);
      sendJson(res, 200, await updateProviderSecrets(id, body));
      return true;
    }

    const activeMatch = pathname.match(/^\/api\/providers\/([^/]+)\/set-active$/);
    if (activeMatch && req.method === 'POST') {
      const id = activeMatch[1];
      if (!isSafeProviderPathSegment(id)) {
        sendJson(res, 400, { error: 'Invalid provider id' });
        return true;
      }
      await setActiveProviderId(id);
      sendJson(res, 200, { ok: true, activeProviderId: id });
      return true;
    }

    const modelsLoadMatch = pathname.match(/^\/api\/providers\/([^/]+)\/models\/load$/);
    if (modelsLoadMatch && req.method === 'POST') {
      const id = modelsLoadMatch[1];
      if (!isSafeProviderPathSegment(id)) {
        sendJson(res, 400, { error: 'Invalid provider id' });
        return true;
      }
      const body = await readJsonBody(req);
      if (!body || typeof body.model !== 'string' || !body.model.trim()) {
        sendJson(res, 400, { error: 'model is required' });
        return true;
      }
      try {
        sendJson(res, 200, await proxyModelLoad(id, { model: body.model.trim() }));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('does not support model load/unload')) {
          sendJson(res, 400, { error: message });
          return true;
        }
        throw err;
      }
      return true;
    }

    const modelsUnloadMatch = pathname.match(/^\/api\/providers\/([^/]+)\/models\/unload$/);
    if (modelsUnloadMatch && req.method === 'POST') {
      const id = modelsUnloadMatch[1];
      if (!isSafeProviderPathSegment(id)) {
        sendJson(res, 400, { error: 'Invalid provider id' });
        return true;
      }
      const body = await readJsonBody(req);
      if (!body || typeof body.instance_id !== 'string' || !body.instance_id.trim()) {
        sendJson(res, 400, { error: 'instance_id is required' });
        return true;
      }
      try {
        sendJson(
          res,
          200,
          await proxyModelUnload(id, { instance_id: body.instance_id.trim() }),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('does not support model load/unload')) {
          sendJson(res, 400, { error: message });
          return true;
        }
        throw err;
      }
      return true;
    }

    const probeMatch = pathname.match(/^\/api\/providers\/([^/]+)\/probe-capabilities$/);
    if (probeMatch && req.method === 'POST') {
      const id = probeMatch[1];
      if (!isSafeProviderPathSegment(id)) {
        sendJson(res, 400, { error: 'Invalid provider id' });
        return true;
      }
      try {
        await getProvider(id);
      } catch {
        sendJson(res, 404, { error: 'Provider not found' });
        return true;
      }
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        body = {};
      }
      const modelId =
        body && typeof body.modelId === 'string' ? body.modelId.trim() : undefined;
      const selectedModelId =
        body && typeof body.selectedModelId === 'string'
          ? body.selectedModelId.trim()
          : undefined;
      try {
        sendJson(
          res,
          200,
          await probeProviderCapabilities(id, {
            modelId: modelId || undefined,
            selectedModelId: selectedModelId || undefined,
          }),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (
          message.includes('not loaded') ||
          message.includes('No loaded model')
        ) {
          sendJson(res, 400, { error: message });
          return true;
        }
        throw err;
      }
      return true;
    }

    const modelsMatch = pathname.match(/^\/api\/providers\/([^/]+)\/models$/);
    if (modelsMatch && req.method === 'GET') {
      const id = modelsMatch[1];
      if (!isSafeProviderPathSegment(id)) {
        sendJson(res, 400, { error: 'Invalid provider id' });
        return true;
      }
      sendJson(res, 200, await proxyModels(id));
      return true;
    }

    const capabilitiesMatch = pathname.match(
      /^\/api\/providers\/([^/]+)\/capabilities$/,
    );
    if (capabilitiesMatch && req.method === 'GET') {
      const id = capabilitiesMatch[1];
      if (!isSafeProviderPathSegment(id)) {
        sendJson(res, 400, { error: 'Invalid provider id' });
        return true;
      }
      try {
        await getProvider(id);
      } catch {
        sendJson(res, 404, { error: 'Provider not found' });
        return true;
      }
      const structuredOnly = await readProviderCapabilitiesFile(id);
      if (structuredOnly) {
        sendJson(res, 200, structuredOnly);
        return true;
      }
      sendJson(res, 200, await readCapabilities(id));
      return true;
    }

    const capabilitiesProbeMatch = pathname.match(
      /^\/api\/providers\/([^/]+)\/capabilities\/probe$/,
    );
    if (capabilitiesProbeMatch && req.method === 'POST') {
      const id = capabilitiesProbeMatch[1];
      if (!isSafeProviderPathSegment(id)) {
        sendJson(res, 400, { error: 'Invalid provider id' });
        return true;
      }
      try {
        await getProvider(id);
      } catch {
        sendJson(res, 404, { error: 'Provider not found' });
        return true;
      }
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON body' });
        return true;
      }
      const modelIds = Array.isArray(body.modelIds)
        ? body.modelIds.filter((m) => typeof m === 'string' && m.trim())
        : undefined;
      const selectedModelId =
        typeof body.selectedModelId === 'string' ? body.selectedModelId : undefined;
      const auto = body.auto === true;
      const skipVision = body.skipVision === true;
      try {
        const result = await runCapabilityProbe(id, {
          modelIds,
          selectedModelId,
          auto,
          skipVision,
        });
        sendJson(res, 200, result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('disabled') || message.includes('No loaded model')) {
          sendJson(res, 400, { error: message });
          return true;
        }
        throw err;
      }
      return true;
    }

    if (pathname.includes('..')) {
      sendJson(res, 400, { error: 'Invalid path' });
      return true;
    }

    sendJson(res, 404, { error: 'Not found' });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (
      message === 'Invalid provider id' ||
      message === 'Invalid baseUrl' ||
      message.includes('Invalid apiKind') ||
      message.includes('Agent CLI providers') ||
      message.includes('agent CLI provider')
    ) {
      sendJson(res, 400, { error: message });
      return true;
    }
    if (message === 'Provider not found' || message.includes('not found')) {
      sendJson(res, 404, { error: message });
      return true;
    }
    console.error('[providers]', message);
    sendJson(res, 500, { error: message });
    return true;
  }
}

/** Connect middleware for Vite dev server. */
export function createProviderMiddleware() {
  return async (req, res, next) => {
    const url = req.url?.split('?')[0] ?? '';
    if (!url.startsWith('/api/providers')) {
      next();
      return;
    }

    const handled = await handleProviderRequest(req, res, url);
    if (!handled) {
      next();
    }
  };
}
