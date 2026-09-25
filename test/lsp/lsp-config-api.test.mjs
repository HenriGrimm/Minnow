/**
 * GET /api/config/lsp returns full merged catalog (feature-02).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { request as httpRequestNode } from 'node:http';
import { handleConfigRequest } from '../../server/config/middleware.js';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { invalidateLspConfigCache } from '../../server/lsp/config-loader.js';
import { createLspMiddleware } from '../../server/lsp/middleware.js';
import {
  getLspDocumentSyncForTest,
  notifyLspDocument,
  shutdownAllLsp,
} from '../../server/lsp/manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const STALE_FIXTURE = path.join(__dirname, '../fixtures/lsp-stale-home');

function httpGet(baseUrl, pathname) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, baseUrl);
    const r = httpRequestNode(url, { method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, json: JSON.parse(raw) });
      });
    });
    r.on('error', reject);
    r.end();
  });
}

function httpPut(baseUrl, pathname, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, baseUrl);
    const payload = JSON.stringify(body);
    const r = httpRequestNode(
      url,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode, json: raw ? JSON.parse(raw) : {} });
        });
      },
    );
    r.on('error', reject);
    r.write(payload);
    r.end();
  });
}

describe('GET /api/config/lsp catalog', () => {
  let homeDir;
  let server;
  let baseUrl;
  let defaultCount;

  before(async () => {
    const defaults = JSON.parse(
      await fs.readFile(path.join(PROJECT_ROOT, 'src/lsp/defaults.json'), 'utf8'),
    );
    defaultCount = Object.keys(defaults.lsp ?? {}).length;
    assert.equal(defaultCount, 16);

    homeDir = path.join(__dirname, '../fixtures/lsp-config-api-home');
    process.env.MINNOW_HOME = homeDir;
    resetMinnowHomeCache();
    invalidateLspConfigCache();
    shutdownAllLsp();
    await fs.rm(homeDir, { recursive: true, force: true });
    await fs.mkdir(homeDir, { recursive: true });
    await fs.copyFile(
      path.join(STALE_FIXTURE, 'lsp.json'),
      path.join(homeDir, 'lsp.json'),
    );

    const lspMiddleware = createLspMiddleware(PROJECT_ROOT);
    server = createServer((req, res) => {
      void lspMiddleware(req, res, () => {
        res.statusCode = 404;
        res.end('not found');
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    shutdownAllLsp();
    delete process.env.MINNOW_HOME;
    resetMinnowHomeCache();
    invalidateLspConfigCache();
    if (homeDir) {
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });

  test('servers.length matches defaults.json key count', async () => {
    const res = await httpGet(baseUrl, '/api/config/lsp');
    assert.equal(res.status, 200);
    assert.equal(res.json.servers.length, defaultCount);
    assert.equal(res.json.enabled, true);
    assert.ok(res.json.lsp.typescript);
    assert.ok(res.json.lsp.pyright);
    assert.equal(res.json.lsp.godot.transport.type, 'godot');
  });

  test('rust row includes requirements and disabledReason when disabled', async () => {
    const res = await httpGet(baseUrl, '/api/config/lsp');
    const rust = res.json.servers.find((s) => s.id === 'rust');
    assert.ok(rust);
    assert.equal(rust.requirements?.binary, 'rust-analyzer');
    assert.equal(rust.disabled, true);
    assert.match(String(rust.disabledReason ?? ''), /Disabled in settings/);
    assert.match(String(rust.disabledReason ?? ''), /Requires:.*rust-analyzer/);
  });

  test('typescript is enabled with command', async () => {
    const res = await httpGet(baseUrl, '/api/config/lsp');
    const ts = res.json.servers.find((s) => s.id === 'typescript');
    assert.ok(ts);
    assert.equal(ts.disabled, false);
    assert.equal(ts.hasCommand, true);
    assert.equal(ts.defaultEnabled, true);
  });

  test('PUT /api/config/lsp shuts down running LSP processes', async () => {
    if (process.env.MINNOW_LSP_ENABLED === 'false') return;

    const fakeHome = path.join(__dirname, '../fixtures/lsp-config-put-home');
    process.env.MINNOW_HOME = fakeHome;
    resetMinnowHomeCache();
    invalidateLspConfigCache();
    shutdownAllLsp();
    await fs.rm(fakeHome, { recursive: true, force: true });
    await fs.mkdir(fakeHome, { recursive: true });
    await fs.writeFile(
      path.join(fakeHome, 'lsp.json'),
      `${JSON.stringify(
        {
          enabled: true,
          lsp: {
            fake: {
              disabled: false,
              command: ['node', 'test/fixtures/fake-lsp.mjs'],
              extensions: ['.fake'],
            },
          },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    await notifyLspDocument('test/fixtures/sample.fake', 'open', 'let x = 1\n');
    assert.ok(getLspDocumentSyncForTest('test/fixtures/sample.fake'));

    const putRes = await httpPut(baseUrl, '/api/config/lsp', { enabled: true });
    assert.equal(putRes.status, 200);
    assert.equal(getLspDocumentSyncForTest('test/fixtures/sample.fake'), null);

    process.env.MINNOW_HOME = homeDir;
    resetMinnowHomeCache();
    invalidateLspConfigCache();
  });
});

describe('GET /api/config/lsp through config + LSP middleware stack', () => {
  let homeDir;
  let server;
  let baseUrl;

  before(async () => {
    homeDir = path.join(__dirname, '../fixtures/lsp-config-stack-home');
    process.env.MINNOW_HOME = homeDir;
    resetMinnowHomeCache();
    invalidateLspConfigCache();
    shutdownAllLsp();
    await fs.rm(homeDir, { recursive: true, force: true });
    await fs.mkdir(homeDir, { recursive: true });

    const lspMiddleware = createLspMiddleware(PROJECT_ROOT);
    server = createServer((req, res) => {
      const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      void handleConfigRequest(req, res, pathname).then((configHandled) => {
        if (configHandled) return;
        void lspMiddleware(req, res, () => {
          res.statusCode = 404;
          res.end('not found');
        });
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    shutdownAllLsp();
    delete process.env.MINNOW_HOME;
    resetMinnowHomeCache();
    invalidateLspConfigCache();
    if (homeDir) {
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });

  test('config middleware does not 404 before LSP handler runs', async () => {
    const res = await httpGet(baseUrl, '/api/config/lsp');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.json.servers));
    assert.ok(res.json.servers.length > 0);
  });
});
