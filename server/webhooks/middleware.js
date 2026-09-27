/**
 * HTTP middleware for /api/webhooks (subscriptions, deliveries, client events).
 */

import { readConfigJson } from '../config/store.js';
import { SUBSCRIBABLE_EVENTS } from './constants.js';
import { deliverTest, fireAndForget, listRecentDeliveries } from './emit.js';
import {
  createSubscription,
  deleteSubscription,
  listSubscriptions,
  updateSubscription,
} from './store.js';

const MAX_BODY_BYTES = 64 * 1024;

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const onData = (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        settled = true;
        req.removeListener('data', onData);
        req.resume();
        reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    };
    req.on('data', onData);
    req.on('end', () => {
      if (settled) return;
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        const parsed = raw ? JSON.parse(raw) : {};
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(Object.assign(new Error('JSON body must be an object'), { statusCode: 400 }));
          return;
        }
        resolve(parsed);
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
 * @returns {Promise<{ allowLocalHttp: boolean }>}
 */
async function loadWebhookOptions() {
  const config = (await readConfigJson('config.json')) ?? {};
  const webhooks =
    config.webhooks && typeof config.webhooks === 'object'
      ? /** @type {{ allowLocalHttp?: boolean }} */ (config.webhooks)
      : {};
  return { allowLocalHttp: webhooks.allowLocalHttp === true };
}

const SUBSCRIPTION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string} pathname
 * @returns {Promise<boolean>}
 */
export async function handleWebhooksRequest(req, res, pathname) {
  if (!pathname.startsWith('/api/webhooks')) {
    return false;
  }

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return true;
  }

  try {
    const options = await loadWebhookOptions();

    if (pathname === '/api/webhooks/subscriptions' && req.method === 'GET') {
      const subscriptions = await listSubscriptions();
      sendJson(res, 200, { subscriptions, events: SUBSCRIBABLE_EVENTS });
      return true;
    }

    if (pathname === '/api/webhooks/subscriptions' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const subscription = await createSubscription(body, options);
      sendJson(res, 201, { ok: true, subscription });
      return true;
    }

    if (pathname === '/api/webhooks/deliveries' && req.method === 'GET') {
      const deliveries = await listRecentDeliveries();
      sendJson(res, 200, { deliveries });
      return true;
    }

    if (pathname === '/api/webhooks/events/session-created' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const chatId = typeof body.chatId === 'string' ? body.chatId.trim() : '';
      if (!chatId) {
        sendJson(res, 400, { error: 'chatId is required' });
        return true;
      }
      fireAndForget('session.created', {
        chatId,
      });
      sendJson(res, 202, { ok: true });
      return true;
    }

    const testMatch = pathname.match(
      /^\/api\/webhooks\/subscriptions\/([^/]+)\/test$/,
    );
    if (testMatch && req.method === 'POST') {
      const id = testMatch[1];
      if (!SUBSCRIPTION_ID_RE.test(id)) {
        sendJson(res, 400, { error: 'Invalid subscription id' });
        return true;
      }
      await deliverTest(id);
      sendJson(res, 200, { ok: true });
      return true;
    }

    const idMatch = pathname.match(/^\/api\/webhooks\/subscriptions\/([^/]+)$/);
    if (idMatch) {
      const id = idMatch[1];
      if (!SUBSCRIPTION_ID_RE.test(id)) {
        sendJson(res, 400, { error: 'Invalid subscription id' });
        return true;
      }

      if (req.method === 'PUT') {
        const body = await readJsonBody(req);
        try {
          const subscription = await updateSubscription(id, body, options);
          sendJson(res, 200, { ok: true, subscription });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (message === 'Subscription not found') {
            sendJson(res, 404, { error: message });
          } else {
            sendJson(res, 400, { error: message });
          }
        }
        return true;
      }

      if (req.method === 'DELETE') {
        const removed = await deleteSubscription(id);
        if (!removed) {
          sendJson(res, 404, { error: 'Not found' });
          return true;
        }
        sendJson(res, 200, { ok: true });
        return true;
      }
    }

    sendJson(res, 404, { error: 'Not found' });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[webhooks]', message);
    const requestedStatus = Number(err?.statusCode);
    const status =
      Number.isInteger(requestedStatus) && requestedStatus >= 400 && requestedStatus < 600
        ? requestedStatus
        : /required|invalid|must|too long/i.test(message)
          ? 400
          : 500;
    sendJson(res, status, { error: status >= 500 ? 'Webhook request failed' : message });
    return true;
  }
}

/** Vite middleware hook. */
export function createWebhooksMiddleware() {
  return async (req, res, next) => {
    const rawUrl = req.url ?? '';
    const q = rawUrl.indexOf('?');
    const pathname = q >= 0 ? rawUrl.slice(0, q) : rawUrl;
    if (!pathname.startsWith('/api/webhooks')) {
      next();
      return;
    }
    const handled = await handleWebhooksRequest(req, res, pathname);
    if (!handled) next();
  };
}
