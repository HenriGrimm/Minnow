/**
 * Pairing v2 over real listeners: approve-on-host requests, Funnel gating,
 * Home Screen handoff through the manifest and the start URL.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { addCredential, createDevice, listDevices, authenticateDeviceToken } from '../../server/auth/device-store.js';
import { createConnectSession } from '../../server/auth/pairing.js';
import { resetHandoffState } from '../../server/auth/handoff.js';
import { resetDeviceStoreCache } from '../../server/auth/device-store.js';
import { createIngressServer } from '../../server/network/ingress.js';
import { setActiveNetworkAccess, setTailnetHostnames } from '../../server/network/access.js';
import { getSessionToken } from '../../server/runtime/session-token.js';
import { createTestApp, rawRequest, useScratchHome } from './helpers.mjs';

const TAILNET_HOST = 'minnow-mac.tail1.ts.net';

describe('pairing v2', () => {
  let scratch;
  const servers = [];
  let lanPort;
  let funnelPort;
  let desktopPort;

  beforeEach(async () => {
    scratch = await useScratchHome('minnow-pairing');
    const app = await createTestApp(scratch.home);
    const listen = async (kind) => {
      const server = createIngressServer(kind, app);
      servers.push(server);
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      return server.address().port;
    };
    lanPort = await listen('lan');
    funnelPort = await listen('funnel');
    desktopPort = await listen('loopback');
    setActiveNetworkAccess('lan');
    setTailnetHostnames([TAILNET_HOST]);
  });

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    setTailnetHostnames([]);
    await scratch.cleanup();
  });

  const lan = (opts) => rawRequest(lanPort, { ...opts, headers: { Host: `127.0.0.1:${lanPort}`, ...(opts.headers ?? {}) } });
  const funnel = (opts) => rawRequest(funnelPort, { ...opts, headers: { Host: TAILNET_HOST, ...(opts.headers ?? {}) } });
  const host = (opts) =>
    rawRequest(desktopPort, { ...opts, headers: { Host: 'localhost', 'X-Minnow-Token': getSessionToken(), ...(opts.headers ?? {}) } });

  test('request access → approve on host → the phone picks up its cookie once', async () => {
    const created = await lan({ method: 'POST', path: '/api/auth/requests', body: { name: 'Henri phone' } });
    assert.equal(created.status, 201);
    const { id, secret, verifyCode } = created.json();
    assert.match(verifyCode, /^\d{4}$/);

    const pending = (await host({ path: '/api/auth/requests' })).json().requests;
    assert.deepEqual(pending.map((r) => [r.id, r.verifyCode, r.name]), [[id, verifyCode, 'Henri phone']]);

    const waiting = await lan({ path: `/api/auth/requests/${id}`, headers: { 'X-Minnow-Request-Secret': secret } });
    assert.equal(waiting.json().status, 'pending');

    assert.equal((await host({ method: 'POST', path: `/api/auth/requests/${id}/approve`, body: {} })).status, 200);
    const approved = await lan({ path: `/api/auth/requests/${id}`, headers: { 'X-Minnow-Request-Secret': secret } });
    assert.equal(approved.json().status, 'approved');
    assert.ok(authenticateDeviceToken(approved.cookie));
    assert.equal(approved.text.includes('minnow_device_'), false);

    const again = await lan({ path: `/api/auth/requests/${id}`, headers: { 'X-Minnow-Request-Secret': secret } });
    assert.equal(again.json().status, 'approved');
    assert.equal(again.cookie, '');

    const wrongSecret = await lan({ path: `/api/auth/requests/${id}`, headers: { 'X-Minnow-Request-Secret': 'nope' } });
    assert.equal(wrongSecret.json().status, 'expired');
  });

  test('approving as an existing device adds a login instead of a duplicate', async () => {
    const { device } = createDevice({ name: 'iPhone', kind: 'phone' });
    addCredential(device.id);
    const { id, secret } = (await lan({ method: 'POST', path: '/api/auth/requests', body: { installed: true } })).json();
    await host({ method: 'POST', path: `/api/auth/requests/${id}/approve`, body: { attachToDeviceId: device.id } });
    const approved = await lan({ path: `/api/auth/requests/${id}`, headers: { 'X-Minnow-Request-Secret': secret } });
    assert.equal(authenticateDeviceToken(approved.cookie)?.deviceId, device.id);
    assert.equal(listDevices().length, 1);
    assert.deepEqual(listDevices()[0].credentials.map((c) => c.label), ['browser', 'home-screen']);
  });

  test('at most five requests wait at once', async () => {
    for (let i = 0; i < 5; i += 1) {
      assert.equal((await lan({ method: 'POST', path: '/api/auth/requests', body: {} })).status, 201);
    }
    const sixth = await lan({ method: 'POST', path: '/api/auth/requests', body: {} });
    assert.equal(sixth.status, 429);
  });

  test('on Funnel, requests open only with a pairing window and codes never work', async () => {
    const closed = await funnel({ method: 'POST', path: '/api/auth/requests', body: {} });
    assert.equal(closed.status, 403);
    assert.equal(closed.json().code, 'requests_closed');
    const anonymousInfo = (await funnel({ path: '/api/auth/host-info' })).json();
    assert.equal(anonymousInfo.hostName, 'Minnow');
    assert.equal(anonymousInfo.codeEntry, false);
    assert.equal(anonymousInfo.requestsOpen, false);

    const session = createConnectSession();
    assert.equal((await funnel({ method: 'POST', path: '/api/auth/requests', body: {} })).status, 201);
    const code = await funnel({ method: 'POST', path: '/api/auth/claim', body: { code: session.code } });
    assert.equal(code.status, 403);
    const ticket = await funnel({ method: 'POST', path: '/api/auth/claim', body: { ticket: session.ticket } });
    assert.equal(ticket.status, 200);
    assert.match(String(ticket.headers['set-cookie']), /Secure/);
    assert.equal(ticket.headers['strict-transport-security'], 'max-age=31536000');
    assert.equal(ticket.headers['x-frame-options'], 'DENY');
  });

  test('the host token is refused through Funnel', async () => {
    const res = await funnel({ path: '/api/auth/devices', headers: { 'X-Minnow-Token': getSessionToken() } });
    assert.equal(res.status, 401);
  });

  test('Home Screen handoff: manifest start URL signs the app in on the same device', async () => {
    const session = createConnectSession();
    const browser = await lan({ method: 'POST', path: '/api/auth/claim', body: { ticket: session.ticket } });
    const browserCookie = `minnow_device=${encodeURIComponent(browser.cookie)}`;
    const deviceId = authenticateDeviceToken(browser.cookie)?.deviceId;

    const page = await lan({ path: '/', headers: { Accept: 'text/html', Cookie: browserCookie } });
    const manifestHref = /<link rel="manifest" href="([^"]+)"/.exec(page.text)?.[1] ?? '';
    assert.match(manifestHref, /^\/api\/auth\/manifest\?handoff=[A-Za-z0-9_-]{32}$/);
    const anonymousPage = await lan({ path: '/', headers: { Accept: 'text/html' } });
    assert.match(anonymousPage.text, /<link rel="manifest" href="\/manifest\.json">/);

    const manifest = (await lan({ path: manifestHref })).json();
    assert.match(manifest.start_url, /^\/\?handoff=/);
    assert.equal(JSON.stringify(manifest).includes('minnow_device_'), false);

    // iOS gives the installed app an empty cookie jar; a host restart in between is fine.
    resetHandoffState();
    resetDeviceStoreCache();
    const launch = await lan({ path: manifest.start_url, headers: { Accept: 'text/html' } });
    assert.equal(launch.status, 303);
    assert.equal(launch.headers.location, '/');
    assert.equal(authenticateDeviceToken(launch.cookie)?.deviceId, deviceId);
    assert.equal(listDevices().length, 1);

    // Every later launch reuses the same start URL: silent with a cookie…
    const relaunch = await lan({
      path: manifest.start_url,
      headers: { Accept: 'text/html', Cookie: `minnow_device=${encodeURIComponent(launch.cookie)}` },
    });
    assert.equal(relaunch.status, 303);
    assert.equal(relaunch.headers.location, '/');
    // …and a helpful fallback without one.
    const lost = await lan({ path: manifest.start_url, headers: { Accept: 'text/html' } });
    assert.equal(lost.headers.location, '/connect?reason=handoff-expired');
  });

  test('a move ticket carries the device to another address', async () => {
    const session = createConnectSession();
    const browser = await lan({ method: 'POST', path: '/api/auth/claim', body: { ticket: session.ticket } });
    const created = await lan({
      method: 'POST',
      path: '/api/auth/handoff',
      body: { purpose: 'move' },
      headers: { Cookie: `minnow_device=${encodeURIComponent(browser.cookie)}`, Origin: `http://127.0.0.1:${lanPort}` },
    });
    assert.equal(created.status, 201);
    const moved = await funnel({ path: `/?handoff=${created.json().ticket}`, headers: { Accept: 'text/html' } });
    assert.equal(moved.status, 303);
    assert.match(String(moved.headers['set-cookie']), /Secure/);
    assert.equal(authenticateDeviceToken(moved.cookie)?.deviceId, authenticateDeviceToken(browser.cookie)?.deviceId);
    assert.equal(listDevices()[0].credentials.at(-1).label, 'other-origin');
  });
});
