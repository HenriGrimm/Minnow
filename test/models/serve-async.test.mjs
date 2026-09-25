/**
 * Non-blocking serve start — the Local Server surface polls a starting model
 * instead of hanging on the request until llama.cpp is healthy.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import {
  getServe,
  resetServePidAliveOverrideForTests,
  resetServesForTests,
  setServeBackgroundRunOverrideForTests,
  setServeHealthOverrideForTests,
  setServePidAliveOverrideForTests,
  startServe,
  stopServe,
} from '../../server/models/serve.js';

/** Poll getServe until it leaves 'starting', or give up. */
async function waitForStatus(serveId, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const serve = await getServe(serveId);
    if (serve && serve.status !== 'starting') return serve;
    await new Promise((r) => setTimeout(r, 25));
  }
  return getServe(serveId);
}

describe('async serve start', () => {
  /** @type {string} */
  let homeDir;
  /** @type {string} */
  let modelPath;
  before(async () => {
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-serve-async-'));
    process.env.MINNOW_HOME = homeDir;
    resetMinnowHomeCache();
    await resetServesForTests();

    modelPath = path.join(homeDir, 'test-model.gguf');
    await fs.writeFile(modelPath, 'GGUF');

    const managedRoot = path.join(homeDir, 'models-runtime', 'llama-cpp');
    await fs.mkdir(managedRoot, { recursive: true });
    const binName = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
    await fs.writeFile(path.join(managedRoot, binName), '');
    await fs.writeFile(
      path.join(managedRoot, 'meta.json'),
      `${JSON.stringify({ variant: 'cpu', version: 'test', path: path.join(managedRoot, binName) })}\n`,
    );

    setServeBackgroundRunOverrideForTests(async () => ({ runId: 'test-run', pid: 12345 }));
  });

  after(async () => {
    delete process.env.MINNOW_HOME;
    resetMinnowHomeCache();
    await resetServesForTests();
    await fs.rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  test('async:true returns while the model is still loading', async () => {
    // Hold the health probe open so "still loading" is a real state, not a race.
    let releaseHealth;
    const healthGate = new Promise((resolve) => {
      releaseHealth = resolve;
    });
    setServeHealthOverrideForTests(async () => {
      await healthGate;
      return true;
    });

    const serve = await startServe({ modelPath, runtime: 'llama-cpp', async: true });
    assert.equal(serve.status, 'starting');
    assert.equal(serve.runId, 'test-run');

    const pending = await getServe(serve.id);
    assert.equal(pending.status, 'starting', 'still loading right after the call returns');

    releaseHealth();
    const settled = await waitForStatus(serve.id, 8_000);
    assert.equal(settled.status, 'running');
    assert.ok(settled.baseUrl.startsWith('http://127.0.0.1:'));

    await stopServe(serve.id);
  });

  test('eject while loading cannot resurrect the model after health settles', async () => {
    let releaseHealth;
    const healthGate = new Promise((resolve) => {
      releaseHealth = resolve;
    });
    setServeHealthOverrideForTests(async () => {
      await healthGate;
      return true;
    });
    setServePidAliveOverrideForTests(() => false);

    try {
      const serve = await startServe({ modelPath, runtime: 'llama-cpp', async: true });
      const stopped = await stopServe(serve.id);
      assert.equal(stopped.status, 'stopped');

      releaseHealth();
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal((await getServe(serve.id)).status, 'stopped');
    } finally {
      resetServePidAliveOverrideForTests();
    }
  });

  test('eject does not claim success while the model process is still alive', async () => {
    setServeHealthOverrideForTests(async () => true);
    setServePidAliveOverrideForTests(() => true);

    const serve = await startServe({ modelPath, runtime: 'llama-cpp', async: true });
    try {
      await assert.rejects(() => stopServe(serve.id), /unknown run_id/);
      assert.notEqual((await getServe(serve.id)).status, 'stopped');
    } finally {
      setServePidAliveOverrideForTests(() => false);
      await stopServe(serve.id);
      resetServePidAliveOverrideForTests();
    }
  });

  test('a failed async start surfaces the error on the record', async () => {
    setServeHealthOverrideForTests(async () => false);

    const serve = await startServe({ modelPath, runtime: 'llama-cpp', async: true });
    assert.equal(serve.status, 'starting');

    const settled = await waitForStatus(serve.id, 8_000);
    assert.equal(settled.status, 'error');
    assert.match(settled.error, /healthy/i);
  });

  test('port_conflict on load retries once on a fresh port', async () => {
    let calls = 0;
    setServeHealthOverrideForTests(async () => {
      calls += 1;
      if (calls === 1) {
        return {
          ok: false,
          error: 'exited',
          logTail: 'error binding to 127.0.0.1:8085: EADDRINUSE',
          exitCode: 1,
        };
      }
      return true;
    });

    const serve = await startServe({ modelPath, runtime: 'llama-cpp', async: true });
    const settled = await waitForStatus(serve.id, 8_000);
    assert.equal(settled.status, 'running');
    assert.equal(calls, 2, 'health probed twice: fail then retry');
    assert.ok(settled.port > 0);
    await stopServe(serve.id);
  });

  test('bad_template on load retries once without --jinja', async () => {
    const argLists = [];
    setServeBackgroundRunOverrideForTests(async (opts) => {
      argLists.push(opts.args ?? []);
      return { runId: `jinja-run-${argLists.length}`, pid: 12345 };
    });
    let calls = 0;
    setServeHealthOverrideForTests(async () => {
      calls += 1;
      if (calls === 1) {
        return {
          ok: false,
          error: 'exited',
          logTail: 'minja error: Failed to parse chat template: unexpected token',
          exitCode: 1,
        };
      }
      return true;
    });

    try {
      const serve = await startServe({ modelPath, runtime: 'llama-cpp', async: true });
      const settled = await waitForStatus(serve.id, 8_000);
      assert.equal(settled.status, 'running');
      assert.ok(argLists.length >= 2, 'expected a second spawn without --jinja');
      assert.ok(argLists[0].includes('--jinja'));
      assert.equal(argLists[1].includes('--jinja'), false);
      await stopServe(serve.id);
    } finally {
      setServeBackgroundRunOverrideForTests(async () => ({ runId: 'test-run', pid: 12345 }));
    }
  });

  test('oom_vram on load stores failure.title and does not retry-loop', async () => {
    let calls = 0;
    setServeHealthOverrideForTests(async () => {
      calls += 1;
      return {
        ok: false,
        error: 'exited',
        logTail: 'cudaMalloc failed: out of memory',
        exitCode: 1,
      };
    });

    const serve = await startServe({ modelPath, runtime: 'llama-cpp', async: true });
    const settled = await waitForStatus(serve.id, 8_000);
    assert.equal(settled.status, 'error');
    assert.equal(settled.failure?.code, 'oom_vram');
    assert.equal(settled.failure?.title, 'Needs more VRAM');
    assert.match(settled.error, /VRAM/i);
    assert.equal(calls, 1, 'OOM must not auto-retry the same load');
  });

  test('the blocking path still throws for callers that did not opt in', async () => {
    setServeHealthOverrideForTests(async () => false);
    await assert.rejects(
      () => startServe({ modelPath, runtime: 'llama-cpp' }),
      /healthy/i,
    );
  });

  test('getServe rejects an id that is not a uuid', async () => {
    await assert.rejects(() => getServe('../etc/passwd'), /Invalid/i);
  });
});
