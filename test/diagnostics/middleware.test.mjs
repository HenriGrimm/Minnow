/**
 * Diagnostics API middleware tests.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { request as httpRequestNode } from 'node:http';
import { fileURLToPath } from 'node:url';
import { handleDiagnosticsRequest } from '../../server/diagnostics/middleware.js';
import { appendDiagnosticEntry } from '../../server/diagnostics/ring-log.js';

function httpRequest(baseUrl, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, baseUrl);
    const payload = body ? JSON.stringify(body) : undefined;
    const r = httpRequestNode(
      url,
      {
        method,
        headers: body ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) } : {},
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
          resolve({ status: res.statusCode, body: raw, json });
        });
      },
    );
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

async function startDiagnosticsServer() {
  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    const handled = await handleDiagnosticsRequest(req, res, pathname);
    if (!handled) {
      res.statusCode = 404;
      res.end('not found');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

describe('diagnostics middleware', () => {
  let testHome;
  let server;
  let baseUrl;

  before(async () => {
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-diag-api-'));
    process.env.MINNOW_HOME = testHome;
    await appendDiagnosticEntry({
      kind: 'uncaughtException',
      message: 'test server crash',
      stack: 'Error: test\n    at Object.<anonymous>',
      source: 'server',
    });
    ({ server, baseUrl } = await startDiagnosticsServer());
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    delete process.env.MINNOW_HOME;
    await fs.rm(testHome, { recursive: true, force: true });
  });

  test('GET /api/diagnostics/ping', async () => {
    const res = await httpRequest(baseUrl, 'GET', '/api/diagnostics/ping');
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
  });

  test('GET /api/diagnostics/errors returns grouped errors', async () => {
    const res = await httpRequest(baseUrl, 'GET', '/api/diagnostics/errors?source=server');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.json.errors));
    assert.ok(res.json.errors.length >= 1);
  });

  test('POST /api/diagnostics/report captures renderer errors', async () => {
    const res = await httpRequest(baseUrl, 'POST', '/api/diagnostics/report', {
      kind: 'uncaught-error',
      message: 'renderer blew up',
      stack: 'Error: renderer\n    at app.ts:1',
      surface: '#/code',
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
  });

  test('GET /api/diagnostics/report returns redacted markdown', async () => {
    const home = os.homedir();
    if (home) {
      await appendDiagnosticEntry({
        kind: 'uncaught-error',
        message: `secret path ${home}/.minnow/.key`,
        source: 'renderer',
      });
    }
    const res = await httpRequest(baseUrl, 'GET', '/api/diagnostics/report');
    assert.equal(res.status, 200);
    assert.ok(typeof res.json.markdown === 'string');
    if (home) {
      assert.ok(!res.json.markdown.includes(home), 'markdown must redact home paths');
      assert.ok(!res.json.markdown.includes(`${home}/.minnow/.key`), 'sensitive path should be redacted');
    }
  });

  test('POST /api/diagnostics/clear removes stored errors', async () => {
    const before = await httpRequest(baseUrl, 'GET', '/api/diagnostics/errors');
    assert.ok(before.json.errors.length >= 1);

    const cleared = await httpRequest(baseUrl, 'POST', '/api/diagnostics/clear');
    assert.equal(cleared.status, 200);
    assert.equal(cleared.json.ok, true);

    const after = await httpRequest(baseUrl, 'GET', '/api/diagnostics/errors');
    assert.equal(after.status, 200);
    assert.equal(after.json.errors.length, 0);
  });

  test('GET /api/diagnostics/health reports package.json version', async () => {
    const pkg = JSON.parse(
      await fs.readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'), 'utf8'),
    );
    const res = await httpRequest(baseUrl, 'GET', '/api/diagnostics/health');
    assert.equal(res.status, 200);
    assert.equal(res.json.version, pkg.version);
  });

  test('GET /api/diagnostics/health marks idle on-demand LSP as ok', async () => {
    const res = await httpRequest(baseUrl, 'GET', '/api/diagnostics/health');
    assert.equal(res.status, 200);
    assert.equal(res.json.components.lsp.ok, true);
    assert.equal(typeof res.json.components.lsp.running, 'number');
  });
});
