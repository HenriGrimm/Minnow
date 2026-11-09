/**
 * Crash watcher, restart policy, and commitServes snapshots.
 * Fake runs emit `exit` through the subscribeRun override — no llama-server spawn.
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
  listServes,
  patchServeRowForTests,
  peekServeRowForTests,
  resetServesForTests,
  setClassifyServeExitOverrideForTests,
  setServeBackgroundRunOverrideForTests,
  setServeHealthOverrideForTests,
  setServeRestartDelayMsForTests,
  setStopActiveRunOverrideForTests,
  setSubscribeRunOverrideForTests,
  shouldAutoRestartServe,
  startServe,
  stopServe,
  subscribeServeEvents,
  waitForServeRestartsForTests,
  waitForServeCrashHandlersForTests,
} from '../../server/models/serve.js';

const RUN_ID_1 = 'test-run-crash-1';
const RUN_ID_2 = 'test-run-crash-2';
const PID_1 = 4242;
const PID_2 = 4243;
const THIRTY_ONE_S = 31_000;

/** @type {Map<string, Array<(event: object) => void>>} */
const runListeners = new Map();
let runSeq = 0;

async function waitForRunListener(runId, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((runListeners.get(runId) ?? []).length > 0) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`subscribeRun never attached for ${runId}`);
}

async function waitForStatus(serveId, status, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const serve = await getServe(serveId);
    if (serve && serve.status === status) return serve;
    await new Promise((r) => setTimeout(r, 25));
  }
  return getServe(serveId);
}

function emitRunExit(runId, event) {
  for (const listener of runListeners.get(runId) ?? []) {
    listener(event);
  }
}

