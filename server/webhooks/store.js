/**
 * Encrypted webhook subscription persistence and signing secrets.
 */

import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import {
  readEncryptedJsonFile,
  writeEncryptedJsonFile,
} from '../security/secret-box.js';
import { isSubscribableEvent } from './constants.js';
import { validateWebhookUrl } from './ssrf.js';
import {
  secretFilePath,
  secretRefForSubscription,
  webhooksStorePath,
} from './paths.js';

/**
 * @typedef {object} WebhookSubscription
 * @property {string} id
 * @property {string} label
 * @property {string} url
 * @property {string[]} events
 * @property {boolean} enabled
 * @property {string} secretRef
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * @typedef {object} WebhookStoreFile
 * @property {number} version
 * @property {WebhookSubscription[]} subscriptions
 */

const STORE_VERSION = 1;
const MIN_SIGNING_SECRET_CHARS = 32;
const MAX_SIGNING_SECRET_CHARS = 4096;
const MAX_LABEL_CHARS = 128;

/** Serialize reads and mutations across windows and companion clients. */
let storeOperationChain = Promise.resolve();

/**
 * @template T
 * @param {() => Promise<T>} operation
 * @returns {Promise<T>}
 */
function withStoreOperation(operation) {
  const result = storeOperationChain.then(operation, operation);
  storeOperationChain = result.then(() => undefined, () => undefined);
  return result;
}

/**
 * @returns {Promise<WebhookStoreFile>}
 */
async function readStoreFile() {
  const filePath = webhooksStorePath();
  try {
    // Legacy plaintext stores are encrypted automatically on first read.
    const parsed = await readEncryptedJsonFile(filePath, {
      version: STORE_VERSION,
      subscriptions: [],
    });
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.subscriptions)) {
      return { version: STORE_VERSION, subscriptions: [] };
    }
    return {
      version: STORE_VERSION,
      subscriptions: parsed.subscriptions,
    };
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
      return { version: STORE_VERSION, subscriptions: [] };
    }
    throw err;
  }
}

/**
 * @param {WebhookStoreFile} store
 */
async function writeStoreFile(store) {
  await writeEncryptedJsonFile(webhooksStorePath(), {
    version: STORE_VERSION,
    subscriptions: store.subscriptions,
  });
}

/** Keep credential-bearing paths and query strings out of API/UI responses. */
function redactWebhookUrl(url) {
  try {
    const parsed = new URL(url);
    const hasHiddenTarget = parsed.pathname !== '/' || parsed.search || parsed.hash;
    return `${parsed.protocol}//${parsed.host}${hasHiddenTarget ? '/…' : ''}`;
  } catch {
    return '[invalid webhook URL]';
  }
}

/**
 * @param {WebhookSubscription} sub
 */
export function toPublicSubscription(sub) {
  return {
    id: sub.id,
    label: sub.label,
    url: redactWebhookUrl(sub.url),
    events: [...sub.events],
    enabled: sub.enabled,
    hasSecret: Boolean(sub.secretRef),
    createdAt: sub.createdAt,
    updatedAt: sub.updatedAt,
  };
}

/**
 * @returns {Promise<ReturnType<typeof toPublicSubscription>[]>}
 */
export async function listSubscriptions() {
  return withStoreOperation(async () => {
    const store = await readStoreFile();
    return store.subscriptions.map(toPublicSubscription);
  });
}

/**
 * @param {string} id
 * @returns {Promise<WebhookSubscription | null>}
 */
export async function getSubscriptionById(id) {
  return withStoreOperation(async () => {
    const store = await readStoreFile();
    return store.subscriptions.find((s) => s.id === id) ?? null;
  });
}

/**
 * @param {string} id
 * @returns {Promise<string | null>}
 */
