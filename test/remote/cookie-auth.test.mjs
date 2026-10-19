/**
 * Device cookie authentication and same-origin enforcement, over real sockets.
 * Cookies are shared across ports on one host, so a page from another program
 * on the same IP must not be able to use a phone's Minnow cookie.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';
import WebSocket from 'ws';
import { addCredential, createDevice, revokeDevice } from '../../server/auth/device-store.js';
import { createIngressServer } from '../../server/network/ingress.js';
import { setActiveNetworkAccess } from '../../server/network/access.js';
import { attachMinnowWebSockets } from '../../server/runtime/ws-attach.js';
import { createTestApp, useScratchHome } from './helpers.mjs';

describe('device cookie on the home network', () => {
  let scratch;
  let server;
  let base;
  let token;
  let deviceId;

  beforeEach(async () => {
    scratch = await useScratchHome('minnow-cookie');
    const app = await createTestApp(scratch.home);
    server = createIngressServer('lan', app);
    attachMinnowWebSockets(server);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    setActiveNetworkAccess('lan');
    const { device } = createDevice({ name: 'Phone' });
    deviceId = device.id;
    token = addCredential(device.id).token;
  });

  afterEach(async () => {
    mock.timers.reset();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await scratch.cleanup();
  });

  const cookie = () => `minnow_device=${encodeURIComponent(token)}`;

  test('a same-origin GET authenticates with the cookie alone', async () => {
    const res = await fetch(`${base}/api/echo`, { headers: { Cookie: cookie(), 'Sec-Fetch-Site': 'same-origin' } });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).auth.deviceId, deviceId);
  });

  test('cross-site reads with the cookie are refused', async () => {
    const res = await fetch(`${base}/api/echo`, { headers: { Cookie: cookie(), 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(res.status, 403);
  });

  test('writes need an Origin from this exact listener', async () => {
    const foreign = await fetch(`${base}/api/echo`, {
      method: 'POST',
      headers: { Cookie: cookie(), Origin: 'http://127.0.0.1:1234' },
    });
    assert.equal(foreign.status, 403);
    const missing = await fetch(`${base}/api/echo`, { method: 'POST', headers: { Cookie: cookie() } });
    assert.equal(missing.status, 403);
    const own = await fetch(`${base}/api/echo`, { method: 'POST', headers: { Cookie: cookie(), Origin: base } });
    assert.equal(own.status, 200);
  });

  test('a revoked cookie gets 401 and is cleared', async () => {
    revokeDevice(deviceId);
    const res = await fetch(`${base}/api/auth/session`, { headers: { Cookie: cookie() } });
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('x-minnow-auth'), 'required');
    assert.match(res.headers.getSetCookie().join('\n'), /minnow_device=;.*Max-Age=0/);
  });

  test('the cookie is refreshed on first use and again after a day', async () => {
    mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const first = await fetch(`${base}/api/echo`, { headers: { Cookie: cookie() } });
    assert.match(first.headers.getSetCookie().join('\n'), /minnow_device=.*HttpOnly/);
    const second = await fetch(`${base}/api/echo`, { headers: { Cookie: cookie() } });
    assert.equal(second.headers.getSetCookie().length, 0);
    mock.timers.tick(25 * 60 * 60 * 1000);
    const later = await fetch(`${base}/api/echo`, { headers: { Cookie: cookie() } });
    assert.match(later.headers.getSetCookie().join('\n'), /minnow_device=/);
  });

  test('WebSocket upgrades with the cookie require this origin', async () => {
    const attempt = (origin) =>
      new Promise((resolve) => {
        const ws = new WebSocket(`${base.replace('http', 'ws')}/api/agents/ws`, { headers: { Cookie: cookie() }, origin });
        ws.on('unexpected-response', (_req, res) => {
          resolve(res.statusCode);
          ws.terminate();
        });
        ws.on('open', () => {
          resolve(101);
          ws.close();
        });
        ws.on('error', () => {});
      });
    assert.equal(await attempt('http://127.0.0.1:1234'), 403);
    // Authorized: the agents socket then rejects the missing runId with 400.
    assert.equal(await attempt(base), 400);
  });
});
