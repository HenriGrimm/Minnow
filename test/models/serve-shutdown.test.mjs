import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { createRun, getRun, stopActiveRun } from '../../server/terminal-runner.js';
import { getServesIndexPath } from '../../server/models/paths.js';
import { listServes, resetServesForTests, patchServeRowForTests } from '../../server/models/serve.js';
import { handleModelsRequest } from '../../server/models/routes.js';

test('shutdown route waits for owned model processes and reports failed stops', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-shutdown-'));
  const previousHome = process.env.MINNOW_HOME;
  process.env.MINNOW_HOME = home;
  resetMinnowHomeCache();
  let run;
  try {
    run = await createRun({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], cwd: home });
    const deadline = Date.now() + 5000;
    while (!getRun(run.runId).child && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const pid = getRun(run.runId).child?.pid;
    assert.ok(pid, 'fixture process must be running before shutdown');
    const id = '22222222-2222-4222-8222-222222222222';
    await fs.mkdir(path.dirname(getServesIndexPath()), { recursive: true });
    await fs.writeFile(getServesIndexPath(), JSON.stringify({ version: 1, serves: [{
      id, runtime: 'llama-cpp', status: 'running', runId: run.runId, pid,
      startedAt: Date.now(), modelPath: 'fixture.gguf',
    }] }));
    await resetServesForTests();
    const response = { statusCode: 0, setHeader() {}, end(body) { this.body = JSON.parse(body); } };
    await handleModelsRequest({ method: 'POST' }, response, '/api/models/shutdown');
    assert.equal(response.statusCode, 200);
    assert.equal(getRun(run.runId).finished, true, 'HTTP success must wait for process exit');
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    assert.equal((await listServes())[0].status, 'stopped');

    patchServeRowForTests(id, { status: 'running', runId: 'missing-run' });
    await handleModelsRequest({ method: 'POST' }, response, '/api/models/shutdown');
    assert.equal(response.statusCode, 500);
    assert.equal((await listServes())[0].status, 'running', 'failed stops must not claim success');
  } finally {
    if (run) await stopActiveRun(run.runId);
    await resetServesForTests();
    if (previousHome === undefined) delete process.env.MINNOW_HOME;
    else process.env.MINNOW_HOME = previousHome;
    resetMinnowHomeCache();
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
