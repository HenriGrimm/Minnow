/**
 * Companion device persistence, pairing, authorization, and revocation (MIN-393).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import {
  authenticateDeviceToken,
  createDevice,
  listDevices,
  revokeDevice,
} from '../../server/auth/device-store.js';
import {
  createPairingChallenge,
  exchangePairingChallenge,
  normalizePairingCode,
  PAIRING_TTL_MS,
  PairingError,
  resetPairingState,
} from '../../server/auth/pairing.js';
import { createAuthRoutesMiddleware } from '../../server/auth/routes.js';
import { createAuthMiddleware } from '../../server/runtime/auth-middleware.js';
import { getSessionToken, resetSessionTokenCache } from '../../server/runtime/session-token.js';
import { initNetworkAccess } from '../../server/network/access.js';

let homeDir;

function setTestHome() {
  resetMinnowHomeCache();
  resetSessionTokenCache();
  resetPairingState();
  homeDir = path.join(
    '/tmp',
    `minnow-device-auth-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  process.env.MINNOW_HOME = homeDir;
  delete process.env.MINNOW_NETWORK;
  initNetworkAccess({});
}

async function rmTestHome() {
  resetPairingState();
  resetMinnowHomeCache();
  resetSessionTokenCache();
  delete process.env.MINNOW_HOME;
  delete process.env.MINNOW_NETWORK;
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
  body,
  auth,
  remoteAddress = '127.0.0.1',
  localPort = 9473,
} = {}) {
  const headers = { host: 'localhost:9473' };
  if (token) headers['x-minnow-token'] = token;
  return {
    url,
    method,
    headers,
    minnowAuth: auth,
    socket: { remoteAddress, localPort },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body));
    },
  };
}

async function runMiddleware(middleware, req) {
  const res = mockRes();
  let nextCalled = false;
  await middleware(req, res, () => {
    nextCalled = true;
  });
  return { res, nextCalled };
}

describe('companion device store', () => {
  beforeEach(setTestHome);
  afterEach(rmTestHome);

  test('persists a named device with only its SHA-256 token hash', async () => {
    const { token, device } = createDevice('  Alice\u0000   Phone  ');
    assert.equal(device.name, 'Alice Phone');
    assert.deepEqual(listDevices(), [device]);
    assert.deepEqual(authenticateDeviceToken(token), {
      kind: 'device',
      deviceId: device.id,
      deviceName: 'Alice Phone',
    });

    const filePath = path.join(homeDir, 'auth', 'devices.json');
    const raw = await fs.readFile(filePath, 'utf8');
    const persisted = JSON.parse(raw);
    assert.equal(raw.includes(token), false);
    assert.match(persisted.devices[0].tokenHash, /^[0-9a-f]{64}$/);
    assert.equal(persisted.devices[0].secret, undefined);

    if (process.platform !== 'win32') {
      assert.equal((await fs.stat(path.join(homeDir, 'auth'))).mode & 0o777, 0o700);
      assert.equal((await fs.stat(filePath)).mode & 0o777, 0o600);
    }
  });

  test('revocation removes the record and invalidates the token immediately', () => {
    const { token, device } = createDevice('Tablet');
    assert.ok(authenticateDeviceToken(token));
    assert.equal(revokeDevice(device.id), true);
    assert.equal(authenticateDeviceToken(token), null);
    assert.deepEqual(listDevices(), []);
    assert.equal(revokeDevice(device.id), false);
  });
});

describe('pairing challenges', () => {
  beforeEach(setTestHome);
  afterEach(rmTestHome);

  test('normalizes six-digit codes from spaced input', () => {
    assert.equal(normalizePairingCode('123 456'), '123456');
    assert.equal(normalizePairingCode('12345'), '');
    assert.equal(normalizePairingCode('1234567'), '');
  });

  test('issues six-digit single-use codes that expire after five minutes', () => {
    let now = 1_000;
    const first = createPairingChallenge('Phone', { now: () => now, randomInt: () => 42_019 });
    assert.match(first.code, /^\d{6}$/);
    assert.equal(first.code, '042019');
    const issued = exchangePairingChallenge(
      { code: first.code, deviceName: 'Phone', source: '192.168.1.20' },
      {
        now: () => now,
        createDevice: (name) => ({
          token: 'device-token',
          device: { id: 'a'.repeat(24), name, createdAt: new Date(now).toISOString() },
        }),
      },
    );
    assert.equal(issued.token, 'device-token');
    assert.throws(
      () =>
        exchangePairingChallenge(
          { code: first.code, deviceName: 'Phone', source: '192.168.1.20' },
          { now: () => now },
        ),
      (err) => err instanceof PairingError && err.code === 'invalid_pairing_code',
    );

    const expired = createPairingChallenge('Tablet', { now: () => now });
    now += PAIRING_TTL_MS;
    assert.throws(
      () =>
        exchangePairingChallenge(
          { code: expired.code, deviceName: 'Tablet', source: '192.168.1.21' },
          { now: () => now },
        ),
      (err) => err instanceof PairingError && err.code === 'invalid_pairing_code',
    );
  });

  test('throttles repeated attempts per source without consuming valid challenges', () => {
    const now = () => 10_000;
    const pairing = createPairingChallenge('Phone', { now });
    for (let i = 0; i < 10; i += 1) {
      assert.throws(
        () =>
          exchangePairingChallenge(
            { code: String(i).padStart(6, '0'), deviceName: 'Phone', source: '192.168.1.50' },
            { now },
          ),
        (err) => err instanceof PairingError && err.code === 'invalid_pairing_code',
      );
    }
    assert.throws(
      () =>
        exchangePairingChallenge(
          { code: pairing.code, deviceName: 'Phone', source: '192.168.1.50' },
          { now },
        ),
      (err) => err instanceof PairingError && err.statusCode === 429,
    );
  });
});

describe('companion request authorization', () => {
  beforeEach(setTestHome);
  afterEach(rmTestHome);

  test('device session stays authorized across workspaces and host restarts', async () => {
    const { token } = createDevice('Phone');
    const originalHostToken = getSessionToken();
    resetSessionTokenCache();
    resetPairingState();
    assert.notEqual(getSessionToken(), originalHostToken);
    for (const workspace of ['/workspace/one', '/workspace/two']) {
      const req = mockReq({ token, url: '/api/auth/session' });
      req.headers['x-minnow-workspace'] = workspace;
      assert.equal((await runMiddleware(createAuthMiddleware(), req)).nextCalled, true);
      const { res } = await runMiddleware(createAuthRoutesMiddleware(), req);
      assert.equal(res.statusCode, 200);
      assert.deepEqual(JSON.parse(res.body), { authenticated: true, kind: 'device' });
      assert.equal(res.headers['cache-control'], 'no-store');
    }
  });

  test('install manifest carries only the authenticated device and revocation blocks reuse', async () => {
    const { token, device } = createDevice('Phone');
    const req = mockReq({ url: `/api/auth/manifest?token=${encodeURIComponent(token)}` });
    assert.equal((await runMiddleware(createAuthMiddleware(), req)).nextCalled, true);
    const { res } = await runMiddleware(createAuthRoutesMiddleware(), req);
    const manifest = JSON.parse(res.body);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['cache-control'], 'private, no-store');
    assert.equal(res.headers['content-type'], 'application/manifest+json');
    assert.equal(manifest.id, '/');
    assert.equal(manifest.scope, '/');
    assert.equal(manifest.start_url, `/#device=${encodeURIComponent(token)}`);
    assert.ok(manifest.icons.every((icon) => icon.src.startsWith('/icons/')));
    revokeDevice(device.id);
    assert.equal((await runMiddleware(createAuthMiddleware(), req)).res.statusCode, 401);
    const host = mockReq({ url: '/api/auth/manifest', token: getSessionToken() });
    assert.equal((await runMiddleware(createAuthMiddleware(), host)).nextCalled, true);
    assert.equal((await runMiddleware(createAuthRoutesMiddleware(), host)).res.statusCode, 403);
    assert.equal((await runMiddleware(createAuthMiddleware(), mockReq({ url: '/api/auth/manifest' }))).res.statusCode, 401);
  });

  test('unreadable device registry is retryable and does not report revocation', async () => {
    const { token } = createDevice('Phone');
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

    const { token, device } = createDevice('Phone');
    const deviceReq = mockReq({ token });
    assert.equal((await runMiddleware(createAuthMiddleware(), deviceReq)).nextCalled, true);
    assert.deepEqual(deviceReq.minnowAuth, {
      kind: 'device',
      deviceId: device.id,
      deviceName: 'Phone',
    });
  });

  test('a revoked device is rejected by the middleware on its next request', async () => {
    const { token, device } = createDevice('Phone');
    assert.equal(
      (await runMiddleware(createAuthMiddleware(), mockReq({ token }))).nextCalled,
      true,
    );
    revokeDevice(device.id);
    const { res, nextCalled } = await runMiddleware(
      createAuthMiddleware(),
      mockReq({ token }),
    );
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
    assert.equal(res.headers['x-minnow-auth'], 'required');
  });

  test('only exact POST pair bootstrap is unauthenticated and LAN restricted', async () => {
    process.env.MINNOW_NETWORK = 'lan';
    initNetworkAccess({});
    const allowed = await runMiddleware(
      createAuthMiddleware(),
      mockReq({
        url: '/api/auth/pair',
        method: 'POST',
        remoteAddress: '192.168.1.25',
      }),
    );
    assert.equal(allowed.nextCalled, true);

    for (const req of [
      mockReq({ url: '/api/auth/pair', method: 'GET', remoteAddress: '192.168.1.25' }),
      mockReq({ url: '/api/auth/pair/extra', method: 'POST', remoteAddress: '192.168.1.25' }),
      mockReq({ url: '/api/auth/pairings', method: 'POST', remoteAddress: '192.168.1.25' }),
      mockReq({ url: '/api/auth/pair', method: 'POST', remoteAddress: '8.8.8.8' }),
    ]) {
      const result = await runMiddleware(createAuthMiddleware(), req);
      assert.equal(result.nextCalled, false);
      assert.ok([401, 403].includes(result.res.statusCode));
    }
  });

  test('unauthenticated pair exchange issues one active device token', async () => {
    process.env.MINNOW_NETWORK = 'lan';
    initNetworkAccess({});
    const pairing = createPairingChallenge('Phone');
    const pairReq = mockReq({
      url: '/api/auth/pair',
      method: 'POST',
      remoteAddress: '192.168.1.25',
      body: { code: pairing.code, deviceName: 'Phone' },
    });
    assert.equal((await runMiddleware(createAuthMiddleware(), pairReq)).nextCalled, true);

    const exchanged = await runMiddleware(createAuthRoutesMiddleware(), pairReq);
    assert.equal(exchanged.res.statusCode, 200);
    const payload = JSON.parse(exchanged.res.body);
    assert.deepEqual(authenticateDeviceToken(payload.token), {
      kind: 'device',
      deviceId: payload.device.id,
      deviceName: 'Phone',
    });

    const reused = await runMiddleware(
      createAuthRoutesMiddleware(),
      mockReq({
        url: '/api/auth/pair',
        method: 'POST',
        remoteAddress: '192.168.1.25',
        body: { code: pairing.code, deviceName: 'Phone' },
      }),
    );
    assert.equal(reused.res.statusCode, 401);
  });

  test('device sessions cannot use host management routes', async () => {
    const routes = createAuthRoutesMiddleware();
    for (const req of [
      mockReq({
        url: '/api/auth/pairings',
        method: 'POST',
        body: { deviceName: 'Phone' },
        auth: { kind: 'device', deviceId: 'a'.repeat(24), deviceName: 'Phone' },
      }),
      mockReq({
        url: '/api/auth/devices',
        auth: { kind: 'device', deviceId: 'a'.repeat(24), deviceName: 'Phone' },
      }),
      mockReq({
        url: `/api/auth/devices/${'a'.repeat(24)}`,
        method: 'DELETE',
        auth: { kind: 'device', deviceId: 'a'.repeat(24), deviceName: 'Phone' },
      }),
    ]) {
      const { res } = await runMiddleware(routes, req);
      assert.equal(res.statusCode, 403);
    }
  });

  test('host creates sanitized pairing links and can list and revoke devices', async () => {
    const routes = createAuthRoutesMiddleware({
      buildNetworkUrls: (port) => [`http://192.168.1.10:${port}/`],
    });
    const createdPairing = await runMiddleware(
      routes,
      mockReq({
        url: '/api/auth/pairings',
        method: 'POST',
        body: { deviceName: '  My\u0000   Phone ' },
        auth: { kind: 'host' },
      }),
    );
    assert.equal(createdPairing.res.statusCode, 201);
    const pairingPayload = JSON.parse(createdPairing.res.body);
    assert.equal(pairingPayload.deviceName, 'My Phone');
    assert.deepEqual(pairingPayload.urls, [
      `http://192.168.1.10:9473/#pair=${pairingPayload.code}`,
    ]);

    const { device } = createDevice('Tablet');
    const listed = await runMiddleware(
      routes,
      mockReq({ url: '/api/auth/devices', auth: { kind: 'host' } }),
    );
    assert.deepEqual(JSON.parse(listed.res.body).devices, [device]);

    const revoked = await runMiddleware(
      routes,
      mockReq({
        url: `/api/auth/devices/${device.id}`,
        method: 'DELETE',
        auth: { kind: 'host' },
      }),
    );
    assert.equal(revoked.res.statusCode, 200);
    assert.deepEqual(listDevices(), []);
  });
});
