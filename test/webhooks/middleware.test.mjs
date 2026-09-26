import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { handleWebhooksRequest } from '../../server/webhooks/middleware.js';

let homeDir;
let server;
let baseUrl;

beforeEach(async () => {
  resetMinnowHomeCache();
  homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-webhook-middleware-'));
  process.env.MINNOW_HOME = homeDir;
  server = http.createServer((req, res) => {
    void handleWebhooksRequest(req, res, new URL(req.url, 'http://localhost').pathname);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  resetMinnowHomeCache();
  delete process.env.MINNOW_HOME;
  if (homeDir) await fs.rm(homeDir, { recursive: true, force: true });
});

test('rejects oversized webhook API request bodies', async () => {
  const response = await fetch(`${baseUrl}/api/webhooks/subscriptions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ padding: 'x'.repeat(70 * 1024) }),
  });
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: 'Request body too large' });
});
