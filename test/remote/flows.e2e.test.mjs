/**
 * End-to-end device flows through the real remote listeners: the home-network
 * listener and the trusted tailnet listener behind the fake Tailscale helper.
 * One phone, its Home Screen app, a host restart, a move to Anywhere, a revoke.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { listDevices } from '../../server/auth/device-store.js';
import { resetDeviceStoreCache } from '../../server/auth/device-store.js';
import { resetHandoffState } from '../../server/auth/handoff.js';
import { resetDeviceCookieState } from '../../server/auth/cookie.js';
import {
  configureRemoteIngress,
  getRemoteStatus,
  setAnywhereEnabled,
  setLanEnabled,
  shutdownRemoteIngress,
} from '../../server/remote/ingress-manager.js';
import { resetTailnetState } from '../../server/remote/tailnet.js';
import { createIngressServer } from '../../server/network/ingress.js';
import { getSessionToken, resetSessionTokenCache } from '../../server/runtime/session-token.js';
import { createTestApp, freePort, rawRequest, useScratchHome } from './helpers.mjs';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'remote', 'fake-tailnet-sidecar.mjs');
const DNS = 'minnow-test.tail1.ts.net';

/** A browser's cookie jar for one origin. */
class Jar {
  constructor(port, host) {
    this.port = port;
    this.host = host;
    this.cookie = '';
  }

  async request(opts = {}) {
    const headers = { Host: this.host, ...(opts.headers ?? {}) };
    if (this.cookie) headers.Cookie = `minnow_device=${encodeURIComponent(this.cookie)}`;
    if (opts.method && opts.method !== 'GET') headers.Origin = `${this.host.includes('ts.net') ? 'https' : 'http'}://${this.host}`;
    const res = await rawRequest(this.port, { ...opts, headers });
    const setCookie = (res.headers['set-cookie'] ?? []).join('\n');
    if (/minnow_device=;/.test(setCookie)) this.cookie = '';
    else if (res.cookie) this.cookie = res.cookie;
    return res;
  }
}

describe('remote device flows', () => {
  let scratch;
  let lanPort;
  let desktop;
  let desktopPort;
  let portFile;

  before(async () => {
    scratch = await useScratchHome('minnow-e2e');
    resetTailnetState();
    const app = await createTestApp(scratch.home);
    configureRemoteIngress({ requestHandler: app });
    desktop = createIngressServer('loopback', app);
    await new Promise((resolve) => desktop.listen(0, '127.0.0.1', resolve));
    desktopPort = desktop.address().port;
    lanPort = await freePort();
    process.env.MINNOW_LAN_PORT = String(lanPort);
    portFile = path.join(scratch.home, 'fake-port');
    process.env.MINNOW_TAILNET_BIN = FAKE;
    process.env.FAKE_TAILNET_PORT_FILE = portFile;
    process.env.FAKE_TAILNET_DNS = DNS;
  });

  after(async () => {
    await shutdownRemoteIngress();
    desktop.closeAllConnections();
    await new Promise((resolve) => desktop.close(resolve));
    for (const key of ['MINNOW_LAN_PORT', 'MINNOW_TAILNET_BIN', 'FAKE_TAILNET_PORT_FILE', 'FAKE_TAILNET_DNS']) delete process.env[key];
    await scratch.cleanup();
  });

  const host = (opts = {}) =>
    rawRequest(desktopPort, { ...opts, headers: { Host: 'localhost', 'X-Minnow-Token': getSessionToken(), ...(opts.headers ?? {}) } });

  test('one phone: connect, install, survive a restart, move to Anywhere, then revoke', async () => {
    // Home network on, live.
    assert.equal((await setLanEnabled(true)).lan.state, 'on');
    const browser = new Jar(lanPort, `127.0.0.1:${lanPort}`);

    // 1. Scan the QR: one tap connects.
    const session = (await host({ method: 'POST', path: '/api/auth/connect-sessions' })).json();
    const ticket = new URL(session.targets[0].url).hash.slice(3);
    const claimed = await browser.request({ method: 'POST', path: '/api/auth/claim', body: { ticket } });
    assert.equal(claimed.status, 200);
    assert.equal((await browser.request({ path: '/api/echo' })).json().auth.kind, 'device');

    // 2. Add to Home Screen: the app gets an empty jar and signs itself in.
    const page = await browser.request({ path: '/', headers: { Accept: 'text/html' } });
    const manifestHref = /<link rel="manifest" href="([^"]+)"/.exec(page.text)[1];
    const startUrl = (await browser.request({ path: manifestHref })).json().start_url;
    const homeScreen = new Jar(lanPort, `127.0.0.1:${lanPort}`);
    assert.equal((await homeScreen.request({ path: startUrl, headers: { Accept: 'text/html' } })).status, 303);
    assert.equal((await homeScreen.request({ path: '/api/echo' })).json().auth.kind, 'device');
    assert.equal(listDevices().length, 1, 'the Home Screen app is the same device');

    // 3. Host restart: per-boot state is gone, the home is the same.
    resetSessionTokenCache();
    resetDeviceStoreCache();
    resetHandoffState();
    resetDeviceCookieState();
    for (const jar of [browser, homeScreen]) {
      assert.equal((await jar.request({ path: '/api/auth/session' })).status, 200);
    }

    // 4. The host token is useless from the phone's side.
    const stolen = await rawRequest(lanPort, {
      path: '/api/auth/devices',
      headers: { Host: `127.0.0.1:${lanPort}`, 'X-Minnow-Token': getSessionToken() },
    });
    assert.equal(stolen.status, 401);

    // 5. Anywhere comes up; the phone moves without approving again.
    await setAnywhereEnabled(true);
    const deadline = Date.now() + 5_000;
    while (getRemoteStatus().anywhere.state !== 'ready' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(getRemoteStatus().anywhere.state, 'ready');
    const status = await browser.request({ path: '/api/remote/status' });
    assert.equal(status.json().anywhereUrl, `https://${DNS}/`);
    const move = (await browser.request({ method: 'POST', path: '/api/auth/handoff', body: { purpose: 'move' } })).json();
    const anywhere = new Jar(Number(fs.readFileSync(portFile, 'utf8')), DNS);
    assert.equal((await anywhere.request({ path: `/?handoff=${move.ticket}`, headers: { Accept: 'text/html' } })).status, 303);
    assert.equal((await anywhere.request({ path: '/api/echo', headers: { 'Sec-Fetch-Site': 'same-origin' } })).json().auth.kind, 'device');
    assert.equal(listDevices().length, 1);
    assert.equal(listDevices()[0].credentials.length, 3);

    // 6. Revoke from the host: every login of the device stops at once.
    const deviceId = listDevices()[0].id;
    assert.equal((await host({ method: 'DELETE', path: `/api/auth/devices/${deviceId}` })).status, 200);
    for (const jar of [browser, homeScreen, anywhere]) {
      const res = await jar.request({ path: '/api/auth/session', headers: { 'Sec-Fetch-Site': 'same-origin' } });
      assert.equal(res.status, 401);
      assert.equal(res.headers['x-minnow-auth'], 'required');
      assert.equal(jar.cookie, '', 'the server cleared the cookie');
    }
  });
});
