/**
 * Ingress tagging: the host credential works only on the loopback desktop
 * listener, and the home-network Host allowlist follows network changes.
 */

import assert from 'node:assert/strict';
import os from 'node:os';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';
import { createIngressServer, getRequestIngress } from '../../server/network/ingress.js';
import {
  isHostAllowedForIngress,
  resetOwnLanHostnamesCache,
  setActiveNetworkAccess,
  setTailnetHostnames,
} from '../../server/network/access.js';
import { getSessionToken } from '../../server/runtime/session-token.js';
import { createTestApp, useScratchHome } from './helpers.mjs';

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

describe('ingress tagging', () => {
  let scratch;
  const servers = [];
  beforeEach(async () => {
    scratch = await useScratchHome();
  });
  afterEach(async () => {
    for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
    await scratch.cleanup();
  });

  test('the host token authenticates on the loopback listener only', async () => {
    const app = await createTestApp(scratch.home);
    const desktop = createIngressServer('loopback', app);
    const lan = createIngressServer('lan', app);
    servers.push(desktop, lan);
    const desktopPort = await listen(desktop);
    const lanPort = await listen(lan);
    setActiveNetworkAccess('lan');
    const headers = { 'X-Minnow-Token': getSessionToken() };

    const onDesktop = await fetch(`http://127.0.0.1:${desktopPort}/api/echo`, { headers });
    assert.equal(onDesktop.status, 200);
    assert.deepEqual((await onDesktop.json()).auth, { kind: 'host' });

    const onLan = await fetch(`http://127.0.0.1:${lanPort}/api/echo`, { headers });
    assert.equal(onLan.status, 401);
  });

  test('pages on a remote listener never embed the host token', async () => {
    const app = await createTestApp(scratch.home);
    const lan = createIngressServer('lan', app);
    servers.push(lan);
    const port = await listen(lan);
    setActiveNetworkAccess('lan');
    const html = await (await fetch(`http://127.0.0.1:${port}/`, { headers: { Accept: 'text/html' } })).text();
    assert.equal(html.includes(getSessionToken()), false);
  });

  test('a home-network socket kept alive past switching it off is refused', async () => {
    const app = await createTestApp(scratch.home);
    const lan = createIngressServer('lan', app);
    servers.push(lan);
    const port = await listen(lan);
    setActiveNetworkAccess('local');
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/host-info`);
    assert.equal(res.status, 403);
  });

  test('untagged sockets fall back to the peer address and are never more trusted', () => {
    assert.equal(getRequestIngress({ socket: { remoteAddress: '127.0.0.1' } }), 'loopback');
    assert.equal(getRequestIngress({ socket: { remoteAddress: '192.168.1.9' } }), 'lan');
  });
});

describe('host allowlist', () => {
  afterEach(() => {
    mock.restoreAll();
    mock.timers.reset();
    resetOwnLanHostnamesCache();
    setTailnetHostnames([]);
  });

  test('follows a DHCP address change without a restart', () => {
    let address = '192.168.1.40';
    mock.method(os, 'networkInterfaces', () => ({
      en0: [{ address, family: 'IPv4', internal: false }],
    }));
    mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
    resetOwnLanHostnamesCache();
    assert.equal(isHostAllowedForIngress('192.168.1.40:9480', 'lan'), true);
    assert.equal(isHostAllowedForIngress('192.168.1.77:9480', 'lan'), false);

    address = '192.168.1.77';
    mock.timers.tick(11_000);
    assert.equal(isHostAllowedForIngress('192.168.1.77:9480', 'lan'), true);
    assert.equal(isHostAllowedForIngress('192.168.1.40:9480', 'lan'), false);
  });

  test('each ingress accepts only its own names', () => {
    setTailnetHostnames(['minnow-mac.tail1.ts.net.']);
    assert.equal(isHostAllowedForIngress('localhost:9473', 'loopback'), true);
    assert.equal(isHostAllowedForIngress('minnow-mac.tail1.ts.net', 'loopback'), false);
    assert.equal(isHostAllowedForIngress('minnow-mac.tail1.ts.net', 'funnel'), true);
    assert.equal(isHostAllowedForIngress('minnow-mac.tail1.ts.net', 'tailnet'), true);
    assert.equal(isHostAllowedForIngress('localhost:9473', 'funnel'), false);
    assert.equal(isHostAllowedForIngress('evil.ts.net', 'funnel'), false);
    assert.equal(isHostAllowedForIngress(`${os.hostname().replace(/\.local$/i, '')}.local:9480`.toLowerCase(), 'lan'), true);
  });
});
