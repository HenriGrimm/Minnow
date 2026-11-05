/**
 * Central /api/* auth gate — Host validation, session token, no CORS (MIN-381).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { createAuthMiddleware } from '../../server/runtime/auth-middleware.js';
import { getSessionToken, resetSessionTokenCache } from '../../server/runtime/session-token.js';
import { initNetworkAccess } from '../../server/network/access.js';

let homeDir;

function setTestHome(networkAccess = {}) {
  resetMinnowHomeCache();
  resetSessionTokenCache();
  homeDir = path.join(
    '/tmp',
    `minnow-auth-mw-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  process.env.MINNOW_HOME = homeDir;
  initNetworkAccess(networkAccess);
}

async function rmTestHome() {
  resetMinnowHomeCache();
  resetSessionTokenCache();
  delete process.env.MINNOW_HOME;
  try {
    await fs.rm(homeDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function mockRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    ended: false,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    getHeader(name) {
      return this.headers[name.toLowerCase()];
    },
    end(chunk) {
      this.body = chunk ?? '';
      this.ended = true;
    },
  };
}

function mockReq({ url = '/api/tools', method = 'POST', host = 'localhost:9473', token } = {}) {
  const headers = { host };
  if (token) headers['x-minnow-token'] = token;
  return { url, method, headers };
}

function runMiddleware(mw, req, res) {
  let nextCalled = false;
  mw(req, res, () => {
    nextCalled = true;
  });
  return nextCalled;
}

describe('createAuthMiddleware', () => {
  beforeEach(() => setTestHome());
  afterEach(() => rmTestHome());

  test('rejects /api/* with no token: 401, downstream never runs', () => {
    const res = mockRes();
    const nextCalled = runMiddleware(createAuthMiddleware(), mockReq({}), res);
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
  });

  test('rejects a wrong token', () => {
    getSessionToken();
    const res = mockRes();
    const nextCalled = runMiddleware(
      createAuthMiddleware(),
      mockReq({ token: 'wrong-token-value-not-matching' }),
      res,
    );
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
  });

  test('allows the correct token via header', () => {
    const token = getSessionToken();
    const res = mockRes();
    const nextCalled = runMiddleware(createAuthMiddleware(), mockReq({ token }), res);
    assert.equal(nextCalled, true);
    assert.equal(res.ended, false);
  });

  test('allows the correct token via query string (for SSE/WS/uploads)', () => {
    const token = getSessionToken();
    const res = mockRes();
    const req = mockReq({ url: `/api/tools?token=${encodeURIComponent(token)}` });
    const nextCalled = runMiddleware(createAuthMiddleware(), req, res);
    assert.equal(nextCalled, true);
  });

  test('rejects an unexpected Host header (DNS rebinding)', () => {
    const token = getSessionToken();
    const res = mockRes();
    const nextCalled = runMiddleware(
      createAuthMiddleware(),
      mockReq({ host: 'evil.example:9473', token }),
      res,
    );
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
  });

  test('rejects a rebound desktop Host before serving non-API files or SPA routes', () => {
    for (const url of ['/@fs/project/private.txt?raw', '/src/notes.txt?raw', '/']) {
      const res = mockRes();
      assert.equal(runMiddleware(createAuthMiddleware(), mockReq({ url, host: 'custom.example:9473' }), res), false);
      assert.equal(res.statusCode, 403);
      assert.equal(runMiddleware(createAuthMiddleware(), mockReq({ url }), mockRes()), true);
    }
  });

  test('allows loopback Host variants', () => {
    const token = getSessionToken();
    for (const host of ['localhost:9473', '127.0.0.1:9473', '[::1]:9473']) {
      const res = mockRes();
      const nextCalled = runMiddleware(createAuthMiddleware(), mockReq({ host, token }), res);
      assert.equal(nextCalled, true, `expected host ${host} to be allowed`);
    }
  });

  test('OPTIONS is answered with 204 and needs no token', () => {
    const res = mockRes();
    const nextCalled = runMiddleware(createAuthMiddleware(), mockReq({ method: 'OPTIONS' }), res);
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 204);
  });

  test('never emits an Access-Control-Allow-Origin header, authorized or not', () => {
    const token = getSessionToken();
    for (const req of [mockReq({}), mockReq({ token }), mockReq({ method: 'OPTIONS' })]) {
      const res = mockRes();
      runMiddleware(createAuthMiddleware(), req, res);
      assert.equal(res.headers['access-control-allow-origin'], undefined);
    }
  });

  test('non-/api/ paths pass straight through unauthenticated', () => {
    const res = mockRes();
    const nextCalled = runMiddleware(createAuthMiddleware(), mockReq({ url: '/index.html' }), res);
    assert.equal(nextCalled, true);
  });
});
