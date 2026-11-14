/**
 * Automations presets and manual schedules in the scheduler store.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { createJob, updateJob } from '../../server/scheduler/store.js';

let homeDir;

before(async () => {
  homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-scheduler-presets-'));
  process.env.MINNOW_HOME = homeDir;
  resetMinnowHomeCache();
});

after(async () => {
  delete process.env.MINNOW_HOME;
  resetMinnowHomeCache();
  await fs.rm(homeDir, { recursive: true, force: true });
});

describe('automation presets in the store', () => {
  test('prompt presets write their instructions from the config', async () => {
    const job = await createJob({
      label: 'CI Fixer',
      schedule: { kind: 'interval', value: '10m' },
      preset: { id: 'ci-fixer', config: { repository: 'o/r', branch: 'trunk', openPr: false, injected: 'x' } },
      channels: ['in_app'],
    });
    assert.equal(job.preset.id, 'ci-fixer');
    assert.equal(job.preset.config.injected, undefined);
    assert.match(job.prompt, /trunk/);
    assert.match(job.prompt, /Do not change files/);
    assert.equal(job.modeId, 'build');

    const updated = await updateJob(job.id, { preset: { id: 'ci-fixer', config: { repository: 'o/r', branch: 'trunk', openPr: true } } });
    assert.match(updated.prompt, /open a PR/);
  });

  test('custom instructions survive config edits', async () => {
    const job = await createJob({
      label: 'Digest',
      schedule: { kind: 'cron', value: '0 9 * * 1-5' },
      prompt: 'My own words',
      preset: { id: 'standup-digest', config: {}, customInstructions: true },
      channels: ['in_app'],
    });
    assert.equal(job.prompt, 'My own words');
  });

  test('PR Reviewer requires a checkout and takes its interval from the config', async () => {
    await assert.rejects(createJob({
      label: 'PR Reviewer', schedule: { kind: 'interval', value: '2m' },
      preset: { id: 'pr-review', config: { repository: 'o/r' } }, channels: ['in_app'],
    }), /checkout/);
    const job = await createJob({
      label: 'PR Reviewer', schedule: { kind: 'interval', value: '15m' }, workspacePath: homeDir,
      preset: { id: 'pr-review', config: { repository: 'o/r', interval: '5m' } }, channels: ['in_app'],
    });
    assert.deepEqual(job.schedule, { kind: 'interval', value: '5m' });
    assert.match(job.prompt, /oldest first/);
  });

  test('manual automations have no next run', async () => {
    const job = await createJob({
      label: 'On demand', schedule: { kind: 'manual', value: 'manual' }, prompt: 'Do it', channels: ['in_app'],
    });
    assert.equal(job.schedule.kind, 'manual');
    assert.equal(job.nextRunAt, undefined);
  });
});
