/**
 * Scheduler lifecycle shared by both hosts (server.js and the Electron
 * in-process server).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { startSchedulerForHost, stopSchedulerForHost } from '../../server/scheduler/host.js';
import { getSchedulerServerBaseUrl } from '../../server/scheduler/server-base-url.js';
import { createJob, getStoredJobById, mutateStoredJob } from '../../server/scheduler/store.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let home;
const priorHome = process.env.MINNOW_HOME;

before(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-scheduler-host-'));
  process.env.MINNOW_HOME = home;
  resetMinnowHomeCache();
});

after(async () => {
  stopSchedulerForHost();
  if (priorHome === undefined) delete process.env.MINNOW_HOME;
  else process.env.MINNOW_HOME = priorHome;
  resetMinnowHomeCache();
  if (home) await fs.rm(home, { recursive: true, force: true });
});

/** A job left `running` by a process that no longer exists. */
async function orphanJob(label) {
  const job = await createJob({
    label,
    schedule: { kind: 'interval', value: '60s' },
    prompt: 'Say OK',
    modeId: 'build',
    channels: ['in_app'],
  });
  await mutateStoredJob(job.id, (stored) => ({ ...stored, running: true }));
  return job.id;
}

test('starting records the host origin and runs startup recovery', async () => {
  const jobId = await orphanJob('Orphaned before start');

  await startSchedulerForHost('http://127.0.0.1:4321/');

  assert.equal(getSchedulerServerBaseUrl(), 'http://127.0.0.1:4321');
  assert.equal((await getStoredJobById(jobId)).running, false);
});

test('stopping ends the loop, so the next start begins a new one', async () => {
  const jobId = await orphanJob('Orphaned while running');

  // Still started from the previous test: a second start is a no-op.
  await startSchedulerForHost('http://127.0.0.1:4321');
  assert.equal((await getStoredJobById(jobId)).running, true);

  stopSchedulerForHost();
  stopSchedulerForHost();

  await startSchedulerForHost('http://127.0.0.1:4321');
  assert.equal((await getStoredJobById(jobId)).running, false);
});

test('both hosts start and stop the scheduler', async () => {
  for (const host of ['server.js', 'electron/server-host.ts']) {
    const source = await fs.readFile(path.join(repoRoot, host), 'utf8');
    assert.match(source, /startSchedulerForHost\(/, `${host} starts the scheduler`);
    assert.match(source, /stopSchedulerForHost\(/, `${host} stops the scheduler`);
  }
});
