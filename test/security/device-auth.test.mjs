/**
 * Companion devices: persistence, connect sessions, access requests, handoff,
 * request authorization, and host-only management.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import {
  addCredential,
  authenticateDeviceToken,
  createDevice,
  listDevices,
  resetDeviceStoreCache,
  revokeDevice,
} from '../../server/auth/device-store.js';
import {
  claimConnectSession,
  createConnectSession,
  CONNECT_SESSION_TTL_MS,
  getConnectSession,
  normalizePairingCode,
  PairingError,
  resetPairingState,
} from '../../server/auth/pairing.js';
import { resetAccessRequests } from '../../server/auth/requests.js';
import { resetHandoffState } from '../../server/auth/handoff.js';
import { resetDeviceCookieState } from '../../server/auth/cookie.js';
import { createAuthRoutesMiddleware } from '../../server/auth/routes.js';
import { createAuthMiddleware } from '../../server/runtime/auth-middleware.js';
import { getSessionToken, resetSessionTokenCache } from '../../server/runtime/session-token.js';
import { initNetworkAccess, setActiveNetworkAccess } from '../../server/network/access.js';

let homeDir;

function resetAll() {
  resetMinnowHomeCache();
  resetSessionTokenCache();
  resetPairingState();
  resetAccessRequests();
  resetHandoffState();
  resetDeviceStoreCache();
  resetDeviceCookieState();
}

function setTestHome() {
  resetAll();
  homeDir = path.join(
    '/tmp',
    `minnow-device-auth-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  process.env.MINNOW_HOME = homeDir;
  delete process.env.MINNOW_NETWORK;
  initNetworkAccess({});
}

async function rmTestHome() {
  resetAll();
  setActiveNetworkAccess('local');
  delete process.env.MINNOW_HOME;
  await fs.rm(homeDir, { recursive: true, force: true });
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

function mockReq({
  url = '/api/config/ping',
  method = 'GET',
  token,
  cookie,
  body,
  auth,
  remoteAddress = '127.0.0.1',
  host = 'localhost:9473',
  headers: extra = {},
} = {}) {
  const headers = { host, ...extra };
  if (token) headers['x-minnow-token'] = token;
  if (cookie) headers.cookie = `minnow_device=${encodeURIComponent(cookie)}`;
  return {
    url,
    method,
    headers,
    minnowAuth: auth,
    socket: { remoteAddress, localPort: 9473 },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body));
    },
  };
}

/** A phone on the home network, reaching this Mac by its LAN address. */
function phoneReq(opts = {}) {
  return mockReq({ remoteAddress: '192.168.1.25', host: '127.0.0.1:9480', ...opts });
}

async function runMiddleware(middleware, req) {
  const res = mockRes();
  let nextCalled = false;
  await middleware(req, res, () => {
    nextCalled = true;
  });
  return { res, nextCalled };
}

function newDevice(name = 'Phone') {
  const { device } = createDevice({ name, kind: 'phone' });
  const { token, credential } = addCredential(device.id, { label: 'browser' });
  return { token, device, credential };
}

function cookieFrom(res) {
  const header = res.headers['set-cookie'];
  const value = Array.isArray(header) ? header[0] : header;
  const match = /minnow_device=([^;]*)/.exec(String(value ?? ''));
  return match ? decodeURIComponent(match[1]) : '';
}

describe('companion device store', () => {
  beforeEach(setTestHome);
  afterEach(rmTestHome);

  test('persists a named device with only SHA-256 credential hashes', async () => {
    const { device } = createDevice({ name: '  Alice\u0000   Phone  ' });
    assert.equal(device.name, 'Alice Phone');
    const { token, credential } = addCredential(device.id, { label: 'browser' });
    assert.deepEqual(authenticateDeviceToken(token), {
      kind: 'device',
      deviceId: device.id,
      credentialId: credential.id,
      deviceName: 'Alice Phone',
    });

    const filePath = path.join(homeDir, 'auth', 'devices.json');
    const raw = await fs.readFile(filePath, 'utf8');
    const persisted = JSON.parse(raw);
    assert.equal(raw.includes(token), false);
    assert.equal(persisted.schemaVersion, 2);
    assert.match(persisted.devices[0].credentials[0].tokenHash, /^[0-9a-f]{64}$/);
    assert.equal(JSON.stringify(listDevices()).includes('tokenHash'), false);

    if (process.platform !== 'win32') {
      assert.equal((await fs.stat(path.join(homeDir, 'auth'))).mode & 0o777, 0o700);
      assert.equal((await fs.stat(filePath)).mode & 0o777, 0o600);
    }
  });

  test('revocation removes every credential of the device immediately', () => {
    const { token, device } = newDevice('Tablet');
    const second = addCredential(device.id, { label: 'home-screen' });
    assert.ok(authenticateDeviceToken(token));
    assert.ok(authenticateDeviceToken(second.token));
    assert.equal(revokeDevice(device.id), true);
    assert.equal(authenticateDeviceToken(token), null);
    assert.equal(authenticateDeviceToken(second.token), null);
    assert.deepEqual(listDevices(), []);
    assert.equal(revokeDevice(device.id), false);
  });
});

