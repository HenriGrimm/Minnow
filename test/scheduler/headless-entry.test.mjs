/**
 * Which script a scheduled run spawns: the tsx launcher in a checkout, the
 * shipped bundle in an installed build.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';
import { getMinnowHome, resetMinnowHomeCache } from '../../server/config/home.js';
import { closeSessionsDb } from '../../server/config/sessions-db.js';
import { HEADLESS_RUNNER_BUNDLE } from '../../server/constants/headless-runner.js';
import { resolveHeadlessRunEntry } from '../../server/scheduler/headless-entry.js';
import { getActiveRunCount, listRunsForJob, runStoredJob } from '../../server/scheduler/runner.js';
import { createJob, getStoredJobById } from '../../server/scheduler/store.js';
import { getAppRoot, setAppRoot } from '../../server/workspace/root.js';

/** Child that prints one result object and exits 0, recording how it was spawned. */
function recordingSpawn(calls) {
  return (execPath, args, options) => {
    calls.push({ execPath, args, options });
    const handlers = {};
    return {
      stdout: { on: (event, fn) => { if (event === 'data') handlers.stdout = fn; } },
      stderr: { on: () => undefined },
      on: (event, fn) => {
        if (event !== 'close') return;
        queueMicrotask(() => {
          handlers.stdout?.(Buffer.from(`${JSON.stringify({ ok: true, assistantFinal: 'done' })}\n`));
          fn(0);
        });
      },
      kill: () => undefined,
    };
  };
}

async function storedJob(label) {
  const job = await createJob({
    label,
    schedule: { kind: 'interval', value: '60s' },
    prompt: 'Say OK',
    modeId: 'build',
    channels: ['in_app'],
  });
  return getStoredJobById(job.id);
}

describe('scheduler headless entry', () => {
  const checkoutRoot = getAppRoot();
  const priorHome = process.env.MINNOW_HOME;
  /** @type {string} */
  let homeDir;
  /** @type {string} */
  let installDir;

  before(async () => {
    homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'minnow-scheduler-entry-home-'));
    installDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'minnow-scheduler-entry-install-'));
    process.env.MINNOW_HOME = homeDir;
    resetMinnowHomeCache();
  });

  afterEach(() => {
    setAppRoot(checkoutRoot);
  });

  after(async () => {
    closeSessionsDb();
    if (priorHome === undefined) delete process.env.MINNOW_HOME;
    else process.env.MINNOW_HOME = priorHome;
    resetMinnowHomeCache();
    await fsp.rm(homeDir, { recursive: true, force: true });
    await fsp.rm(installDir, { recursive: true, force: true });
  });

  async function writeBundle() {
    const bundle = path.join(installDir, HEADLESS_RUNNER_BUNDLE);
    await fsp.mkdir(path.dirname(bundle), { recursive: true });
    await fsp.writeFile(bundle, '// bundle stand-in\n', 'utf8');
    return bundle;
  }

  test('a checkout runs the tsx launcher from the app root', () => {
    const entry = resolveHeadlessRunEntry();
    assert.equal(entry.bundled, false);
    assert.equal(path.basename(entry.script), 'minnow.mjs');
    assert.ok(fs.existsSync(entry.script), 'bin/minnow.mjs exists in the repo');
    assert.equal(entry.cwd, checkoutRoot);
  });

  test('an installed build runs the shipped bundle from a real directory', async () => {
    const bundle = await writeBundle();
    setAppRoot(installDir, { packaged: true });

    const entry = resolveHeadlessRunEntry();
    assert.equal(entry.bundled, true);
    assert.equal(entry.script, bundle);
    // The packaged app root is app.asar, a file — never a usable cwd.
    assert.notEqual(entry.cwd, installDir);
    assert.equal(entry.cwd, getMinnowHome());
    assert.ok(fs.statSync(entry.cwd).isDirectory());
  });

  test('an installed build spawns the bundle with this host’s credential', async () => {
    const bundle = await writeBundle();
    const stored = await storedJob('Installed build run');
    setAppRoot(installDir, { packaged: true });

    const calls = [];
    const result = await runStoredJob(stored, {
      baseUrl: 'http://127.0.0.1:9473',
      spawn: recordingSpawn(calls),
    });

    assert.equal(result.status, 'completed');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args[0], bundle);
    assert.equal(calls[0].args[1], 'run');
    assert.equal(calls[0].options.cwd, getMinnowHome());
    assert.match(calls[0].options.env.MINNOW_TOKEN, /^[0-9a-f]{64}$/);
  });

  test('an installed build without the bundle fails the run with a reason', async () => {
    await fsp.rm(path.join(installDir, HEADLESS_RUNNER_BUNDLE), { force: true });
    const stored = await storedJob('Missing bundle');
    setAppRoot(installDir, { packaged: true });

    assert.throws(() => resolveHeadlessRunEntry(), /missing its headless runner/);

    const calls = [];
    const result = await runStoredJob(stored, { spawn: recordingSpawn(calls) });
    assert.equal(result.status, 'failed');
    assert.match(result.error, /missing its headless runner/);
    assert.equal(calls.length, 0);
    assert.equal(getActiveRunCount(), 0);

    const [run] = await listRunsForJob(stored.id);
    assert.equal(run.status, 'failed');
    assert.match(run.error, /missing its headless runner/);
    assert.equal((await getStoredJobById(stored.id)).running, false);
  });
});
