/**
 * SPA navigation detection must not swallow Vite dev module paths.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { createSpaAuthHtmlMiddleware, isHtmlNavigationRequest } from '../../server/runtime/spa-auth-html.js';

function navReq(url, accept = '*/*', method = 'GET') {
  return { method, url, headers: { accept } };
}

describe('isHtmlNavigationRequest', () => {
  test('treats extensionless app routes as HTML navigations', () => {
    assert.equal(isHtmlNavigationRequest(navReq('/settings/general')), true);
    assert.equal(isHtmlNavigationRequest(navReq('/', 'text/html,application/xhtml+xml')), true);
  });

  test('skips Vite dev internal paths without file extensions', () => {
    assert.equal(isHtmlNavigationRequest(navReq('/@vite/client')), false);
    assert.equal(isHtmlNavigationRequest(navReq('/@vite/env')), false);
    assert.equal(isHtmlNavigationRequest(navReq('/@fs/C:/repo/src/main.ts')), false);
    assert.equal(isHtmlNavigationRequest(navReq('/@id/__x00__virtual:module')), false);
  });

  test('skips module and asset paths', () => {
    assert.equal(isHtmlNavigationRequest(navReq('/src/main.ts')), false);
    assert.equal(isHtmlNavigationRequest(navReq('/node_modules/.vite/deps/vue.js')), false);
    assert.equal(isHtmlNavigationRequest(navReq('/api/config/ping')), false);
  });
});

test('HTML middleware does not inject a host credential for a LAN peer with a loopback Host', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-spa-auth-'));
  const indexPath = path.join(dir, 'index.html');
  await fs.writeFile(indexPath, '<html><head></head><body></body></html>');
  try {
    const middleware = createSpaAuthHtmlMiddleware({ indexPath });
    const req = {
      method: 'GET', url: '/', headers: { host: '127.0.0.1:9473', accept: 'text/html' },
      socket: { remoteAddress: '192.168.1.20' },
    };
    const res = {
      setHeader() {},
      end(body) { this.body = body; },
    };
    await middleware(req, res, (error) => { throw error ?? new Error('Unexpected next'); });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.includes('__MINNOW_SESSION_TOKEN__'), false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
