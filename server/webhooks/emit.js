/**
 * Fire-and-forget webhook delivery queue with retries and bounded logs.
 */

import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readConfigJson } from '../config/store.js';
import {
  DELIVERY_TIMEOUT_MS,
  isAllowedEvent,
  MAX_DELIVERY_LOG,
  MAX_PENDING_DELIVERIES,
  MAX_DELIVERY_ATTEMPTS,
  RETRY_BACKOFF_MS,
} from './constants.js';
import { webhooksDeliveriesPath } from './paths.js';
import {
  getDeliveryTargetById,
  listDeliveryTargetsForEvent,
} from './store.js';
import {
  buildWebhookBody,
  buildWebhookHeaders,
  computeWebhookSignature,
} from './sign.js';
import { resolveWebhookTarget, sanitizeError } from './ssrf.js';

/**
 * @typedef {object} WebhookDelivery
 * @property {string} id
 * @property {string} subscriptionId
 * @property {string} event
 * @property {number} [statusCode]
 * @property {string} [error]
 * @property {number} durationMs
 * @property {string} attemptedAt
 */

/**
 * @typedef {object} PendingDelivery
 * @property {string} deliveryId
 * @property {string} subscriptionId
 * @property {string} url
 * @property {string | null} secret
 * @property {string} event
 * @property {unknown} data
 * @property {number} attempt
 */

/** @type {PendingDelivery[]} */
const pendingQueue = [];

/** @type {WebhookDelivery[]} */
let deliveryLog = [];

let workerRunning = false;
let deliveriesLoaded = false;
let outstandingDeliveries = 0;
/** @type {Set<ReturnType<typeof setTimeout>>} */
const retryTimers = new Set();

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

/**
 * @returns {Promise<void>}
 */
async function ensureDeliveriesLoaded() {
  if (deliveriesLoaded) return;
  deliveriesLoaded = true;
  const filePath = webhooksDeliveriesPath();
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.deliveries)) {
      deliveryLog = parsed.deliveries.slice(-MAX_DELIVERY_LOG);
    }
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') {
      console.warn('[webhooks] could not load delivery log:', err);
    }
  }
}

/**
 * @returns {Promise<void>}
 */
async function persistDeliveries() {
  const filePath = webhooksDeliveriesPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const payload = {
    version: 1,
    deliveries: deliveryLog.slice(-MAX_DELIVERY_LOG),
  };
  await fs.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, filePath);
}

/**
 * @param {WebhookDelivery} entry
 */
async function recordDelivery(entry) {
  await ensureDeliveriesLoaded();
  deliveryLog.push(entry);
  if (deliveryLog.length > MAX_DELIVERY_LOG) {
    deliveryLog = deliveryLog.slice(-MAX_DELIVERY_LOG);
  }
  try {
    await persistDeliveries();
  } catch (err) {
    console.warn('[webhooks] could not persist delivery log:', err);
  }
}

/**
 * @param {PendingDelivery} job
 * @param {{ allowLocalHttp: boolean }} options
 * @returns {Promise<{ statusCode?: number, error?: string, durationMs: number }>}
 */
function postWebhook(job, options) {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve({ ...result, durationMs: Date.now() - started });
    };

    resolveWebhookTarget(job.url, options)
      .then((target) => {
        const body = buildWebhookBody(job.event, job.data);
        const timestampSeconds = Math.floor(Date.now() / 1000);
        const signature = job.secret
          ? computeWebhookSignature(job.secret, timestampSeconds, body)
          : undefined;
        const headers = buildWebhookHeaders({
          event: job.event,
          deliveryId: job.deliveryId,
          timestampSeconds,
          signature,
        });

        const parsed = new URL(target.url);
        const transport = parsed.protocol === 'https:' ? https : http;
        const req = transport.request(
          target.url,
          {
            method: 'POST',
            agent: false,
            lookup: target.lookup,
            headers: {
              ...headers,
              'Content-Length': Buffer.byteLength(body, 'utf8'),
            },
            timeout: DELIVERY_TIMEOUT_MS,
          },
          (res) => {
            res.resume();
            finish({ statusCode: res.statusCode ?? 0 });
          },
        );

        req.on('timeout', () => {
          req.destroy(new Error('Delivery timed out'));
        });
        req.on('error', (err) => {
          finish({ error: sanitizeError(err instanceof Error ? err.message : String(err)) });
        });
        req.write(body);
        req.end();
      })
      .catch((err) => {
        finish({
          error: sanitizeError(err instanceof Error ? err.message : String(err)),
        });
      });
  });
}

/**
 * @param {PendingDelivery} job
 * @param {{ allowLocalHttp: boolean }} options
 */
