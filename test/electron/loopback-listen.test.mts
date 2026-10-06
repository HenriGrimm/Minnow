/**
 * Packaged in-process server prefers a stable loopback port.
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import { describe, test } from 'node:test';
import { listenOnPreferredLoopback, listenOnPreferredNetwork } from '../../electron/loopback-listen.ts';
import {
  getNetworkAccess,
  initNetworkAccess,
  isClientAllowed,
  isNetworkRestartRequired,
  setConfigNetworkAccess,
} from '../../server/network/access.js';

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

describe('listenOnPreferredLoopback', () => {
  test('binds the preferred port when it is free', async () => {
    const scout = http.createServer();
    await new Promise<void>((resolve, reject) => {
      scout.once('error', reject);
      scout.listen(0, '127.0.0.1', () => resolve());
    });
    const preferred = (scout.address() as { port: number }).port;
    await closeServer(scout);

    const server = http.createServer();
    try {
      const bound = await listenOnPreferredLoopback(server, preferred);
      assert.equal(bound.port, preferred);
      assert.equal(bound.ephemeral, false);
    } finally {
      await closeServer(server);
    }
  });

  test('falls back to an ephemeral port when the preferred port is busy', async () => {
    const blocker = http.createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(0, '127.0.0.1', () => resolve());
    });
    const preferred = (blocker.address() as { port: number }).port;

    const server = http.createServer();
    try {
      const bound = await listenOnPreferredLoopback(server, preferred);
      assert.equal(bound.ephemeral, true);
      assert.notEqual(bound.port, preferred);
    } finally {
      await closeServer(server);
      await closeServer(blocker);
    }
  });
});

describe('packaged network mode', () => {
  test('local binds only loopback; LAN binds all IPv4 interfaces', async () => {
    for (const [mode, address] of [
      ['local', '127.0.0.1'],
      ['lan', '0.0.0.0'],
    ] as const) {
      const server = http.createServer();
      try {
        const bound = await listenOnPreferredNetwork(server, 0, mode);
        assert.ok(bound.port > 0);
        assert.equal((server.address() as { address: string }).address, address);
      } finally {
        await closeServer(server);
      }
    }
  });

  test('LAN fallback keeps the LAN bind when the preferred port is busy', async () => {
    const blocker = http.createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(0, '0.0.0.0', () => resolve());
    });
    const preferred = (blocker.address() as { port: number }).port;
    const server = http.createServer();
    try {
      const bound = await listenOnPreferredNetwork(server, preferred, 'lan');
      assert.equal(bound.ephemeral, true);
      assert.notEqual(bound.port, preferred);
      assert.equal((server.address() as { address: string }).address, '0.0.0.0');
    } finally {
      await closeServer(server);
      await closeServer(blocker);
    }
  });

  test('saved mode change takes effect after restart, including pairing revocation', () => {
    const previous = process.env.MINNOW_NETWORK;
    delete process.env.MINNOW_NETWORK;
    const remote = { socket: { remoteAddress: '192.168.1.20' } };
    try {
      initNetworkAccess({ server: { networkAccess: 'local' } });
      assert.equal(getNetworkAccess(), 'local');
      assert.equal(isClientAllowed(remote), false);

      setConfigNetworkAccess('lan');
      assert.equal(isNetworkRestartRequired(), true);
      assert.equal(getNetworkAccess(), 'local');
      initNetworkAccess({ server: { networkAccess: 'lan' } });
      assert.equal(getNetworkAccess(), 'lan');
      assert.equal(isClientAllowed(remote), true);

      setConfigNetworkAccess('local');
      assert.equal(isNetworkRestartRequired(), true);
      initNetworkAccess({ server: { networkAccess: 'local' } });
      assert.equal(isClientAllowed(remote), false);
      assert.equal(isNetworkRestartRequired(), false);
    } finally {
      if (previous === undefined) delete process.env.MINNOW_NETWORK;
      else process.env.MINNOW_NETWORK = previous;
      initNetworkAccess({});
    }
  });
});
