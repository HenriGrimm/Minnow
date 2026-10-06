/**
 * Delivery queue tests — fire-and-forget must not block callers.
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import {
  resetSecretBoxCacheForTests,
  setSecretKeyBytesForTests,
  writeEncryptedJsonFile,
} from '../../server/security/secret-box.js';
import {
  fireAndForget,
  getWebhookDeliveryStateForTests,
  resetWebhookDeliveryStateForTests,
} from '../../server/webhooks/emit.js';
import { createSubscription } from '../../server/webhooks/store.js';

const FIXED_KEY = Buffer.from('cccccccccccccccccccccccccccccccc', 'utf8');

/** @type {string | undefined} */
let homeDir;

/** @type {http.Server | null} */
let server = null;

/** @type {string} */
let serverUrl = '';

function setTestHome() {
  resetMinnowHomeCache();
  resetSecretBoxCacheForTests();
  resetWebhookDeliveryStateForTests();
  setSecretKeyBytesForTests(FIXED_KEY);
  const dir = path.join(os.tmpdir(), `minnow-webhooks-${process.pid}-${Date.now()}`);
  process.env.MINNOW_HOME = dir;
  homeDir = dir;
  return dir;
}

async function readDeliveriesFromDisk(home) {
  const filePath = path.join(home, 'webhooks-deliveries.json');
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.deliveries) ? parsed.deliveries : [];
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return [];
    throw err;
  }
}

async function waitForRecordedDelivery(home, deadlineMs = 8_000) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const deliveries = await readDeliveriesFromDisk(home);
    if (deliveries.length > 0) return deliveries;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return [];
}

async function rmTestHome() {
  resetMinnowHomeCache();
  resetSecretBoxCacheForTests();
  resetWebhookDeliveryStateForTests();
  delete process.env.MINNOW_HOME;
  if (homeDir) {
    try {
      await fs.rm(homeDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  homeDir = undefined;
}

function startTestServer(handler) {
  return new Promise((resolve) => {
    server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        serverUrl = `http://127.0.0.1:${addr.port}/hook`;
      }
      resolve();
    });
  });
}

function closeTestServer() {
  return new Promise((resolve) => {
    if (!server) {
      resolve();
      return;
    }
    server.close(() => {
      server = null;
      resolve();
    });
  });
}

describe('webhook delivery', () => {
  beforeEach(() => {
    setTestHome();
  });

  afterEach(async () => {
    await closeTestServer();
    await rmTestHome();
  });

  test('fireAndForget returns immediately and records delivery', async () => {
    let received = 0;
    await startTestServer((_req, res) => {
      received += 1;
      res.statusCode = 204;
      res.end();
    });

    const configPath = path.join(homeDir, 'config.json');
    await fs.mkdir(homeDir, { recursive: true });
    await fs.writeFile(
      configPath,
      `${JSON.stringify({ webhooks: { allowLocalHttp: true } }, null, 2)}\n`,
      'utf8',
    );

    await createSubscription(
      {
        label: 'Local test',
        url: serverUrl,
        events: ['chat.completed'],
        secret: 'delivery-secret-at-least-32-chars',
      },
      { allowLocalHttp: true },
    );

    const t0 = Date.now();
    fireAndForget('chat.completed', { generationId: 'gen-1', status: 'completed' });
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 200, 'fireAndForget should not block');

    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      if (received > 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(received, 1, 'expected local test server to receive POST');

    const deliveries = await waitForRecordedDelivery(homeDir);
    assert.ok(deliveries.length >= 1, 'expected delivery log on disk for this test home');
    assert.equal(deliveries[0].event, 'chat.completed');
    assert.equal(deliveries[0].statusCode, 204);
  });

  test('caps the total delivery budget including delayed retries', async () => {
    const now = new Date().toISOString();
    const subscriptions = Array.from({ length: 101 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      label: `Blocked ${index}`,
      url: 'https://127.0.0.1/hook',
      events: ['chat.completed'],
      enabled: true,
      secretRef: '',
      createdAt: now,
      updatedAt: now,
    }));
    await fs.mkdir(homeDir, { recursive: true });
    await writeEncryptedJsonFile(path.join(homeDir, 'webhooks.json'), {
      version: 1,
      subscriptions,
    });

    fireAndForget('chat.completed', { generationId: 'budget-test' });
    const deadline = Date.now() + 2_000;
    let state;
    do {
      state = getWebhookDeliveryStateForTests();
      if (state.delayedRetries === 100) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    } while (Date.now() < deadline);

    assert.equal(state.outstanding, 100);
    assert.equal(state.delayedRetries, 100);
    resetWebhookDeliveryStateForTests();
  });
});