async function runDeliveryAttempt(job, options) {
  const result = await postWebhook(job, options);
  const success =
    typeof result.statusCode === 'number' &&
    result.statusCode >= 200 &&
    result.statusCode < 300;

  if (success || job.attempt >= MAX_DELIVERY_ATTEMPTS) {
    await recordDelivery({
      id: job.deliveryId,
      subscriptionId: job.subscriptionId,
      event: job.event,
      statusCode: result.statusCode,
      error: result.error,
      durationMs: result.durationMs,
      attemptedAt: new Date().toISOString(),
    });
    outstandingDeliveries = Math.max(0, outstandingDeliveries - 1);
    return;
  }

  const delay = RETRY_BACKOFF_MS[Math.min(job.attempt - 1, RETRY_BACKOFF_MS.length - 1)] ?? 1_000;
  const timer = setTimeout(() => {
    retryTimers.delete(timer);
    pendingQueue.push({ ...job, attempt: job.attempt + 1 });
    void ensureWorker();
  }, delay);
  retryTimers.add(timer);
}

async function ensureWorker() {
  if (workerRunning) return;
  workerRunning = true;
  try {
    const options = await loadWebhookOptions();
    while (pendingQueue.length > 0) {
      const job = pendingQueue.shift();
      if (!job) break;
      try {
        await runDeliveryAttempt(job, options);
      } catch (err) {
        outstandingDeliveries = Math.max(0, outstandingDeliveries - 1);
        throw err;
      }
    }
  } catch (err) {
    const dropped = pendingQueue.splice(0);
    outstandingDeliveries = Math.max(0, outstandingDeliveries - dropped.length);
    console.warn('[webhooks] delivery worker failed:', sanitizeError(err instanceof Error ? err.message : String(err)));
  } finally {
    workerRunning = false;
    if (pendingQueue.length > 0) {
      void ensureWorker();
    }
  }
}

/**
 * Reserve capacity for a delivery across queued, running, and delayed states.
 * @returns {boolean}
 */
function reserveDelivery() {
  if (outstandingDeliveries >= MAX_PENDING_DELIVERIES) {
    console.warn('[webhooks] delivery budget exhausted; dropped new job');
    return false;
  }
  outstandingDeliveries += 1;
  return true;
}

/** @param {PendingDelivery} job */
function enqueueNewDelivery(job) {
  if (!reserveDelivery()) return false;
  pendingQueue.push(job);
  void ensureWorker();
  return true;
}

/**
 * Enqueue deliveries for all enabled subscriptions matching the event.
 * Returns immediately without blocking callers.
 * @param {string} event
 * @param {unknown} data
 */
export function fireAndForget(event, data) {
  if (!isAllowedEvent(event)) {
    return;
  }

  void (async () => {
    try {
      const subs = await listDeliveryTargetsForEvent(event);
      if (subs.length === 0) {
        return;
      }

      for (const sub of subs) {
        const job = {
          deliveryId: randomUUID(),
          subscriptionId: sub.id,
          url: sub.url,
          secret: sub.secret,
          event,
          data,
          attempt: 1,
        };
        enqueueNewDelivery(job);
      }
    } catch (err) {
      console.warn('[webhooks] fireAndForget failed:', err);
    }
  })();
}

/**
 * Fire webhook.test for a single subscription (awaitable for API routes).
 * @param {string} subscriptionId
 */
export async function deliverTest(subscriptionId) {
  const sub = await getDeliveryTargetById(subscriptionId);
  if (!sub) {
    throw new Error('Subscription not found');
  }

  const job = {
    deliveryId: randomUUID(),
    subscriptionId: sub.id,
    url: sub.url,
    secret: sub.secret,
    event: 'webhook.test',
    data: { message: 'Test ping from Minnow' },
    attempt: 1,
  };
  if (!reserveDelivery()) {
    const err = new Error('Webhook delivery queue is full');
    err.statusCode = 429;
    throw err;
  }
  try {
    const options = await loadWebhookOptions();
    // Run the first test attempt synchronously so the route can report immediate
    // validation/transport failures. Retries retain this capacity reservation.
    await runDeliveryAttempt(job, options);
  } catch (err) {
    outstandingDeliveries = Math.max(0, outstandingDeliveries - 1);
    throw err;
  }
}

/**
 * @returns {Promise<WebhookDelivery[]>}
 */
export async function listRecentDeliveries() {
  await ensureDeliveriesLoaded();
  return [...deliveryLog].reverse().slice(0, 100);
}

/** In-memory counters exposed only for deterministic queue-budget tests. */
export function getWebhookDeliveryStateForTests() {
  return {
    pending: pendingQueue.length,
    delayedRetries: retryTimers.size,
    outstanding: outstandingDeliveries,
    workerRunning,
  };
}

/** Reset in-memory queue/log (tests only). */
export function resetWebhookDeliveryStateForTests() {
  for (const timer of retryTimers) clearTimeout(timer);
  retryTimers.clear();
  pendingQueue.length = 0;
  deliveryLog = [];
  workerRunning = false;
  deliveriesLoaded = false;
  outstandingDeliveries = 0;
}