async function readSubscriptionSecretFile(id) {
  const filePath = secretFilePath(id);
  try {
    const data = await readEncryptedJsonFile(filePath, { secret: '' });
    const secret = typeof data.secret === 'string' ? data.secret : '';
    return secret || null;
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

/**
 * @param {string} id
 * @param {string} secret
 */
async function writeSubscriptionSecret(id, secret) {
  const filePath = secretFilePath(id);
  if (!secret.trim()) {
    try {
      await fs.unlink(filePath);
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') {
        throw err;
      }
    }
    return;
  }
  await writeEncryptedJsonFile(filePath, { secret: secret.trim() });
}

/**
 * @param {unknown} raw
 * @returns {string[]}
 */
function normalizeEvents(raw) {
  if (!Array.isArray(raw)) {
    throw new Error('events must be an array');
  }
  const events = [...new Set(raw.map((e) => String(e).trim()).filter(Boolean))];
  if (events.length === 0) {
    throw new Error('At least one event is required');
  }
  const invalid = events.filter((e) => !isSubscribableEvent(e));
  if (invalid.length > 0) {
    throw new Error(`Invalid events: ${invalid.join(', ')}`);
  }
  return events;
}

export async function readSubscriptionSecret(id) {
  return withStoreOperation(() => readSubscriptionSecretFile(id));
}

/**
 * @param {unknown} raw
 * @param {{ allowUnsigned?: boolean }} [options]
 */
function normalizeSigningSecret(raw, options = {}) {
  const secret = typeof raw === 'string' ? raw.trim() : '';
  if (!secret) {
    if (options.allowUnsigned === true) return '';
    throw new Error('A signing secret of at least 32 characters is required');
  }
  if (secret.length < MIN_SIGNING_SECRET_CHARS) {
    throw new Error('Signing secret must be at least 32 characters');
  }
  if (secret.length > MAX_SIGNING_SECRET_CHARS) {
    throw new Error('Signing secret is too long (max 4096 characters)');
  }
  return secret;
}

/**
 * @param {object} input
 * @param {{ allowLocalHttp?: boolean }} options
 * @returns {Promise<ReturnType<typeof toPublicSubscription>>}
 */
export async function createSubscription(input, options = {}) {
  return withStoreOperation(async () => {
    const label = typeof input.label === 'string' ? input.label.trim() : '';
    const urlRaw = typeof input.url === 'string' ? input.url : '';
    const secret = normalizeSigningSecret(input.secret, {
      allowUnsigned: input.allowUnsigned === true,
    });
    const enabled = input.enabled !== false;

    if (!label) throw new Error('label is required');
    if (label.length > MAX_LABEL_CHARS) {
      throw new Error('label is too long (max 128 characters)');
    }

    const url = await validateWebhookUrl(urlRaw, options);
    const events = normalizeEvents(input.events);
    const id = randomUUID();
    const now = new Date().toISOString();

    /** @type {WebhookSubscription} */
    const sub = {
      id,
      label,
      url,
      events,
      enabled,
      secretRef: secret ? secretRefForSubscription(id) : '',
      createdAt: now,
      updatedAt: now,
    };

    if (secret) await writeSubscriptionSecret(id, secret);

    const store = await readStoreFile();
    store.subscriptions.push(sub);
    await writeStoreFile(store);
    return toPublicSubscription(sub);
  });
}

/**
 * @param {string} id
 * @param {object} input
 * @param {{ allowLocalHttp?: boolean }} options
 * @returns {Promise<ReturnType<typeof toPublicSubscription>>}
 */
export async function updateSubscription(id, input, options = {}) {
  return withStoreOperation(async () => {
    const store = await readStoreFile();
    const index = store.subscriptions.findIndex((s) => s.id === id);
    if (index < 0) {
      throw new Error('Subscription not found');
    }

    const existing = store.subscriptions[index];
    const label =
      typeof input.label === 'string' && input.label.trim()
        ? input.label.trim()
        : existing.label;
    if (label.length > MAX_LABEL_CHARS) {
      throw new Error('label is too long (max 128 characters)');
    }
    const url =
      typeof input.url === 'string' && input.url.trim()
        ? await validateWebhookUrl(input.url, options)
        : existing.url;
    const events = input.events !== undefined ? normalizeEvents(input.events) : existing.events;
    const enabled = input.enabled !== undefined ? input.enabled !== false : existing.enabled;

    if (typeof input.secret === 'string') {
      if (!input.secret.trim() && input.clearSecret === true) {
        if (input.allowUnsigned !== true) {
          throw new Error('Set allowUnsigned to explicitly disable webhook signing');
        }
        await writeSubscriptionSecret(id, '');
        existing.secretRef = '';
      } else if (input.secret.trim()) {
        const secret = normalizeSigningSecret(input.secret);
        await writeSubscriptionSecret(id, secret);
        existing.secretRef = secretRefForSubscription(id);
      }
    }

    existing.label = label;
    existing.url = url;
    existing.events = events;
    existing.enabled = enabled;
    existing.updatedAt = new Date().toISOString();
    store.subscriptions[index] = existing;
    await writeStoreFile(store);
    return toPublicSubscription(existing);
  });
}

/**
 * @param {string} id
 * @returns {Promise<boolean>}
 */
export async function deleteSubscription(id) {
  return withStoreOperation(async () => {
    const store = await readStoreFile();
    const index = store.subscriptions.findIndex((s) => s.id === id);
    if (index < 0) {
      return false;
    }
    store.subscriptions.splice(index, 1);
    await writeStoreFile(store);
    try {
      await fs.unlink(secretFilePath(id));
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') {
        throw err;
      }
    }
    return true;
  });
}

/**
 * @param {string} event
 * @returns {Promise<WebhookSubscription[]>}
 */
export async function listEnabledSubscriptionsForEvent(event) {
  return withStoreOperation(async () => {
    const store = await readStoreFile();
    return store.subscriptions.filter((s) => s.enabled && s.events.includes(event));
  });
}

/** Load delivery metadata and signing material as one atomic store operation. */
export async function listDeliveryTargetsForEvent(event) {
  return withStoreOperation(async () => {
    const store = await readStoreFile();
    const targets = [];
    for (const sub of store.subscriptions) {
      if (!sub.enabled || !sub.events.includes(event)) continue;
      const secret = sub.secretRef ? await readSubscriptionSecretFile(sub.id) : null;
      if (sub.secretRef && !secret) {
        console.warn(`[webhooks] signing secret unavailable for subscription ${sub.id}; delivery skipped`);
        continue;
      }
      targets.push({ ...sub, secret });
    }
    return targets;
  });
}

/** Load one test-delivery target without allowing a signed-to-unsigned downgrade. */
export async function getDeliveryTargetById(id) {
  return withStoreOperation(async () => {
    const store = await readStoreFile();
    const sub = store.subscriptions.find((candidate) => candidate.id === id) ?? null;
    if (!sub) return null;
    const secret = sub.secretRef ? await readSubscriptionSecretFile(sub.id) : null;
    if (sub.secretRef && !secret) {
      throw new Error('Webhook signing secret is unavailable');
    }
    return { ...sub, secret };
  });
}
