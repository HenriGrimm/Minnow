/**
 * The home-network listener starts and stops live, never drifts off its port,
 * and the legacy restart-based setting migrates.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import {
  applyRemoteConfigAtBoot,
  configureRemoteIngress,
  getLanStatus,
  startLanIngress,
  stopLanIngress,
  setLanEnabled,
  shutdownRemoteIngress,
} from '../../server/remote/ingress-manager.js';
import { startIsolatedPreviewHost, stopIsolatedPreviewHost } from '../../server/preview/isolated-host.js';
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

  test('a queued Off wins over an in-flight bind and previews return to the same local port', async t => {
    const binds = [];
    const listen = http.Server.prototype.listen;
    t.mock.method(http.Server.prototype, 'listen', function (...args) {
      if (typeof args[0] === 'number') binds.push([args[0], args[1]]);
      return listen.apply(this, args);
    });
    await startIsolatedPreviewHost();
    try {
      const first = startLanIngress({ port });
      const last = stopLanIngress();
      await Promise.all([first, last]);
      assert.equal(getLanStatus().state, 'off');
      const wide = binds.find(([boundPort, host]) => host === '0.0.0.0' && boundPort !== port);
      assert.ok(wide, 'preview listener followed LAN enablement');
      assert.deepEqual(binds.at(-1), [wide[0], '127.0.0.1']);
      assert.equal((await fetch('http://127.0.0.1:' + wide[0] + '/unknown')).status, 404);
      await assert.rejects(fetch('http://127.0.0.1:' + port));
    } finally {
      await stopIsolatedPreviewHost();
    }
  });

  test('the legacy networkAccess: lan setting starts the listener at boot', async () => {
    await fs.writeFile(path.join(scratch.home, 'config.json'), JSON.stringify({ server: { networkAccess: 'lan' } }));
    await applyRemoteConfigAtBoot();
    assert.equal(getLanStatus().state, 'on');
    assert.equal((await readRemoteConfig()).lan.enabled, true);
  });
});
