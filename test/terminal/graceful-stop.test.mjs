import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { createBackgroundRun, getRun, stopActiveRun } from '../../server/terminal-runner.js';

let home;
const previousHome = process.env.MINNOW_HOME;
before(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-graceful-stop-'));
  process.env.MINNOW_HOME = home;
  resetMinnowHomeCache();
});
after(async () => {
  if (previousHome === undefined) delete process.env.MINNOW_HOME;
  else process.env.MINNOW_HOME = previousHome;
  resetMinnowHomeCache();
  await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function startFixture(code, timeoutMs = 2000) {
  const run = await createBackgroundRun({
    command: process.execPath, args: ['-e', code], cwd: home, sandbox: false,
    gracefulStop: { stdinText: 'cmd_router_to_child:exit\n', timeoutMs },
  });
  const deadline = Date.now() + 5000;
  while (!getRun(run.runId).stdout.includes('ready') && Date.now() < deadline) {
    assert.equal(getRun(run.runId).finished, false, getRun(run.runId).stderr);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.match(getRun(run.runId).stdout, /ready/);
  return run;
}

test('stop waits for native cleanup and concurrent requests send one exit command', async () => {
  const run = await startFixture(`
    console.log('ready');
    let commands = 0;
    process.stdin.on('data', chunk => {
      commands += chunk.toString().split('cmd_router_to_child:exit').length - 1;
      setTimeout(() => { console.log('cleaned:' + commands); process.exit(0); }, 100);
    });
  `);
  try {
    const results = await Promise.all([stopActiveRun(run.runId), stopActiveRun(run.runId)]);
    assert.ok(results.every(result => result.ok));
    assert.equal(getRun(run.runId).exitCode, 0);
    assert.match(getRun(run.runId).stdout, /cleaned:1/);
    assert.equal(getRun(run.runId).finished, true);
    assert.throws(() => process.kill(run.pid, 0), { code: 'ESRCH' });
  } finally {
    await stopActiveRun(run.runId, { graceMs: 1 });
  }
});

test('exit queued while loading is consumed after the runtime installs its reader', async () => {
  const run = await startFixture(`
    console.log('ready');
    setTimeout(() => process.stdin.on('data', chunk => {
      if (chunk.toString() === 'cmd_router_to_child:exit\\n') {
        console.log('cleaned after loading'); process.exit(0);
      }
    }), 200);
  `);
  try {
    assert.equal((await stopActiveRun(run.runId)).ok, true);
    assert.equal(getRun(run.runId).exitCode, 0);
    assert.match(getRun(run.runId).stdout, /cleaned after loading/);
  } finally {
    await stopActiveRun(run.runId, { graceMs: 1 });
  }
});

test('unresponsive runtime is terminated after the bounded grace period', async () => {
  const run = await startFixture(`console.log('ready'); setInterval(() => {}, 1000);`, 50);
  try {
    const started = Date.now();
    assert.equal((await stopActiveRun(run.runId)).ok, true);
    assert.ok(Date.now() - started < 8000);
    assert.equal(getRun(run.runId).finished, true);
    assert.throws(() => process.kill(run.pid, 0), { code: 'ESRCH' });
  } finally {
    await stopActiveRun(run.runId, { graceMs: 1 });
  }
});
