/**
 * The home-network listener starts and stops live, never drifts off its port,
 * and the legacy restart-based setting migrates.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import {
  applyRemoteConfigAtBoot,
  configureRemoteIngress,
  getLanStatus,
  setLanEnabled,
  shutdownRemoteIngress,
} from '../../server/remote/ingress-manager.js';
import { readRemoteConfig } from '../../server/remote/config.js';
import { createTestApp, freePort, useScratchHome } from './helpers.mjs';

describe('home-network listener', () => {
  let scratch;
  let port;

  beforeEach(async () => {
    scratch = await useScratchHome('minnow-lan');
    configureRemoteIngress({ requestHandler: await createTestApp(scratch.home) });
    port = await freePort();
    process.env.MINNOW_LAN_PORT = String(port);
  });

  afterEach(async () => {
    await shutdownRemoteIngress();
    delete process.env.MINNOW_LAN_PORT;
    await scratch.cleanup();
  });

  test('turning it on serves phones immediately, without a restart', async () => {
    const status = await setLanEnabled(true);
    assert.equal(status.lan.state, 'on');
    assert.equal(status.lan.port, port);
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/host-info`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ingress, 'lan');
    assert.equal((await readRemoteConfig()).lan.enabled, true);

    await setLanEnabled(false);
    assert.equal(getLanStatus().state, 'off');
    await assert.rejects(fetch(`http://127.0.0.1:${port}/api/auth/host-info`));
  });

  test('a busy port is reported, never swapped for another one', async () => {
    const blocker = net.createServer();
    await new Promise((resolve) => blocker.listen(port, '::', resolve));
    try {
      const status = await setLanEnabled(true);
      assert.equal(status.lan.state, 'error');
      assert.equal(status.lan.error.code, 'port-in-use');
      assert.equal(status.lan.port, port);
      assert.deepEqual(status.lan.urls, []);
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });

  test('the legacy networkAccess: lan setting starts the listener at boot', async () => {
    await fs.writeFile(path.join(scratch.home, 'config.json'), JSON.stringify({ server: { networkAccess: 'lan' } }));
    await applyRemoteConfigAtBoot();
    assert.equal(getLanStatus().state, 'on');
    assert.equal((await readRemoteConfig()).lan.enabled, true);
  });
});
