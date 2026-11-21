import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { createLegacyEvalResultsMiddleware } from '../../server/evals/middleware.js';

test('retired Evals can read historical artifacts but no longer write or configure them', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-legacy-eval-'));
  const original = process.env.MINNOW_HOME;
  process.env.MINNOW_HOME = home;
  resetMinnowHomeCache();
  t.after(async () => {
    if (original === undefined) delete process.env.MINNOW_HOME;
    else process.env.MINNOW_HOME = original;
    resetMinnowHomeCache();
    await fs.rm(home, { recursive: true, force: true });
  });
  const run = path.join(home, 'evals', 'runs', 'suite-fixture');
  await fs.mkdir(path.join(run, 'cells'), { recursive: true });
  const manifest = { suiteRunId: 'suite-fixture', packLabel: 'Old pack' };
  const cell = { cellId: 'case__test', summary: 'Saved result' };
  await fs.writeFile(path.join(run, 'manifest.json'), JSON.stringify(manifest));
  await fs.writeFile(path.join(run, 'cells', 'case__test.json'), JSON.stringify(cell));

  const middleware = createLegacyEvalResultsMiddleware();
  async function call(url, method = 'GET', kind = 'host') {
    let body;
    const res = { setHeader() {}, end(text) { body = JSON.parse(text); } };
    await middleware({ url, method, minnowAuth: { kind } }, res, assert.fail);
    return { status: res.statusCode, body };
  }

  assert.equal((await call('/api/evals/runs')).body.runs[0].packLabel, 'Old pack');
  assert.deepEqual((await call('/api/evals/runs/suite-fixture')).body.manifest, manifest);
  assert.deepEqual((await call('/api/evals/runs/suite-fixture/cells/case__test')).body, { cell });
  assert.equal((await call('/api/evals/runs/suite-fixture', 'GET', 'device')).status, 403);
  assert.equal((await call('/api/evals/runs/suite-fixture', 'PUT')).status, 410);
  assert.equal((await call('/api/evals/config')).status, 410);
});