describe('connect sessions', () => {
  beforeEach(setTestHome);
  afterEach(rmTestHome);

  test('normalizes six-digit codes from spaced input', () => {
    assert.equal(normalizePairingCode('123 456'), '123456');
    assert.equal(normalizePairingCode('12345'), '');
    assert.equal(normalizePairingCode('1234567'), '');
  });

  test('a QR ticket claims once, names the device, and expires after ten minutes', () => {
    let now = 1_000;
    const session = createConnectSession({ now: () => now });
    const claimed = claimConnectSession(
      { ticket: session.ticket, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', ingress: 'lan', source: '192.168.1.20' },
      { now: () => now },
    );
    assert.equal(claimed.device.name, 'iPhone');
    assert.equal(claimed.device.kind, 'phone');
    assert.ok(authenticateDeviceToken(claimed.token));
    assert.equal(getConnectSession(session.id, { now: () => now }).status, 'claimed');
    assert.throws(
      () => claimConnectSession({ ticket: session.ticket, ingress: 'lan', source: '192.168.1.20' }, { now: () => now }),
      (err) => err instanceof PairingError && err.code === 'invalid_ticket',
    );

    const expired = createConnectSession({ now: () => now });
    now += CONNECT_SESSION_TTL_MS;
    assert.throws(
      () => claimConnectSession({ ticket: expired.ticket, ingress: 'lan', source: '192.168.1.21' }, { now: () => now }),
      (err) => err instanceof PairingError && err.code === 'invalid_ticket',
    );
  });

  test('codes work only on the home network', () => {
    const session = createConnectSession();
    for (const ingress of ['funnel', 'tailnet', 'loopback']) {
      assert.throws(
        () => claimConnectSession({ code: session.code, ingress, source: '1.2.3.4' }),
        (err) => err instanceof PairingError && err.code === 'code_entry_disabled',
      );
    }
    const claimed = claimConnectSession({ code: session.code, ingress: 'lan', source: '192.168.1.5' });
    assert.ok(authenticateDeviceToken(claimed.token));
  });

  test('throttles repeated attempts per source without consuming valid sessions', () => {
    const now = () => 10_000;
    const session = createConnectSession({ now });
    for (let i = 0; i < 10; i += 1) {
      assert.throws(
        () => claimConnectSession({ code: String(i).padStart(6, '0'), ingress: 'lan', source: '192.168.1.50' }, { now }),
        (err) => err instanceof PairingError && err.code === 'invalid_ticket',
      );
    }
    assert.throws(
      () => claimConnectSession({ code: session.code, ingress: 'lan', source: '192.168.1.50' }, { now }),
      (err) => err instanceof PairingError && err.statusCode === 429,
    );
    assert.ok(claimConnectSession({ code: session.code, ingress: 'lan', source: '192.168.1.51' }, { now }).token);
  });
});

describe('companion request authorization', () => {
  beforeEach(setTestHome);
  afterEach(rmTestHome);

  test('device session stays authorized across workspaces and host restarts', async () => {
    const { token, device } = newDevice('Phone');
    const originalHostToken = getSessionToken();
    resetSessionTokenCache();
    resetPairingState();
    assert.notEqual(getSessionToken(), originalHostToken);
    for (const workspace of ['/workspace/one', '/workspace/two']) {
      const req = mockReq({ token, url: '/api/auth/session' });
      req.headers['x-minnow-workspace'] = workspace;
      assert.equal((await runMiddleware(createAuthMiddleware(), req)).nextCalled, true);
      const { res } = await runMiddleware(createAuthRoutesMiddleware({ getHostDisplayName: () => 'Studio Mac' }), req);
      assert.equal(res.statusCode, 200);
      assert.deepEqual(JSON.parse(res.body), {
        authenticated: true,
        kind: 'device',
        device: { id: device.id, name: 'Phone' },
        hostName: 'Studio Mac',
      });
      assert.equal(res.headers['cache-control'], 'no-store');
    }
  });

  test('unreadable device registry is retryable and does not report revocation', async () => {
    const { token } = newDevice('Phone');
    const filePath = path.join(homeDir, 'auth', 'devices.json');
    const registry = await fs.readFile(filePath, 'utf8');
    await fs.writeFile(filePath, '{');
    const req = mockReq({ token, url: '/api/auth/session' });
    const { res, nextCalled } = await runMiddleware(createAuthMiddleware(), req);
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 503);
    assert.equal(res.headers['x-minnow-auth'], undefined);
    await fs.writeFile(filePath, registry);
    assert.equal((await runMiddleware(createAuthMiddleware(), req)).nextCalled, true);
  });

  test('auth context distinguishes the host session from a device', async () => {
    const hostReq = mockReq({ token: getSessionToken() });
    assert.equal((await runMiddleware(createAuthMiddleware(), hostReq)).nextCalled, true);
    assert.deepEqual(hostReq.minnowAuth, { kind: 'host' });

    const { token, device, credential } = newDevice('Phone');
    const deviceReq = mockReq({ token });
    assert.equal((await runMiddleware(createAuthMiddleware(), deviceReq)).nextCalled, true);
    assert.deepEqual(deviceReq.minnowAuth, {
      kind: 'device',
      deviceId: device.id,
      credentialId: credential.id,
      deviceName: 'Phone',
    });
  });

  test('the host token is refused on the home network', async () => {
    setActiveNetworkAccess('lan');
    const { res, nextCalled } = await runMiddleware(createAuthMiddleware(), phoneReq({ token: getSessionToken() }));
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
  });

  test('a revoked device is rejected and its cookie cleared on the next request', async () => {
    setActiveNetworkAccess('lan');
    const { token, device } = newDevice('Phone');
    const ok = await runMiddleware(createAuthMiddleware(), phoneReq({ cookie: token }));
    assert.equal(ok.nextCalled, true);
    revokeDevice(device.id);
    const { res, nextCalled } = await runMiddleware(createAuthMiddleware(), phoneReq({ cookie: token }));
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
    assert.equal(res.headers['x-minnow-auth'], 'required');
    assert.match(String(res.headers['set-cookie']), /minnow_device=;.*Max-Age=0/);
  });

  test('only the pairing bootstrap routes are unauthenticated', async () => {
    setActiveNetworkAccess('lan');
    for (const [method, url] of [
      ['POST', '/api/auth/claim'],
      ['POST', '/api/auth/requests'],
      ['GET', '/api/auth/host-info'],
      ['GET', '/api/auth/manifest'],
      ['GET', `/api/auth/requests/${'a'.repeat(24)}`],
    ]) {
      assert.equal((await runMiddleware(createAuthMiddleware(), phoneReq({ method, url }))).nextCalled, true, url);
    }
    for (const [method, url] of [
      ['GET', '/api/auth/claim'],
      ['POST', '/api/auth/claim/extra'],
      ['GET', '/api/auth/requests'],
      ['POST', '/api/auth/connect-sessions'],
      ['POST', '/api/auth/pair'],
    ]) {
      const result = await runMiddleware(createAuthMiddleware(), phoneReq({ method, url }));
      assert.equal(result.nextCalled, false, url);
      assert.equal(result.res.statusCode, 401, url);
    }
    // A public address never reaches the home-network bootstrap.
    const outside = await runMiddleware(
      createAuthMiddleware(),
      phoneReq({ method: 'POST', url: '/api/auth/claim', remoteAddress: '8.8.8.8' }),
    );
    assert.equal(outside.res.statusCode, 403);
  });

  test('claim sets an HttpOnly cookie that authenticates the phone', async () => {
    setActiveNetworkAccess('lan');
    const session = createConnectSession();
    const claimReq = phoneReq({ url: '/api/auth/claim', method: 'POST', body: { ticket: session.ticket, name: 'Kitchen iPad' } });
    assert.equal((await runMiddleware(createAuthMiddleware(), claimReq)).nextCalled, true);
    const claimed = await runMiddleware(createAuthRoutesMiddleware(), claimReq);
    assert.equal(claimed.res.statusCode, 200);
    assert.equal(JSON.parse(claimed.res.body).device.name, 'Kitchen iPad');
    assert.equal(claimed.res.body.includes('minnow_device_'), false);
    assert.match(String(claimed.res.headers['set-cookie']), /HttpOnly/);
    const token = cookieFrom(claimed.res);
    assert.ok(authenticateDeviceToken(token));

    const reused = await runMiddleware(
      createAuthRoutesMiddleware(),
      phoneReq({ url: '/api/auth/claim', method: 'POST', body: { ticket: session.ticket } }),
    );
    assert.equal(reused.res.statusCode, 401);
  });

  test('device sessions cannot use host management routes', async () => {
    const routes = createAuthRoutesMiddleware({ getConnectTargets: () => [{ kind: 'lan', url: 'http://mac.local:9480/' }] });
    const auth = { kind: 'device', deviceId: 'a'.repeat(24), credentialId: 'b'.repeat(24), deviceName: 'Phone' };
    for (const [method, url] of [
      ['POST', '/api/auth/connect-sessions'],
      ['GET', '/api/auth/devices'],
      ['GET', '/api/auth/requests'],
      ['POST', `/api/auth/requests/${'c'.repeat(24)}/approve`],
      ['PATCH', `/api/auth/devices/${'a'.repeat(24)}`],
      ['DELETE', `/api/auth/devices/${'a'.repeat(24)}`],
    ]) {
      const { res } = await runMiddleware(routes, mockReq({ method, url, auth, body: {} }));
      assert.equal(res.statusCode, 403, url);
    }
  });

  test('host opens connect sessions and can list, rename and revoke devices', async () => {
    const routes = createAuthRoutesMiddleware({
      getConnectTargets: () => [
        { kind: 'anywhere', url: 'https://minnow-mac.tail1.ts.net/' },
        { kind: 'lan', url: 'http://mac.local:9480/' },
      ],
    });
    const opened = await runMiddleware(routes, mockReq({ url: '/api/auth/connect-sessions', method: 'POST', auth: { kind: 'host' } }));
    assert.equal(opened.res.statusCode, 201);
    const payload = JSON.parse(opened.res.body);
    assert.match(payload.code, /^\d{6}$/);
    assert.equal(payload.targets[0].kind, 'anywhere');
    assert.match(payload.targets[0].url, /^https:\/\/minnow-mac\.tail1\.ts\.net\/connect#t=[A-Za-z0-9_-]{22}$/);
    assert.match(payload.targets[1].url, /^http:\/\/mac\.local:9480\/connect#t=/);

    const status = await runMiddleware(routes, mockReq({ url: `/api/auth/connect-sessions/${payload.id}`, auth: { kind: 'host' } }));
    assert.equal(JSON.parse(status.res.body).status, 'waiting');

    const { device } = newDevice('Tablet');
    const listed = await runMiddleware(routes, mockReq({ url: '/api/auth/devices', auth: { kind: 'host' } }));
    assert.deepEqual(JSON.parse(listed.res.body).devices.map((d) => d.name), ['Tablet']);

    const renamed = await runMiddleware(
      routes,
      mockReq({ url: `/api/auth/devices/${device.id}`, method: 'PATCH', auth: { kind: 'host' }, body: { name: 'Living room iPad' } }),
    );
    assert.equal(JSON.parse(renamed.res.body).device.name, 'Living room iPad');

    const revoked = await runMiddleware(routes, mockReq({ url: `/api/auth/devices/${device.id}`, method: 'DELETE', auth: { kind: 'host' } }));
    assert.equal(revoked.res.statusCode, 200);
    assert.deepEqual(listDevices(), []);
  });

  test('connect sessions need a remote listener to point at', async () => {
    const routes = createAuthRoutesMiddleware({ getConnectTargets: () => [] });
    const { res } = await runMiddleware(routes, mockReq({ url: '/api/auth/connect-sessions', method: 'POST', auth: { kind: 'host' } }));
    assert.equal(res.statusCode, 409);
    assert.equal(JSON.parse(res.body).code, 'no_remote_access');
  });
});
