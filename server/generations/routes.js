/**
 * HTTP middleware for /api/generations (backend-owned LLM streams).
 * A client disconnect tears down this SSE socket only — it must not cancel upstream.
 */

import { validateProviderId } from '../providers/validate.js';
import { handleRouterRequest } from '../model-routers/routes.js';
import { pumpRouterGeneration } from '../model-routers/generation.js';
import { readConfigJson } from '../config/store.js';
import { listProviders } from '../providers/store.js';
import { resolveFallbackChain } from './fallback.js';
import { pumpUpstream } from './upstream.js';
import {
  addSubscriber,
  cancel,
  createGenerationState,
  getGenerationState,
  removeSubscriber,
} from './store.js';

const GENERATION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
 * @param {string} segment
 * @returns {boolean}
 */
function isGenerationId(segment) {
  return typeof segment === 'string' && GENERATION_ID_RE.test(segment);
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string} pathname
 * @returns {Promise<boolean>}
 */
export async function handleGenerationsRequest(req, res, pathname) {
  if (!pathname.startsWith('/api/generations')) {
    return false;
  }

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return true;
  }

  try {
    if (await handleRouterRequest(req, res, pathname, readJsonBody, sendJson)) return true;
    if (pathname === '/api/generations' && req.method === 'POST') {
      const payload = await readJsonBody(req);
      const providerId =
        typeof payload.providerId === 'string' ? validateProviderId(payload.providerId) : null;
      if (!providerId) {
        sendJson(res, 400, { error: 'providerId is required' });
        return true;
      }
      if (payload.body === undefined || payload.body === null) {
        sendJson(res, 400, { error: 'body is required' });
        return true;
      }

      const bodyObj =
        payload.body && typeof payload.body === 'object'
          ? /** @type {{ model?: string }} */ (payload.body)
          : {};
      const primaryModelId = typeof bodyObj.model === 'string' ? bodyObj.model : '';
      const fallbackRole =
        typeof payload.fallbackRole === 'string' && payload.fallbackRole.trim()
          ? payload.fallbackRole.trim()
          : null;

      const config = (await readConfigJson('config.json')) ?? {};
      const { providers } = await listProviders();
      const enabledProviderIds = new Set(
        providers.filter((p) => p.enabled !== false).map((p) => p.id),
      );
      const candidates = resolveFallbackChain({
        role: fallbackRole ?? 'main-chat',
        primaryProviderId: providerId,
        primaryModelId,
        config,
        enabledProviderIds,
      });

      const state = createGenerationState({
        providerId,
        body: payload.body,
        persist: payload.persist === true,
        candidates,
        fallbackRole,
        chatId: typeof payload.chatId === 'string' ? payload.chatId : null,
      });

      if (providerId === 'minnow-router') pumpRouterGeneration(state);
      else pumpUpstream({ state });
      sendJson(res, 201, {
        generationId: state.id,
        candidateCount: candidates.length,
      });
      return true;
    }

    const streamMatch = pathname.match(/^\/api\/generations\/([^/]+)\/stream$/);
    if (streamMatch && req.method === 'GET') {
      const id = streamMatch[1];
      if (!isGenerationId(id)) {
        sendJson(res, 400, { error: 'Invalid generation id' });
        return true;
      }
      const state = getGenerationState(id);
      if (!state) {
        sendJson(res, 404, { error: 'Generation not found' });
        return true;
      }

      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');

      addSubscriber(state, res);

      const onClientDisconnect = () => {
        removeSubscriber(state, res);
        if (!res.writableEnded && !res.destroyed) {
          res.destroy();
        }
      };
      req.on('close', onClientDisconnect);
      req.on('aborted', onClientDisconnect);
      res.on('close', onClientDisconnect);
      return true;
    }

    const cancelMatch = pathname.match(/^\/api\/generations\/([^/]+)\/cancel$/);
    if (cancelMatch && req.method === 'POST') {
      const id = cancelMatch[1];
      if (!isGenerationId(id)) {
        sendJson(res, 400, { error: 'Invalid generation id' });
        return true;
      }
      const state = getGenerationState(id);
      if (!state) {
        sendJson(res, 404, { error: 'Generation not found' });
        return true;
      }
      cancel(state);
      sendJson(res, 200, { ok: true });
      return true;
    }

    const statusMatch = pathname.match(/^\/api\/generations\/([^/]+)$/);
    if (statusMatch && req.method === 'GET') {
      const id = statusMatch[1];
      if (!isGenerationId(id)) {
        sendJson(res, 400, { error: 'Invalid generation id' });
        return true;
      }
      const state = getGenerationState(id);
      if (!state) {
        sendJson(res, 404, { error: 'Generation not found' });
        return true;
      }
      sendJson(res, 200, {
        status: state.status,
        totalBytes: state.totalBytes,
        startedAt: state.startedAt,
        finishedAt: state.finishedAt,
        errorMessage: state.errorMessage,
        quotaExceeded: state.quotaExceeded === true,
        fallbackUsed: state.fallbackUsed,
        chosenProviderId: state.chosenProviderId,
        chosenModelId: state.chosenModelId,
      });
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
    if (message === 'Invalid provider id' || message === 'Invalid JSON body') {
      sendJson(res, 400, { error: message });
      return true;
    }
    if (message.includes('ENOENT') || message.includes('not found')) {
      sendJson(res, 404, { error: 'Provider not found' });
      return true;
    }
    console.error('[generations]', message);
    sendJson(res, 500, { error: message });
    return true;
  }
}

/** Connect middleware for Vite dev server. */
export function createGenerationsMiddleware() {
  return async (req, res, next) => {
    const url = req.url?.split('?')[0] ?? '';
    if (!url.startsWith('/api/generations')) {
      next();
      return;
    }

    const handled = await handleGenerationsRequest(req, res, url);
    if (!handled) {
      next();
    }
  };
}

