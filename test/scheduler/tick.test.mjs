/**
 * Scheduler restart and sleep-gap recovery tests.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { createJob, listJobs } from '../../server/scheduler/store.js';
import {
  getSchedulerRuntimeStatus,
  resetSchedulerTickForTests,
  runSchedulerTick,
} from '../../server/scheduler/tick.js';

let homeDir;

before(async () => {
  homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-scheduler-tick-'));
  process.env.MINNOW_HOME = homeDir;
  resetMinnowHomeCache();
  resetSchedulerTickForTests();
});

after(async () => {
  resetSchedulerTickForTests();
  delete process.env.MINNOW_HOME;
  resetMinnowHomeCache();
  await fs.rm(homeDir, { recursive: true, force: true });
});

test('a sleep-sized timer gap runs one catch-up and advances skip jobs', async () => {
  const runOnce = await createJob({
    label: 'Wake catch-up',
    schedule: { kind: 'interval', value: '60s' },
    prompt: 'catch up',
    modeId: 'build',
    channels: ['in_app'],
    missedRunPolicy: 'run_once',
  });
  const skip = await createJob({
    label: 'Wake skip',
    schedule: { kind: 'interval', value: '60s' },
    prompt: 'skip',
    modeId: 'build',
    channels: ['in_app'],
    missedRunPolicy: 'skip',
  });

  const firstTick = new Date('2026-06-14T12:00:00.000Z');
  const filePath = path.join(homeDir, 'scheduler.json');
  const raw = JSON.parse(await fs.readFile(filePath, 'utf8'));
  for (const job of raw.jobs) job.nextRunAt = '2026-06-14T12:01:00.000Z';
  await fs.writeFile(filePath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');

  const dispatchedIds = [];
  const runJob = async (job) => {
    dispatchedIds.push(job.id);
    return { started: true };
  };
  const activeRunCount = () => 0;

  await runSchedulerTick({
    now: firstTick,
    skipGapRecovery: true,
    runJob,
    activeRunCount,
  });
  const wakeResult = await runSchedulerTick({
    now: new Date('2026-06-14T12:10:00.000Z'),
    runJob,
    activeRunCount,
  });

  assert.equal(wakeResult.dispatched, 1);
  assert.deepEqual(dispatchedIds, [runOnce.id]);
  const jobs = await listJobs();
  assert.equal(jobs.find((job) => job.id === skip.id)?.nextRunAt, '2026-06-14T12:11:00.000Z');

  const status = getSchedulerRuntimeStatus();
  assert.equal(status.lastRecoveryReason, 'timer_gap');
  assert.equal(status.catchUpQueued, 0);
  assert.equal(status.catchUpRunsStarted, 1);
  assert.equal(status.missedSkipped, 1);
});
