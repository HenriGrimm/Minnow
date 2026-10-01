import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { after, before, test } from 'node:test';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { closeSessionsDb } from '../../server/config/sessions-db.js';
import { createJob, getStoredJobById, mutateStoredJob } from '../../server/scheduler/store.js';
import { getActiveRunCount, startStoredJob } from '../../server/scheduler/runner.js';
import { runSchedulerTick } from '../../server/scheduler/tick.js';
import { schedulerRunHistoryPath } from '../../server/scheduler/paths.js';

let home;
before(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-tick-'));
  process.env.MINNOW_HOME = home;
  resetMinnowHomeCache();
});
after(async () => {
  closeSessionsDb();
  delete process.env.MINNOW_HOME;
  resetMinnowHomeCache();
  await fs.rm(home, { recursive: true, force: true });
});

async function until(predicate) {
  for (let i = 0; i < 1000; i++) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.fail('scheduler condition did not settle');
}

function heldChildren() {
  const children = [];
  const spawn = (_exe, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => child.emit('close', 1);
    child.prompt = args[args.indexOf('--prompt') + 1];
    child.finish = (code = 0) => {
      child.stdout.emit('data', Buffer.from('{"ok":true}\n'));
      child.emit('close', code);
    };
    children.push(child);
    return child;
  };
  return { spawn, children };
}

test('tick fills two slots, returns before completion, and admits oldest waiting job next', async () => {
  const now = new Date('2026-10-01T12:00:00Z');
  const jobs = [];
  for (const [index, label] of ['Z oldest', 'Y second', 'A third'].entries()) {
    const job = await createJob({ label, prompt: label, schedule: { kind: 'interval', value: '60s' } });
    await mutateStoredJob(job.id, row => ({ ...row, nextRunAt: new Date(now.getTime() - (3 - index) * 60000).toISOString() }));
    jobs.push(job);
  }
  const fake = heldChildren();
  try {
    const [first, overlap] = await Promise.all([
      runSchedulerTick({ now, spawn: fake.spawn }),
      runSchedulerTick({ now, spawn: fake.spawn }),
    ]);
    assert.deepEqual(first, { dispatched: 2 });
    assert.deepEqual(overlap, { dispatched: 0, skipped: 'tick_in_progress' });
    assert.equal(getActiveRunCount(), 2);
    assert.deepEqual(startStoredJob(await getStoredJobById(jobs[0].id), { spawn: fake.spawn }), { started: false, reason: 'already_running' });
    assert.deepEqual(startStoredJob(await getStoredJobById(jobs[2].id), { spawn: fake.spawn }), { started: false, reason: 'concurrency_cap' });
    await until(() => fake.children.length === 2);
    assert.deepEqual(fake.children.map(child => child.prompt), ['Z oldest', 'Y second']);
    assert.deepEqual(await runSchedulerTick({ now, spawn: fake.spawn }), { dispatched: 0 });
    fake.children[0].finish(1);
    await until(() => getActiveRunCount() === 1);
    assert.deepEqual(await runSchedulerTick({ now, spawn: fake.spawn }), { dispatched: 1 });
    await until(() => fake.children.length === 3);
    assert.equal(fake.children[2].prompt, 'A third');
    assert.equal((await getStoredJobById(jobs[0].id)).running, false);
    assert.equal((await getStoredJobById(jobs[1].id)).running, true);
  } finally {
    await until(() => {
      for (const child of fake.children) child.finish();
      return getActiveRunCount() === 0;
    });
    for (const job of jobs) await mutateStoredJob(job.id, row => ({ ...row, enabled: false }));
  }
});

test('preparation failure settles independently and frees its reserved slot', async () => {
  const bad = await createJob({ label: 'Corrupt', prompt: 'bad', schedule: { kind: 'interval', value: '60s' } });
  const good = await createJob({ label: 'Good', prompt: 'good', schedule: { kind: 'interval', value: '60s' } });
  await mutateStoredJob(bad.id, row => ({ ...row, promptEnc: 'corrupt' }));
  const fake = heldChildren();
  const failed = startStoredJob(await getStoredJobById(bad.id), { spawn: fake.spawn });
  const running = startStoredJob(await getStoredJobById(good.id), { spawn: fake.spawn });
  assert.equal(failed.started, true);
  assert.equal(running.started, true);
  assert.equal((await failed.completion).status, 'failed');
  assert.equal(getActiveRunCount(), 1);
  await until(() => fake.children.length === 1);
  fake.children[0].finish();
  assert.equal((await running.completion).status, 'completed');
  assert.equal(getActiveRunCount(), 0);
});

test('run-history persistence rejection clears running state and does not block its sibling', async () => {
  const bad = await createJob({ label: 'History blocked', prompt: 'bad', schedule: { kind: 'interval', value: '60s' } });
  const good = await createJob({ label: 'History good', prompt: 'good', schedule: { kind: 'interval', value: '60s' } });
  // A directory where the JSON file belongs reproduces a real filesystem
  // rejection on Windows and Unix without permission-dependent fixtures.
  await fs.mkdir(schedulerRunHistoryPath(bad.id), { recursive: true });
  const fake = heldChildren();
  const failed = startStoredJob(await getStoredJobById(bad.id), { spawn: fake.spawn });
  const running = startStoredJob(await getStoredJobById(good.id), { spawn: fake.spawn });
  await assert.rejects(failed.completion);
  assert.equal((await getStoredJobById(bad.id)).running, false);
  assert.equal(getActiveRunCount(), 1);
  await until(() => fake.children.length === 1);
  fake.children[0].finish();
  assert.equal((await running.completion).status, 'completed');
  assert.equal(getActiveRunCount(), 0);
});
