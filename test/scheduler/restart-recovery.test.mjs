import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { schedulerRunHistoryPath } from '../../server/scheduler/paths.js';
import { listRunsForJob, recoverInterruptedSchedulerRuns } from '../../server/scheduler/runner.js';
import { createJob, getStoredJobById, mutateStoredJob } from '../../server/scheduler/store.js';

let home;
const priorHome = process.env.MINNOW_HOME;

before(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-scheduler-restart-'));
  process.env.MINNOW_HOME = home;
  resetMinnowHomeCache();
});

after(async () => {
  if (priorHome === undefined) delete process.env.MINNOW_HOME;
  else process.env.MINNOW_HOME = priorHome;
  resetMinnowHomeCache();
  if (home) await fs.rm(home, { recursive: true, force: true });
});

test('startup clears an orphaned running job and closes its history row', async () => {
  const job = await createJob({
    label: 'Interrupted run',
    schedule: { kind: 'interval', value: '60s' },
    prompt: 'Say OK',
    modeId: 'build',
    channels: ['in_app'],
  });
  const runId = 'interrupted-run';
  await mutateStoredJob(job.id, (stored) => ({ ...stored, running: true, nextRunAt: null }));
  const historyPath = schedulerRunHistoryPath(job.id);
  await fs.mkdir(path.dirname(historyPath), { recursive: true });
  await fs.writeFile(historyPath, JSON.stringify({ version: 1, runs: [{ id: runId, jobId: job.id, status: 'running', startedAt: new Date().toISOString() }] }));

  assert.deepEqual(await recoverInterruptedSchedulerRuns(), [job.id]);
  const recovered = await getStoredJobById(job.id);
  assert.equal(recovered.running, false);
  assert.ok(Date.parse(recovered.nextRunAt) > Date.now());
  const [run] = await listRunsForJob(job.id);
  assert.equal(run.id, runId);
  assert.equal(run.status, 'failed');
  assert.match(run.error, /stopped before this run finished/);
  assert.ok(run.completedAt);

  assert.deepEqual(await recoverInterruptedSchedulerRuns(), []);
  assert.equal((await listRunsForJob(job.id)).length, 1);
});
