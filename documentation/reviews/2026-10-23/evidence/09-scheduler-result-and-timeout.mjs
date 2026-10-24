// Run: node documentation/reviews/2026-10-23/evidence/09-scheduler-result-and-timeout.mjs
// Fake child processes only. Synthetic data and a temporary home, no providers.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-review-scheduler-'));
const priorHome = process.env.MINNOW_HOME; process.env.MINNOW_HOME = home;
let releaseChild, runningCompletion;
try {
  const store = await import('../../../../server/scheduler/store.js');
  const runner = await import('../../../../server/scheduler/runner.js');
  const makeJob = async label => {
    const job = await store.createJob({ label, schedule: { kind: 'interval', value: '60s' }, prompt: 'Synthetic review task', modelId: 'synthetic', providerId: 'synthetic', channels: ['in_app'] });
    return store.getStoredJobById(job.id);
  };
  const longJob = await makeJob('Synthetic long result');
  const payload = JSON.stringify({ ok: true, assistantFinal: 'x'.repeat(70000), turns: [], chatId: 'synthetic-persisted-chat' });
  const fakeLongSpawn = () => {
    let stdoutHandler;
    return {
      stdout: { on(event, fn) { if (event === 'data') stdoutHandler = fn; } },
      stderr: { on() {} },
      on(event, fn) { if (event === 'close') queueMicrotask(() => { stdoutHandler(Buffer.from(payload)); fn(0); }); },
      kill() {},
    };
  };
  const longResult = await runner.runStoredJob(longJob, { spawn: fakeLongSpawn });
  const [saved] = await runner.listRunsForJob(longJob.id);
  const timeoutJob = await makeJob('Synthetic non-exiting child');
  let kills = 0;
  const fakeHungSpawn = () => ({
    stdout: { on() {} }, stderr: { on() {} },
    on(event, fn) { if (event === 'close') releaseChild = () => fn(0); },
    kill() { kills++; return true; },
  });
  const admission = runner.startStoredJob(timeoutJob, { spawn: fakeHungSpawn, timeoutMs: 25 });
  runningCompletion = admission.completion;
  // Allow preparation and timer to run; no real subprocess needs termination.
  for (let i = 0; i < 100 && kills === 0; i++) await new Promise(resolve => setTimeout(resolve, 10));
  const occupiedAfterTimeout = runner.getActiveRunCount();
  releaseChild?.(); await runningCompletion; runningCompletion = undefined;
  console.log(JSON.stringify({
    emittedJsonChars: payload.length, runStatus: longResult.status, chatLinkKept: saved.chatId === 'synthetic-persisted-chat',
    timeoutSignalsSent: kills, occupiedSlotsAfterTimeout: occupiedAfterTimeout,
  }));
  assert.equal(saved.chatId, 'synthetic-persisted-chat', 'A successful long run must retain its persisted chat link');
  assert.equal(occupiedAfterTimeout, 0, 'A timed-out run must have bounded settlement even if the child does not close');
} finally {
  releaseChild?.(); await runningCompletion;
  const { closeSessionsDb } = await import('../../../../server/config/sessions-db.js'); closeSessionsDb();
  if (priorHome === undefined) delete process.env.MINNOW_HOME; else process.env.MINNOW_HOME = priorHome;
  assert.ok(path.resolve(home).startsWith(path.resolve(os.tmpdir()) + path.sep));
  await fs.rm(home, { recursive: true, force: true });
}

