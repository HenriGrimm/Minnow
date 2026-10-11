/**
 * Module-level serve heartbeat — three failed /health probes with a live PID
 * flip the row to unhealthy. Tests call the tick; they do not wait 10s.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { getServesIndexPath } from '../../server/models/paths.js';
import {
  getServe,
  patchServeRowForTests,
  peekServeRowForTests,
  resetServesForTests,
  setServeBackgroundRunOverrideForTests,
  setServeHealthOverrideForTests,
  setServeHeartbeatProbeOverrideForTests,
  setServePidAliveOverrideForTests,
  setSubscribeRunOverrideForTests,
  startServe,
  tickServeHeartbeatForTests,
} from '../../server/models/serve.js';

const RUN_ID = 'test-run-heartbeat-1';
const PID = 5252;

async function waitForStatus(serveId, status, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const serve = await getServe(serveId);
    if (serve && serve.status === status) return serve;
    await new Promise((r) => setTimeout(r, 25));
  }
  return getServe(serveId);
}

describe('serve heartbeat', () => {
  /** @type {string} */
  let homeDir;
  /** @type {string} */
  let modelPath;

  before(async () => {
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-serve-heartbeat-'));
    process.env.MINNOW_HOME = homeDir;
    resetMinnowHomeCache();

    modelPath = path.join(homeDir, 'heartbeat-model.gguf');
    await fs.writeFile(modelPath, 'GGUF');

    const managedRoot = path.join(homeDir, 'models-runtime', 'llama-cpp');
    await fs.mkdir(managedRoot, { recursive: true });
    const binName = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
    await fs.writeFile(path.join(managedRoot, binName), '');
    await fs.writeFile(
      path.join(managedRoot, 'meta.json'),
      `${JSON.stringify({ variant: 'cpu', version: 'test', path: path.join(managedRoot, binName) })}\n`,
    );
  });

  beforeEach(async () => {
    await resetServesForTests();
    await fs.mkdir(path.dirname(getServesIndexPath()), { recursive: true });
    await fs.writeFile(getServesIndexPath(), `${JSON.stringify({ version: 1, serves: [] }, null, 2)}\n`);
    setServeHealthOverrideForTests(async () => true);
    setServeBackgroundRunOverrideForTests(async () => ({ runId: RUN_ID, pid: PID }));
    setSubscribeRunOverrideForTests(() => () => {});
    setServePidAliveOverrideForTests(() => true);
  });

  after(async () => {
    delete process.env.MINNOW_HOME;
    resetMinnowHomeCache();
    await resetServesForTests();
    await fs.rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  test('three failed health checks with pid alive mark the serve unhealthy', async () => {
    const serve = await startServe({ modelPath, runtime: 'llama-cpp', async: true });
    await waitForStatus(serve.id, 'running');
    setServeHeartbeatProbeOverrideForTests(async () => false);

    await tickServeHeartbeatForTests();
    await tickServeHeartbeatForTests();
    let row = await getServe(serve.id);
    assert.equal(row.status, 'running');

    await tickServeHeartbeatForTests();
    row = await getServe(serve.id);
    assert.equal(row.status, 'unhealthy');
  });

  test('a successful probe clears the failure streak', async () => {
    const serve = await startServe({ modelPath, runtime: 'llama-cpp', async: true });
    await waitForStatus(serve.id, 'running');
    let healthOk = false;
    setServeHeartbeatProbeOverrideForTests(async () => healthOk);

    await tickServeHeartbeatForTests();
    await tickServeHeartbeatForTests();
    healthOk = true;
    await tickServeHeartbeatForTests();
    healthOk = false;
    await tickServeHeartbeatForTests();
    await tickServeHeartbeatForTests();
    let row = await getServe(serve.id);
    assert.equal(row.status, 'running');
    await tickServeHeartbeatForTests();
    row = await getServe(serve.id);
    assert.equal(row.status, 'unhealthy');
  });

  test('successful probes preserve the healthy stretch used for crash restart', async () => {
    const serve = await startServe({ modelPath, runtime: 'llama-cpp', async: true });
    await waitForStatus(serve.id, 'running');
    const healthyAt = Date.now() - 31000;
    patchServeRowForTests(serve.id, { lastHealthyAt: healthyAt });
    setServeHeartbeatProbeOverrideForTests(async () => true);
    await tickServeHeartbeatForTests();
    assert.equal(peekServeRowForTests(serve.id).lastHealthyAt, healthyAt);
  });

  test('dead pid with failed health becomes crashed, not unhealthy', async () => {
    const serve = await startServe({ modelPath, runtime: 'llama-cpp', async: true });
    await waitForStatus(serve.id, 'running');
    setServePidAliveOverrideForTests(() => false);
    setServeHeartbeatProbeOverrideForTests(async () => false);

    await tickServeHeartbeatForTests();
    const row = await getServe(serve.id);
    assert.equal(row.status, 'crashed');
  });
});
