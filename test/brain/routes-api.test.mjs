/**
 * Brain HTTP API smoke tests.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer, request as httpRequestNode } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { closeSessionsDb } from '../../server/config/sessions-db.js';
import { closeCodeDbForTests } from '../../server/brain/code/schema.js';
import { handleBrainRequest, initBrainApi } from '../../server/brain/routes.js';
import { shutdownAllLsp } from '../../server/lsp/manager.js';


function httpRequest(baseUrl, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, baseUrl);
    const payload = body ? JSON.stringify(body) : undefined;
    const req = httpRequestNode(
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
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function startBrainServer(homeDir) {
  process.env.MINNOW_HOME = homeDir;
  resetMinnowHomeCache();
  await fs.rm(homeDir, { recursive: true, force: true });
  await fs.mkdir(homeDir, { recursive: true });
  await initBrainApi();

  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    const handled = await handleBrainRequest(req, res, pathname);
    if (!handled) {
      res.statusCode = 404;
      res.end('not found');
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

describe('brain API', () => {
  let homeDir;
  let server;
  let baseUrl;

  before(async () => {
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-brain-api-'));
    ({ server, baseUrl } = await startBrainServer(homeDir));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    shutdownAllLsp();
    closeCodeDbForTests();
    // initBrainApi opens sessions.db via readAllChatIds — close before rm (Windows EBUSY).
    closeSessionsDb();
    delete process.env.MINNOW_HOME;
    resetMinnowHomeCache();
    await fs.rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  test('ping returns ok', async () => {
    const res = await httpRequest(baseUrl, 'GET', '/api/brain/ping');
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
  });

  test('legacy wiki mutations are no longer exposed', async () => {
    for (const [method, endpoint] of [['PUT', 'page'], ['POST', 'archive'], ['POST', 'ingest'], ['POST', 'clear'], ['POST', 'proposals/clear']]) {
      const response = await httpRequest(baseUrl, method, '/api/brain/' + endpoint, { confirmed: true });
      assert.equal(response.status, 404, endpoint);
    }
  });

  test('code index reset still requires confirmation', async () => {
    const response = await httpRequest(baseUrl, 'POST', '/api/brain/code/clear', {});
    assert.equal(response.status, 400);
  });
});