describe('serve crash watcher', () => {
  /** @type {string} */
  let homeDir;
  /** @type {string} */
  let modelPath;

  before(async () => {
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-serve-crash-'));
    process.env.MINNOW_HOME = homeDir;
    resetMinnowHomeCache();

    modelPath = path.join(homeDir, 'crash-model.gguf');
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
    runListeners.clear();
    runSeq = 0;
    setServeRestartDelayMsForTests(0);
    setServeHealthOverrideForTests(async () => true);
    setServeBackgroundRunOverrideForTests(async () => {
      runSeq += 1;
      return {
        runId: runSeq === 1 ? RUN_ID_1 : RUN_ID_2,
        pid: runSeq === 1 ? PID_1 : PID_2,
      };
    });
    setSubscribeRunOverrideForTests((runId, listener) => {
      const list = runListeners.get(runId) ?? [];
      list.push(listener);
      runListeners.set(runId, list);
      return () => {
        runListeners.set(
          runId,
          (runListeners.get(runId) ?? []).filter((cb) => cb !== listener),
        );
      };
    });
  });

  after(async () => {
    // Drain crash persist before swapping MINNOW_HOME so commitServes cannot hit a deleted path.
    await waitForServeCrashHandlersForTests();
    delete process.env.MINNOW_HOME;
    resetMinnowHomeCache();
    await resetServesForTests();
    await fs.rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  test('shouldAutoRestartServe is one-shot and never restarts oom_vram', () => {
    const row = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      restartCount: 0,
      lastHealthyAt: 1_700_000_000_000,
      startedAt: 1_700_000_000_000,
    };
    const now = 1_700_000_000_000 + THIRTY_ONE_S;
    assert.equal(shouldAutoRestartServe(row, { code: 'unknown' }, now), true);
    assert.equal(shouldAutoRestartServe(row, { code: 'transient' }, now), true);
    assert.equal(shouldAutoRestartServe(row, { code: 'port_conflict' }, now), true);
    assert.equal(shouldAutoRestartServe(row, { code: 'oom_vram' }, now), false);
    assert.equal(shouldAutoRestartServe({ ...row, restartCount: 1 }, { code: 'unknown' }, now), false);
    assert.equal(shouldAutoRestartServe(row, { code: 'unknown' }, 1_700_000_000_000 + 5_000), false);
  });

  test('fake run exit flips the row to crashed with exitCode and unknown failure', async () => {
    const serve = await startServe({ modelPath, runtime: 'llama-cpp', async: true });
    await waitForStatus(serve.id, 'running');
    await waitForRunListener(RUN_ID_1);

    emitRunExit(RUN_ID_1, { type: 'exit', code: 1 });
    const crashed = await waitForStatus(serve.id, 'crashed');
    assert.equal(crashed.status, 'crashed');
    assert.equal(crashed.exitCode, 1);
    assert.equal(crashed.failure?.code, 'unknown');
    assert.equal(crashed.failure?.exitCode, 1);
  });

  test('unknown classification schedules exactly one restart after a healthy stretch', async () => {
    const serve = await startServe({ modelPath, runtime: 'llama-cpp', async: true });
    await waitForStatus(serve.id, 'running');
    await waitForRunListener(RUN_ID_1);
    patchServeRowForTests(serve.id, { lastHealthyAt: Date.now() - THIRTY_ONE_S });

    emitRunExit(RUN_ID_1, { type: 'exit', code: 1 });
    // Wait until persist + scheduleAutoRestart finish; Windows disk I/O can lag the restart.
    await waitForServeCrashHandlersForTests();
    await waitForStatus(serve.id, 'crashed');
    assert.equal(peekServeRowForTests(serve.id)?.restartCount, 1);

    await waitForServeRestartsForTests();
    const serves = await listServes();
    assert.equal(serves.length, 2);
    const crashed = serves.find((s) => s.id === serve.id);
    const restarted = serves.find((s) => s.id !== serve.id);
    assert.equal(crashed?.status, 'crashed');
    assert.ok(restarted, 'expected a second serve from auto-restart');
    assert.ok(restarted.status === 'starting' || restarted.status === 'running');
    assert.equal(restarted.modelPath, modelPath);
  });

  test('oom_vram never auto-restarts', async () => {
    setClassifyServeExitOverrideForTests(() => ({ code: 'oom_vram' }));
    const serve = await startServe({ modelPath, runtime: 'llama-cpp', async: true });
    await waitForStatus(serve.id, 'running');
    await waitForRunListener(RUN_ID_1);
    patchServeRowForTests(serve.id, { lastHealthyAt: Date.now() - THIRTY_ONE_S });

    emitRunExit(RUN_ID_1, { type: 'exit', code: 1 });
    const crashed = await waitForStatus(serve.id, 'crashed');
    assert.equal(crashed.failure?.code, 'oom_vram');
    assert.equal(peekServeRowForTests(serve.id)?.restartCount ?? 0, 0);

    await waitForServeRestartsForTests();
    const serves = await listServes();
    assert.equal(serves.length, 1);
    assert.equal(serves[0].status, 'crashed');
  });

  test('user stopServe does not mark crashed', async () => {
    setStopActiveRunOverrideForTests(async (runId) => {
      assert.equal(runId, RUN_ID_1);
      return { ok: true };
    });
    const serve = await startServe({ modelPath, runtime: 'llama-cpp', async: true });
    await waitForStatus(serve.id, 'running');
    await waitForRunListener(RUN_ID_1);
    await stopServe(serve.id);
    emitRunExit(RUN_ID_1, { type: 'exit', code: 0, stopped: true });
    const row = await getServe(serve.id);
    assert.equal(row.status, 'stopped');
  });

  test('commitServes emits snapshots listeners can collect without HTTP', async () => {
    /** @type {Array<{ reason: string, serves: object[] }>} */
    const events = [];
    const unsub = subscribeServeEvents((payload) => {
      events.push(payload);
    });
    try {
      assert.equal(events[0]?.reason, 'subscribe');
      const serve = await startServe({ modelPath, runtime: 'llama-cpp', async: true });
      await waitForStatus(serve.id, 'running');
      const reasons = events.map((e) => e.reason);
      assert.ok(reasons.includes('llama-starting'), `missing llama-starting in ${reasons.join(',')}`);
      assert.ok(reasons.includes('llama-spawned'), `missing llama-spawned in ${reasons.join(',')}`);
      assert.ok(events.some((e) => e.serves.some((s) => s.id === serve.id)));
    } finally {
      unsub();
    }
  });
});
