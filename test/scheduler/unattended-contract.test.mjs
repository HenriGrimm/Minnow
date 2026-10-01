import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { closeSessionsDb } from '../../server/config/sessions-db.js';
import { createJob, getStoredJobById } from '../../server/scheduler/store.js';
import { runStoredJob } from '../../server/scheduler/runner.js';

test('scheduled CLI supplies unattended approval opt-in and auto-rejects questions', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-scheduler-permissions-'));
  const previousHome = process.env.MINNOW_HOME;
  process.env.MINNOW_HOME = home;
  resetMinnowHomeCache();
  let captured;
  try {
    const job = await createJob({ label: 'Unattended contract', prompt: 'Summarize the project',
      modeId: 'build', schedule: { kind: 'interval', value: '60s' }, channels: ['in_app'] });
    await runStoredJob(await getStoredJobById(job.id), { spawn: (_executable, args, options) => {
      captured = { args, options };
      let output;
      return {
        stdout: { on: (event, handler) => { if (event === 'data') output = handler; } },
        stderr: { on() {} }, kill() {},
        on: (event, handler) => {
          if (event === 'close') queueMicrotask(() => {
            output(Buffer.from(JSON.stringify({ ok: true, assistantFinal: 'Done' }) + '\n'));
            handler(0);
          });
        },
      };
    } });
    assert.ok(captured.args.includes('--no-approval'));
    assert.ok(captured.args.includes('--auto-reject-questions'));
    assert.equal(captured.options.env.MINNOW_I_UNDERSTAND_UNSAFE_AUTOMATION, '1');
    assert.equal(captured.options.env.BROWSER, 'none');
  } finally {
    closeSessionsDb();
    if (previousHome === undefined) delete process.env.MINNOW_HOME;
    else process.env.MINNOW_HOME = previousHome;
    resetMinnowHomeCache();
    await fs.rm(home, { recursive: true, force: true });
  }
});
