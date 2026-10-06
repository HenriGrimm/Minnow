/**
 * Network access policy — resolveNetworkAccess and isClientAllowed.
 */

import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveNetworkAccess,
  resolveConfigNetworkAccess,
  isClientAllowed,
  isLoopbackClient,
  isHostAllowed,
  resetOwnLanHostnamesCache,
  initNetworkAccess,
  isNetworkRestartRequired,
  resolveViteHost,
} from '../../server/network/access.js';
import os from 'node:os';

/** @param {string} address */
function mockReq(address) {
  return { socket: { remoteAddress: address } };
}

describe('resolveNetworkAccess', () => {
  test('defaults to local when config is empty', () => {
    assert.equal(resolveNetworkAccess({}), 'local');
    assert.equal(resolveConfigNetworkAccess({}), 'local');
  });

  test('reads server.networkAccess from config', () => {
    assert.equal(resolveConfigNetworkAccess({ server: { networkAccess: 'lan' } }), 'lan');
    assert.equal(resolveConfigNetworkAccess({ server: { networkAccess: 'local' } }), 'local');
  });

  test('MINNOW_NETWORK env overrides config', () => {
    const prev = process.env.MINNOW_NETWORK;
    process.env.MINNOW_NETWORK = 'lan';
    try {
      assert.equal(resolveNetworkAccess({ server: { networkAccess: 'local' } }), 'lan');
    } finally {
      if (prev === undefined) delete process.env.MINNOW_NETWORK;
      else process.env.MINNOW_NETWORK = prev;
    }
  });

  test('resolveViteHost maps modes to Vite host option', () => {
    assert.equal(resolveViteHost('local'), 'localhost');
    assert.equal(resolveViteHost('lan'), true);
  });
});

describe('isClientAllowed', () => {
  test('allows loopback in local mode', () => {
    initNetworkAccess({});
    assert.equal(isClientAllowed(mockReq('127.0.0.1'), 'local'), true);
    assert.equal(isClientAllowed(mockReq('::1'), 'local'), true);
    assert.equal(isClientAllowed(mockReq('::ffff:127.0.0.1'), 'local'), true);
  });

  test('blocks RFC1918 in local mode', () => {
    assert.equal(isClientAllowed(mockReq('192.168.1.10'), 'local'), false);
    assert.equal(isClientAllowed(mockReq('10.0.0.5'), 'local'), false);
  });

  test('does not mistake a suffix or malformed mapped address for loopback', () => {
    for (const address of ['192.168.127.0.0.1', '::ffff:192.168.127.0.0.1', 'evil127.0.0.1']) {
      assert.equal(isLoopbackClient(mockReq(address)), false);
      assert.equal(isClientAllowed(mockReq(address), 'local'), false);
    }
    assert.equal(isLoopbackClient(mockReq('::ffff:127.0.0.1')), true);
  });

  test('allows RFC1918 in lan mode', () => {
    assert.equal(isClientAllowed(mockReq('192.168.1.10'), 'lan'), true);
    assert.equal(isClientAllowed(mockReq('::ffff:192.168.1.10'), 'lan'), true);
    assert.equal(isClientAllowed(mockReq('10.0.0.5'), 'lan'), true);
  });

  test('blocks public IPs even in lan mode', () => {
    assert.equal(isClientAllowed(mockReq('8.8.8.8'), 'lan'), false);
    assert.equal(isClientAllowed(mockReq('1.2.3.4'), 'lan'), false);
  });
});

describe('isHostAllowed', () => {
  beforeEach(() => resetOwnLanHostnamesCache());

  test('allows loopback hostnames in local mode', () => {
    assert.equal(isHostAllowed('localhost:9473', 'local'), true);
    assert.equal(isHostAllowed('127.0.0.1:9473', 'local'), true);
    assert.equal(isHostAllowed('[::1]:9473', 'local'), true);
    assert.equal(isHostAllowed('::1', 'local'), true);
  });

  test('rejects an attacker-controlled hostname even in local mode', () => {
    assert.equal(isHostAllowed('evil.example:9473', 'local'), false);
    assert.equal(isHostAllowed('evil.example', 'local'), false);
  });

  test('a DNS name that merely resolves to a local IP is still rejected (anti DNS-rebinding)', () => {
    // The check is purely on the Host *string*, never a DNS lookup — so an
    // attacker's domain pointed at 127.0.0.1 must not pass as "loopback".
    assert.equal(isHostAllowed('rebind.evil.example:9473', 'lan'), false);
  });

  test('rejects LAN-looking hostnames in local mode', () => {
    assert.equal(isHostAllowed(`${os.hostname()}:9473`, 'local'), false);
  });

  test('allows this machine own hostname/LAN IPs only in lan mode', () => {
    assert.equal(isHostAllowed(`${os.hostname()}:9473`, 'lan'), true);
  });

  test('rejects empty Host header', () => {
    assert.equal(isHostAllowed('', 'local'), false);
    assert.equal(isHostAllowed('', 'lan'), false);
  });
});

describe('restart detection', () => {
  test('restart required when config differs from active bind', () => {
    initNetworkAccess({ server: { networkAccess: 'local' } });
    assert.equal(isNetworkRestartRequired(), false);
  });
});
