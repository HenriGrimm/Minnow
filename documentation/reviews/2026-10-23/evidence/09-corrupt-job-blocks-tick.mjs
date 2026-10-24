// Run: node documentation/reviews/2026-10-23/evidence/09-corrupt-job-blocks-tick.mjs
// Uses synthetic scheduler records in a fresh temporary home; no child is spawned.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-review-corrupt-job-'));
const priorHome = process.env.MINNOW_HOME; process.env.MINNOW_HOME = home;
try {
  const { createJob, mutateStoredJob } = await import('../../../../server/scheduler/store.js');
  const { runSchedulerTick } = await import('../../../../server/scheduler/tick.js');
  const jobs = [];
  for (const label of ['Synthetic bad', 'Synthetic healthy']) jobs.push(await createJob({
    label, prompt: 'Synthetic prompt', modelId: 'synthetic', schedule: { kind: 'interval', value: '60s' },
  }));
  for (const job of jobs) await mutateStoredJob(job.id, row => ({ ...row, nextRunAt: '2000-01-01T00:00:00.000Z' }));
  await mutateStoredJob(jobs[0].id, row => ({ ...row, promptEnc: 'corrupt' }));
  let error, spawnCalls = 0;
  try { await runSchedulerTick({ spawn: () => { spawnCalls++; throw new Error('Synthetic child should be admitted'); } }); }
  catch (caught) { error = caught.message; }
  console.log(JSON.stringify({ healthyDueJobs: 1, spawnCalls, tickError: error }));
  assert.equal(error, undefined, 'One unreadable prompt must not abort dispatch of healthy jobs');
} finally {
  const { closeSessionsDb } = await import('../../../../server/config/sessions-db.js'); closeSessionsDb();
  if (priorHome === undefined) delete process.env.MINNOW_HOME; else process.env.MINNOW_HOME = priorHome;
  assert.ok(path.resolve(home).startsWith(path.resolve(os.tmpdir()) + path.sep));
  await fs.rm(home, { recursive: true, force: true });
}

