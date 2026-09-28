/**
 * Scheduler store validation and job cap tests.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import {
  MAX_SCHEDULER_JOBS,
  createJob,
  deleteJob,
  listJobs,
  updateJob,
} from '../../server/scheduler/store.js';

/** @type {string} */
let homeDir;

before(async () => {
  homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-scheduler-store-'));
  process.env.MINNOW_HOME = homeDir;
  resetMinnowHomeCache();
});

after(async () => {
  delete process.env.MINNOW_HOME;
  resetMinnowHomeCache();
  await fs.rm(homeDir, { recursive: true, force: true });
});

describe('scheduler store', () => {
  test('creates interval job with encrypted prompt at rest', async () => {
    const job = await createJob({
      label: 'Daily summary',
      schedule: { kind: 'interval', value: '5m' },
      prompt: 'Summarize open bugs',
      modeId: 'build',
      channels: ['in_app'],
    });

    assert.equal(job.label, 'Daily summary');
    assert.equal(job.prompt, 'Summarize open bugs');
    assert.ok(job.nextRunAt);

    const raw = await fs.readFile(path.join(homeDir, 'scheduler.json'), 'utf8');
    const parsed = JSON.parse(raw);
    assert.ok(parsed.jobs[0].promptEnc?.encrypted);
    assert.equal(parsed.jobs[0].promptEnc.encrypted, true);
  });

  test('rejects interval below 60 seconds', async () => {
    await assert.rejects(
      () =>
        createJob({
          label: 'Too fast',
          schedule: { kind: 'interval', value: '30s' },
          prompt: 'nope',
          modeId: 'build',
          channels: ['in_app'],
        }),
      /at least 60 seconds/,
    );
  });

  test('rejects invalid cron expressions', async () => {
    await assert.rejects(
      () =>
        createJob({
          label: 'Bad cron',
          schedule: { kind: 'cron', value: 'not-a-cron' },
          prompt: 'nope',
          modeId: 'build',
          channels: ['in_app'],
        }),
      /Invalid cron expression/,
    );
  });

  test('updates and deletes jobs', async () => {
    const job = await createJob({
      label: 'Mutable',
      schedule: { kind: 'interval', value: '2m' },
      prompt: 'first',
      modeId: 'plan',
      channels: ['in_app'],
    });

    const updated = await updateJob(job.id, {
      label: 'Mutable v2',
      prompt: 'second',
      schedule: { kind: 'interval', value: '10m' },
    });
    assert.equal(updated.label, 'Mutable v2');
    assert.equal(updated.prompt, 'second');

    await deleteJob(job.id);
    const jobs = await listJobs();
    assert.ok(!jobs.some((row) => row.id === job.id));
  });

  test('round-trips providerId and modelId on create and update', async () => {
    const created = await createJob({
      label: 'Pinned model job',
      schedule: { kind: 'interval', value: '60s' },
      prompt: 'run with model',
      modeId: 'build',
      providerId: 'lmstudio',
      modelId: 'qwen/qwen3-8b',
      channels: ['in_app'],
    });
    assert.equal(created.providerId, 'lmstudio');
    assert.equal(created.modelId, 'qwen/qwen3-8b');

    const cleared = await updateJob(created.id, {
      label: 'Pinned model job',
      prompt: 'run with model',
      schedule: { kind: 'interval', value: '60s' },
      modeId: 'build',
      providerId: '',
      modelId: '',
      channels: ['in_app'],
    });
    assert.equal(cleared.providerId, undefined);
    assert.equal(cleared.modelId, undefined);
  });

  test('enforces max job count', async () => {
    const existing = await listJobs();
    for (let i = existing.length; i < MAX_SCHEDULER_JOBS; i += 1) {
      await createJob({
        label: `Job ${i}`,
        schedule: { kind: 'interval', value: '60s' },
        prompt: `prompt ${i}`,
        modeId: 'build',
        channels: ['in_app'],
      });
    }

    await assert.rejects(
      () =>
        createJob({
          label: 'Overflow',
          schedule: { kind: 'interval', value: '60s' },
          prompt: 'one too many',
          modeId: 'build',
          channels: ['in_app'],
        }),
      /Maximum of 50/,
    );
  });
});
