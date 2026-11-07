import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { snapshotCreate } from '../../server/git/git-ops.js';

const exec = promisify(execFile);
async function scratch(t) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-index-isolation-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const git = async (...args) => (await exec('git', args, { cwd, windowsHide: true })).stdout.trim();
  await git('init');
  await git('config', 'user.name', 'Snapshot fixture');
  await git('config', 'user.email', 'fixture@example.invalid');
  return { cwd, git };
}

test('snapshot of an unborn repo leaves the missing real index missing and includes untracked files', async t => {
  const { cwd, git } = await scratch(t);
  await fs.writeFile(path.join(cwd, 'new.txt'), 'untracked');
  const result = await snapshotCreate({ cwd });
  assert.equal(result.ok, true, result.error);
  assert.equal(await git('show', `${result.sha}:new.txt`), 'untracked');
  await assert.rejects(fs.access(path.join(cwd, '.git', 'index')), { code: 'ENOENT' });
});

test('an external HEAD change during capture is rejected without rewriting the real index', async t => {
  const { cwd, git } = await scratch(t);
  await fs.writeFile(path.join(cwd, 'tracked.txt'), 'first'); await git('add', '.'); await git('commit', '-m', 'first');
  const first = await git('rev-parse', 'HEAD');
  await fs.writeFile(path.join(cwd, 'tracked.txt'), 'second'); await git('add', '.'); await git('commit', '-m', 'second');
  const second = await git('rev-parse', 'HEAD');
  // The clean filter is confined to this synthetic repository. It deterministically
  // simulates an external Git client moving HEAD during private-index collection.
  await fs.writeFile(path.join(cwd, 'move-head.cjs'), `require('node:child_process').execFileSync('git',['update-ref','HEAD','${first}']); process.stdout.write(require('node:fs').readFileSync(0));`);
  await fs.writeFile(path.join(cwd, '.gitattributes'), '*.trigger filter=move-head\n');
  await git('config', 'filter.move-head.clean', 'node move-head.cjs');
  await fs.writeFile(path.join(cwd, 'capture.trigger'), 'during snapshot');
  const indexPath = path.join(cwd, '.git', 'index'), before = await fs.readFile(indexPath);
  assert.equal(await git('rev-parse', 'HEAD'), second);
  const result = await snapshotCreate({ cwd });
  assert.equal(result.ok, false);
  assert.match(result.error, /HEAD changed during snapshot/);
  assert.deepEqual(await fs.readFile(indexPath), before);
});

test('copied split index retains staged/unstaged separation without changing real index bytes', async t => {
  const { cwd, git } = await scratch(t);
  const file = path.join(cwd, 'tracked.txt');
  await fs.writeFile(file, 'base');
  await git('add', '.');
  await git('commit', '-m', 'fixture');
  await fs.writeFile(file, 'staged');
  await git('add', '.');
  await git('update-index', '--split-index');
  await fs.writeFile(file, 'unstaged');
  const indexPath = path.join(cwd, '.git', 'index');
  const before = await fs.readFile(indexPath);
  const result = await snapshotCreate({ cwd });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(await fs.readFile(indexPath), before);
  assert.equal(await git('show', `${result.sha}:tracked.txt`), 'unstaged');
  const commit = await git('show', '-s', '--format=%B', result.sha);
  const indexSha = commit.match(/Minnow-Index-V1: ([a-f0-9]{40})/)[1];
  assert.equal(await git('show', `${indexSha}:tracked.txt`), 'staged');
});
