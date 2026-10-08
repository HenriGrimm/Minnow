import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runImageJob, readImageJob, workspaceJournal, cleanupImageJobs } from '../../server/image-generation/jobs.js';
import { sha256 } from '../../server/image-generation/assets.js';

test('concurrent/replayed identity submits once; crash becomes unknown; workspaces isolated', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-jobs-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const workspace = path.join(home, 'one'); const other = path.join(home, 'two');
  await fs.mkdir(workspace); await fs.mkdir(other);
  let submissions = 0;
  const options = { home, workspace, identity: 'run/tool', metadata: {}, execute: async () => { submissions++; return { artifacts: [{ path: 'asset.png' }] }; } };
  const results = await Promise.all([runImageJob(options), runImageJob(options)]);
  assert.equal(submissions, 1); assert.equal(results[0].jobId, results[1].jobId);
  await runImageJob(options); assert.equal(submissions, 1);
  await assert.rejects(readImageJob(home, other, results[0].jobId), /ENOENT/);
  const directory = await workspaceJournal(home, workspace);
  await fs.writeFile(path.join(directory, `${sha256('crash')}.json`), JSON.stringify({ jobId: sha256('crash'), status: 'submitting' }));
  assert.equal((await readImageJob(home, workspace, sha256('crash'))).status, 'outcome_unknown');
  await runImageJob({ ...options, identity: 'crash' }); assert.equal(submissions, 1);
  await fs.writeFile(path.join(workspace, 'asset.png'), 'asset');
  await cleanupImageJobs(home, workspace, Date.now() + 32 * 86400000);
  assert.equal(await fs.readFile(path.join(workspace, 'asset.png'), 'utf8'), 'asset');
});

test('ambiguous errors and cancellation never resubmit', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-cancel-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  let count = 0;
  const options = { home, workspace: home, identity: 'unknown', metadata: {}, execute: async () => { count++; throw new Error('network secret'); } };
  const result = await runImageJob(options);
  assert.equal(result.status, 'outcome_unknown'); assert.ok(!result.error.includes('secret'));
  await runImageJob(options); assert.equal(count, 1);
  const controller = new AbortController(); controller.abort();
  assert.equal((await runImageJob({ ...options, identity: 'cancel', signal: controller.signal })).status, 'canceled');
  assert.equal(count, 1);
});
