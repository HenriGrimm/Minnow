/**
 * Built-in Tailscale supervision against the fake sidecar: status machine,
 * trusted-listener secret, Funnel restrictions, logout, missing binary.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { createConnectSession } from '../../server/auth/pairing.js';
import {
  configureRemoteIngress,
  getConnectTargets,
  getRemoteStatus,
  logoutAnywhere,
  setAnywhereEnabled,
  shutdownRemoteIngress,
} from '../../server/remote/ingress-manager.js';
import { resetTailnetState, tailnetStateDir } from '../../server/remote/tailnet.js';
import { getSessionToken } from '../../server/runtime/session-token.js';
import { createTestApp, rawRequest, useScratchHome } from './helpers.mjs';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'remote', 'fake-tailnet-sidecar.mjs');
const DNS = 'minnow-test.tail1.ts.net';

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out; status: ${JSON.stringify(getRemoteStatus().anywhere)}`);
}

describe('built-in Tailscale node', () => {
  let scratch;
  let portFile;

  beforeEach(async () => {
    scratch = await useScratchHome('minnow-tailnet');
    resetTailnetState();
    configureRemoteIngress({ requestHandler: await createTestApp(scratch.home) });
    portFile = path.join(scratch.home, 'fake-port');
    process.env.MINNOW_TAILNET_BIN = FAKE;
    process.env.FAKE_TAILNET_PORT_FILE = portFile;
    delete process.env.FAKE_TAILNET_MODE;
  });

  afterEach(async () => {
    await shutdownRemoteIngress();
    for (const key of ['MINNOW_TAILNET_BIN', 'FAKE_TAILNET_PORT_FILE', 'FAKE_TAILNET_MODE']) delete process.env[key];
    await scratch.cleanup();
  });

  const proxyPort = () => Number(fs.readFileSync(portFile, 'utf8'));
  const viaTailnet = (opts) => rawRequest(proxyPort(), { ...opts, headers: { Host: DNS, ...(opts.headers ?? {}) } });

  test('walks to ready and serves the app through the proxy as Funnel ingress', async () => {
    await setAnywhereEnabled(true);
    const ready = await waitFor(() => getRemoteStatus().anywhere.state === 'ready' && getRemoteStatus().anywhere);
    assert.equal(ready.dnsName, DNS);
    assert.equal(ready.url, `https://${DNS}/`);
    assert.equal(ready.funnel, true);
    assert.equal(getConnectTargets()[0].kind, 'anywhere');

    const info = await viaTailnet({ path: '/api/auth/host-info' });
    assert.equal(info.status, 200);
    assert.equal(info.json().ingress, 'funnel');

    const hostToken = await viaTailnet({ path: '/api/auth/devices', headers: { 'X-Minnow-Token': getSessionToken() } });
    assert.equal(hostToken.status, 401);
  });

  test('the trusted listener refuses anything without the per-boot secret', async () => {
    await setAnywhereEnabled(true);
    await waitFor(() => getRemoteStatus().anywhere.state === 'ready');
    const { target } = JSON.parse(fs.readFileSync(path.join(tailnetStateDir(), 'fake-node.json'), 'utf8'));
    const direct = await rawRequest(Number(new URL(target).port), {
      path: '/api/auth/host-info',
      headers: { Host: DNS, 'X-Minnow-Ingress': 'tailnet', 'X-Minnow-Ingress-Secret': 'guess' },
    });
    assert.equal(direct.status, 403);
  });

  test('Funnel requests open with a pairing window; codes stay off', async () => {
    await setAnywhereEnabled(true);
    await waitFor(() => getRemoteStatus().anywhere.state === 'ready');
    assert.equal((await viaTailnet({ method: 'POST', path: '/api/auth/requests', body: {} })).status, 403);
    const session = createConnectSession();
    assert.equal((await viaTailnet({ method: 'POST', path: '/api/auth/requests', body: {} })).status, 201);
    assert.equal((await viaTailnet({ method: 'POST', path: '/api/auth/claim', body: { code: session.code } })).status, 403);
    const claimed = await viaTailnet({ method: 'POST', path: '/api/auth/claim', body: { ticket: session.ticket } });
    assert.equal(claimed.status, 200);
    const echo = await viaTailnet({
      path: '/api/echo',
      headers: { Cookie: `minnow_device=${encodeURIComponent(claimed.cookie)}`, 'Sec-Fetch-Site': 'same-origin' },
    });
    assert.equal(echo.json().auth.kind, 'device');
  });

  test('reports sign-in and approval steps', async () => {
    process.env.FAKE_TAILNET_MODE = 'login';
    await setAnywhereEnabled(true);
    const login = await waitFor(() => getRemoteStatus().anywhere.state === 'needs-login' && getRemoteStatus().anywhere);
    assert.equal(login.authUrl, 'https://login.tailscale.com/a/fake');

    process.env.FAKE_TAILNET_MODE = 'approval';
    await setAnywhereEnabled(false);
    await setAnywhereEnabled(true);
    const approval = await waitFor(() => getRemoteStatus().anywhere.state === 'needs-approval' && getRemoteStatus().anywhere);
    assert.equal(approval.feature, 'funnel');

    process.env.FAKE_TAILNET_MODE = 'device-approval';
    await setAnywhereEnabled(false);
    await setAnywhereEnabled(true);
    const device = await waitFor(() => getRemoteStatus().anywhere.state === 'needs-approval' && getRemoteStatus().anywhere);
    assert.equal(device.feature, 'device');
    assert.equal(device.url, 'https://login.tailscale.com/admin/machines');
  });

  test('a crashing helper is reported and restarted', async () => {
    process.env.FAKE_TAILNET_MODE = 'crash';
    await setAnywhereEnabled(true);
    const failed = await waitFor(() => getRemoteStatus().anywhere.state === 'error' && getRemoteStatus().anywhere);
    assert.equal(failed.code, 'helper-exited');
    delete process.env.FAKE_TAILNET_MODE;
    await waitFor(() => getRemoteStatus().anywhere.state === 'ready', 4_000);
  });

  test('sign out deletes the node identity', async () => {
    await setAnywhereEnabled(true);
    await waitFor(() => getRemoteStatus().anywhere.state === 'ready');
    assert.ok(fs.existsSync(tailnetStateDir()));
    await logoutAnywhere();
    assert.equal(fs.existsSync(tailnetStateDir()), false);
    assert.equal(getRemoteStatus().anywhere.state, 'off');
  });

  test('a build without the helper reports unavailable', async () => {
    process.env.MINNOW_TAILNET_BIN = path.join(scratch.home, 'missing.mjs');
    const status = await setAnywhereEnabled(true);
    assert.equal(status.anywhere.state, 'unavailable');
  });
});
