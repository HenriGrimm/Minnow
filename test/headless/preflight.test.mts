/**
 * waitForServer preflight against ephemeral config+tools ping handlers.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { ensureServer } from '../../src/headless/cli-main.ts';
import { once } from 'node:events';
import { handleConfigRequest } from '../../server/config/middleware.js';
import { waitForServer } from '../../src/headless/preflight.ts';

/** Minimal ping-only server for headless preflight tests. */
function createPingServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/api/tools/ping' && req.method === 'GET') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    void handleConfigRequest(req, res, url.pathname);
  });
}

describe('headless preflight', () => {
  let server: http.Server | null = null;
  let baseUrl = '';
  let tempHome = '';
  let previousMinnowHome: string | undefined;

  before(async () => {
    previousMinnowHome = process.env.MINNOW_HOME;
    tempHome = mkdtempSync(path.join(os.tmpdir(), 'minnow-preflight-'));
    process.env.MINNOW_HOME = tempHome;

    server = createPingServer();
    await new Promise<void>((resolve, reject) => {
      server!.listen(0, '127.0.0.1', (err?: Error) => (err ? reject(err) : resolve()));
    });
    const addr = server!.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (typeof server?.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server?.close((err) => (err ? reject(err) : resolve()));
    });
    if (tempHome) {
      rmSync(tempHome, { recursive: true, force: true });
    }
    if (previousMinnowHome === undefined) {
      delete process.env.MINNOW_HOME;
    } else {
      process.env.MINNOW_HOME = previousMinnowHome;
    }
  });

  it('a CLI startup poll uses a rotated boot token instead of capturing its stale predecessor', async () => {
    const tokenFile = path.join(tempHome, 'session-token');
    writeFileSync(tokenFile, 'old');
    const seen = new Set();
    const rotated = http.createServer((req, res) => {
      const token = req.headers['x-minnow-token'];
      seen.add(token);
      if (token === 'old') writeFileSync(tokenFile, 'new');
      res.writeHead(token === 'new' ? 200 : 401);
      res.end('{"ok":true}');
    });
    rotated.listen(0, '127.0.0.1');
    await once(rotated, 'listening');
    try {
      const addr = rotated.address() as {port: number};
      const options = { baseUrl: `http://127.0.0.1:${addr.port}`, minnowHome: tempHome,
        token: null, startServer: false, serverTimeoutSec: 1 };
      const previousToken = process.env.MINNOW_TOKEN;
      delete process.env.MINNOW_TOKEN;
      try {
        assert.equal(await ensureServer(options), null);
        assert.deepEqual([...seen], ['old', 'new']);
        seen.clear();
        writeFileSync(tokenFile, 'ignored-file-token');
        assert.equal(await ensureServer({ ...options, token: 'new' }), null);
        assert.deepEqual([...seen], ['new']);
      } finally { if (previousToken !== undefined) process.env.MINNOW_TOKEN = previousToken; }
    } finally { rotated.closeAllConnections(); rotated.close(); }
  });

  it('bounds a stalled ping body by the preflight deadline', async () => {
    const stalled = http.createServer((_req, res) => { res.writeHead(200); res.write('{'); });
    stalled.listen(0, '127.0.0.1');
    await once(stalled, 'listening');
    try {
      const addr = stalled.address() as {port: number};
      const start = Date.now();
      assert.equal(await waitForServer({ baseUrl: `http://127.0.0.1:${addr.port}`, timeoutSec: 0.05 }), false);
      assert.ok(Date.now() - start < 1000);
    } finally { stalled.closeAllConnections(); stalled.close(); }
  });

  it('waitForServer succeeds when config and tools ping respond', async () => {
    const ok = await waitForServer({ baseUrl, timeoutSec: 5 });
    assert.equal(ok, true);
  });
});
