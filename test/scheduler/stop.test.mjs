import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { getLiveRun, resetLiveRunsForTests } from '../../server/scheduler/live-runs.js';
import {
  getActiveRunCount, getActiveRunIdForJob, listRunsForJob,
  runHeadlessSubRun, startJobNow, stopSchedulerRun,
} from '../../server/scheduler/runner.js';
import { createJob, getStoredJobById, mutateStoredJob } from '../../server/scheduler/store.js';
import { runSchedulerTick } from '../../server/scheduler/tick.js';

async function until(predicate) {
  for (let i = 0; i < 1000; i++) {
    if (predicate()) return;
    await delay(5);
  }
  assert.fail('Scheduler did not settle');
}

async function setup(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-scheduler-stop-'));
  const previous = process.env.MINNOW_HOME;
  process.env.MINNOW_HOME = home;
  resetMinnowHomeCache();
  const finish = [];
  t.after(async () => {
    try {
      for (const close of finish.reverse()) await close();
      await until(() => getActiveRunCount() === 0);
    } finally {
      resetLiveRunsForTests();
      if (previous === undefined) delete process.env.MINNOW_HOME;
      else process.env.MINNOW_HOME = previous;
      resetMinnowHomeCache();
      await fs.rm(home, { recursive: true, force: true });
    }
  });
  const add = (label) => createJob({
    label, prompt: 'Fixture', modelId: 'fake-model', workspacePath: home,
    schedule: { kind: 'interval', value: '60s' },
  });
  const start = (job, spawn) => startJobNow(job.id, { spawn, timeoutMs: 5_000 });
  return { add, start, finish, home };
}

// Block at the last awaited launch-preparation operation, without a production hook.
function holdResultDirectory(t, finish, { fail = false } = {}) {
  const original = fs.mkdtemp;
  const gate = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const mock = t.mock.method(fs, 'mkdtemp', async (prefix, ...args) => {
    if (path.basename(prefix) !== 'minnow-run-') return original(prefix, ...args);
    const dir = fail ? null : await original(prefix, ...args);
    entered.resolve(dir);
    await gate.promise;
    if (fail) throw new Error('fixture preparation failure');
    return dir;
  });
  finish.push(() => gate.resolve());
  return { entered: entered.promise, release: () => { mock.mock.restore(); gate.resolve(); } };
}

function fakeChild() {
  const child = new EventEmitter();
  child.signals = [];
  child.kill = signal => child.signals.push(signal);
  return child;
}

async function assertCancelled(job, runId, trigger) {
  const rows = await listRunsForJob(job.id);
  assert.deepEqual(rows.map(row => [row.id, row.trigger, row.status]), [[runId, trigger, 'cancelled']]);
  assert.equal(getLiveRun(runId).status, 'cancelled');
  assert.equal((await getStoredJobById(job.id)).running, false);
  assert.equal(stopSchedulerRun(runId).reason, 'not_running');
}

for (const [trigger, fail] of [['manual', false], ['schedule', false], ['manual', true]]) {
  test(`Stop during ${trigger} preparation ${fail ? 'wins over late failure' : 'prevents spawn'}`, { timeout: 10_000 }, async t => {
    const { add, start, finish } = await setup(t);
    const job = await add(trigger);
    const gate = holdResultDirectory(t, finish, { fail });
    let spawns = 0;
    const spawn = () => {
      spawns++;
      const child = fakeChild();
      queueMicrotask(() => child.emit('close', 0));
      return child;
    };
    let runId;
    if (trigger === 'manual') {
      ({ runId } = await start(job, spawn));
    } else {
      const now = new Date();
      await mutateStoredJob(job.id, row => ({ ...row, nextRunAt: now.toISOString() }));
      assert.deepEqual(await runSchedulerTick({ now, spawn }), { dispatched: 1 });
      runId = getActiveRunIdForJob(job.id);
    }
    const dir = await gate.entered;
    assert.deepEqual(stopSchedulerRun(runId), { ok: true });
    gate.release();
    await until(() => getActiveRunCount() === 0);
    assert.equal(spawns, 0);
    await assertCancelled(job, runId, trigger);
    if (dir) await assert.rejects(fs.access(dir), { code: 'ENOENT' });
  });
}

test('Stop signals only the owned child and holds its slot through settlement', { timeout: 10_000 }, async t => {
  const { add, start, finish } = await setup(t);
  const target = await add('Target');
  const other = await add('Other');
  const waiting = await add('Waiting');
  const children = [];
  const spawn = () => {
    const child = fakeChild();
    children.push(child);
    finish.push(() => child.emit('close', 0));
    return child;
  };
  const { runId } = await start(target, spawn);
  await until(() => children.length === 1);
  const otherRun = await start(other, spawn);
  await until(() => children.length === 2);
  assert.deepEqual(stopSchedulerRun(runId), { ok: true });
  assert.deepEqual(children.map(child => child.signals), [['SIGTERM'], []]);
  assert.deepEqual(await start(waiting, spawn), { started: false, reason: 'concurrency_cap' });
  children[0].emit('close', 1);
  await until(() => getActiveRunCount() === 1);
  await assertCancelled(target, runId, 'manual');
  assert.equal((await start(waiting, spawn)).started, true);
  await until(() => children.length === 3);
  children[1].emit('close', 0);
  children[2].emit('close', 0);
  await until(() => getActiveRunCount() === 0);
  assert.deepEqual((await listRunsForJob(other.id)).map(row => [row.id, row.status]), [[otherRun.runId, 'completed']]);
});

for (const fail of [false, true]) {
  test(`Stop during reviewer preparation ${fail ? 'wins over late failure' : 'prevents spawn'}`, { timeout: 10_000 }, async t => {
    const { add, start, finish, home } = await setup(t);
    const job = await add('Reviewer parent');
    const parent = fakeChild();
    let spawnedParent = false;
    finish.push(() => parent.emit('close', 1));
    const { runId } = await start(job, () => { spawnedParent = true; return parent; });
    await until(() => spawnedParent);
    const gate = holdResultDirectory(t, finish, { fail });
    let reviewerSpawns = 0;
    const review = runHeadlessSubRun({
      storedJob: await getStoredJobById(job.id), parentRunId: runId, role: 'tests',
      roleLabel: 'Tests', prompt: 'Review fixture', workspacePath: home,
      spawn: () => {
        reviewerSpawns++;
        const child = fakeChild();
        queueMicrotask(() => child.emit('close', 0));
        return child;
      },
    });
    finish.unshift(() => review);
    const dir = await gate.entered;
    assert.deepEqual(stopSchedulerRun(runId), { ok: true });
    assert.deepEqual(parent.signals, ['SIGTERM']);
    gate.release();
    const reviewer = await review;
    assert.equal(reviewerSpawns, 0);
    assert.equal(reviewer.status, 'cancelled');
    assert.equal(getLiveRun(runId).children[0].status, 'cancelled');
    if (dir) await assert.rejects(fs.access(dir), { code: 'ENOENT' });
    parent.emit('close', 1);
    await until(() => getActiveRunCount() === 0);
    await assertCancelled(job, runId, 'manual');
  });
}
