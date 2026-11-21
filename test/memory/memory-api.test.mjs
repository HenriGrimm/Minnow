/**
 * Memory API integration tests (Step 16) — fixed UUIDs, static expectations.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { closeCodeDbForTests } from '../../server/brain/code/schema.js';
import { handleMemoryRequest, initMemoryApi } from '../../server/memory/routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ID = '11111111-1111-1111-1111-111111111111';
const FIXTURE_ID_B = '22222222-2222-2222-2222-222222222222';

import { request as httpRequestNode } from 'node:http';

function httpRequest(baseUrl, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, baseUrl);
    const payload = body ? JSON.stringify(body) : undefined;
    const r = httpRequestNode(
      url,
      {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = raw ? JSON.parse(raw) : null;
          } catch {
            json = { raw };
          }
          resolve({ status: res.statusCode, json });
        });
      },
    );
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

async function startMemoryServer(homeDir) {
  process.env.MINNOW_HOME = homeDir;
  resetMinnowHomeCache();
  await fs.rm(homeDir, { recursive: true, force: true });
  await fs.mkdir(homeDir, { recursive: true });
  await initMemoryApi();

  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    const handled = await handleMemoryRequest(req, res, pathname);
    if (!handled) {
      res.statusCode = 404;
      res.end('not found');
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

describe('memory API', () => {
  let homeDir;
  let server;
  let baseUrl;

  before(async () => {
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-memory-api-'));
    ({ server, baseUrl } = await startMemoryServer(homeDir));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    closeCodeDbForTests();
    delete process.env.MINNOW_HOME;
    resetMinnowHomeCache();
    await fs.rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  test('ping returns ok', async () => {
    const res = await httpRequest(baseUrl, 'GET', '/api/memory/ping');
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
  });

  test('old entry write endpoints are retired', async () => {
    const response = await httpRequest(baseUrl, 'POST', '/api/memory/entries', { title: 'Old entry', body: 'Not written' });
    assert.equal(response.status, 404);
  });

  test('embeddings status returns defaults when enabled', async () => {
    const res = await httpRequest(baseUrl, 'GET', '/api/memory/embeddings/status');
    assert.equal(res.status, 200);
    assert.equal(res.json.enabled, true);
    assert.equal(res.json.backend, 'local');
    assert.equal(typeof res.json.vectorCount, 'number');
    assert.equal(typeof res.json.pageCount, 'number');
    assert.equal(typeof res.json.healthy, 'boolean');
  });

  test('embeddings reindex rejects when disabled', async () => {
    await httpRequest(baseUrl, 'PUT', '/api/memory/embeddings/config', {
      enabled: false,
      backend: 'local',
      modelId: 'Xenova/all-MiniLM-L6-v2',
    });
    const res = await httpRequest(baseUrl, 'POST', '/api/memory/embeddings/reindex');
    assert.equal(res.status, 400);
    assert.match(res.json.error, /disabled/i);
  });

  test('embeddings warmup rejects provider backend when disabled', async () => {
    await httpRequest(baseUrl, 'PUT', '/api/memory/embeddings/config', {
      enabled: false,
      backend: 'provider',
      modelId: 'text-embedding-3-small',
      providerId: 'openai',
    });
    const res = await httpRequest(baseUrl, 'POST', '/api/memory/embeddings/warmup');
    assert.equal(res.status, 400);
    assert.match(res.json.error, /enable semantic embeddings/i);
  });

  test('embeddings warmup rejects local backend without model id', async () => {
    await httpRequest(baseUrl, 'PUT', '/api/memory/embeddings/config', {
      enabled: false,
      backend: 'local',
      modelId: '',
    });
    const res = await httpRequest(baseUrl, 'POST', '/api/memory/embeddings/warmup');
    assert.equal(res.status, 400);
    assert.match(res.json.error, /model id is required/i);
  });

  test('embeddings config can be updated', async () => {
    const res = await httpRequest(baseUrl, 'PUT', '/api/memory/embeddings/config', {
      enabled: false,
      backend: 'local',
      modelId: 'Xenova/all-MiniLM-L6-v2',
      blendWeight: 0.75,
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.embeddings.enabled, false);
    assert.equal(res.json.embeddings.blendWeight, 0.75);
  });
});
