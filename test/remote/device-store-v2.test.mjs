/**
 * Device store schema v2: v1 migration keeps existing phones signed in, one
 * device holds several credentials, and activity writes are throttled.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';
import {
  addCredential,
  authenticateDeviceToken,
  createDevice,
  defaultDeviceName,
  flushDeviceActivity,
  guessDeviceKind,
  hashDeviceToken,
  listDevices,
  revokeCredential,
  revokeDevice,
  touchDevice,
} from '../../server/auth/device-store.js';
import { useScratchHome } from './helpers.mjs';

describe('device store v2', () => {
  let scratch;
  beforeEach(async () => {
    scratch = await useScratchHome('minnow-devices');
  });
  afterEach(async () => {
    mock.restoreAll();
    await scratch.cleanup();
  });

  test('a v1 registry migrates and its token keeps working', () => {
    const id = 'a1b2c3d4e5f6a1b2c3d4e5f6';
    const token = `minnow_device_${id}.${'x'.repeat(43)}`;
    const dir = path.join(scratch.home, 'auth');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'devices.json'),
      JSON.stringify({
        schemaVersion: 1,
        devices: [{ id, name: 'Old phone', tokenHash: hashDeviceToken(token), createdAt: '2026-01-01T00:00:00.000Z' }],
      }),
    );

    assert.deepEqual(authenticateDeviceToken(token), {
      kind: 'device',
      deviceId: id,
      credentialId: id,
      deviceName: 'Old phone',
    });
    const migrated = JSON.parse(fs.readFileSync(path.join(dir, 'devices.json'), 'utf8'));
    assert.equal(migrated.schemaVersion, 2);
    assert.equal(migrated.devices[0].credentials.length, 1);
    assert.ok(fs.existsSync(path.join(dir, 'devices.v1.json.bak')));
  });

  test('one device holds several credentials that revoke independently', () => {
    const { device } = createDevice({ name: 'iPhone', kind: 'phone' });
    const browser = addCredential(device.id, { label: 'browser' });
    const app = addCredential(device.id, { label: 'home-screen' });
    assert.equal(authenticateDeviceToken(browser.token)?.deviceId, device.id);
    assert.equal(authenticateDeviceToken(app.token)?.deviceId, device.id);
    assert.equal(listDevices().length, 1);
    assert.deepEqual(listDevices()[0].credentials.map((c) => c.label), ['browser', 'home-screen']);

    assert.equal(revokeCredential(device.id, browser.credential.id), true);
    assert.equal(authenticateDeviceToken(browser.token), null);
    assert.ok(authenticateDeviceToken(app.token));

    assert.equal(revokeDevice(device.id), true);
    assert.equal(authenticateDeviceToken(app.token), null);
  });

  test('activity is buffered: many requests write the registry at most once a minute', () => {
    const { device } = createDevice({ name: 'Phone' });
    const { credential } = addCredential(device.id);
    flushDeviceActivity();
    const rename = mock.method(fs, 'renameSync');
    let now = 5_000_000;
    touchDevice(device.id, credential.id, 'lan', { now: () => now });
    for (let i = 0; i < 100; i += 1) {
      now += 100;
      touchDevice(device.id, credential.id, 'lan', { now: () => now });
    }
    assert.ok(rename.mock.callCount() <= 1);
    assert.equal(listDevices()[0].lastIngress, 'lan');
    assert.ok(listDevices()[0].lastSeenAt);
  });

  test('device kind and default name come from the user agent', () => {
    const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)';
    const pixel = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) Mobile Safari/537.36';
    assert.equal(guessDeviceKind(iphone), 'phone');
    assert.equal(defaultDeviceName(iphone), 'iPhone');
    assert.equal(guessDeviceKind(pixel), 'phone');
    assert.equal(defaultDeviceName(pixel), 'Android phone');
    assert.equal(guessDeviceKind('Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)'), 'tablet');
    assert.equal(defaultDeviceName(undefined), 'Device');
  });
});
