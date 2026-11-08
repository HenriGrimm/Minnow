import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, test } from 'node:test';
import { commit, diff, stage, status } from '../../server/git/git-ops.js';
import { acquireActionWorktree, releaseActionWorktree } from '../../server/git/action-run-lock.js';

const exec = promisify(execFile);
let cwd;
const git = async (...args) => (await exec('git', args, { cwd, windowsHide: true })).stdout.trim();
const preview = () => diff({ cwd, cached: true, forCommit: true });
const write = (file, text) => fs.writeFile(path.join(cwd, file), text);

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-staged-commit-'));
  await git('init');
  await git('config', 'user.name', 'Test');
  await git('config', 'user.email', 'test@example.com');
});

afterEach(async () => {
  assert.equal(path.dirname(cwd), path.resolve(os.tmpdir()));
  assert.ok(path.basename(cwd).startsWith('minnow-staged-commit-'));
  await fs.rm(cwd, { recursive: true, force: true });
});

test('a guarded initial commit includes the staged version and preserves other working changes', async () => {
  const file = 'staged ü file.txt';
  await write(file, 'staged version\n');
  await stage({ cwd, paths: [file] });
  const reviewed = await preview();
  assert.equal(reviewed.ok, true, reviewed.error);
  assert.deepEqual(reviewed.files, [{ path: file, status: 'A' }]);
  assert.equal(reviewed.commitSnapshot.headSha, null);
  assert.match(reviewed.patch, /staged version/);
  await write(file, 'later working version\n');
  await write('unrelated.txt', 'leave untracked\n');

  const result = await commit({ cwd, message: ':sparkles: feat: add staged file', stagedOnly: true, expectedSnapshot: reviewed.commitSnapshot });
  assert.equal(result.ok, true, result.error);
  assert.match(result.sha, /^[a-f0-9]{40,64}$/);
  assert.equal(await git('show', `HEAD:${file}`), 'staged version');
  assert.equal(await git('log', '-1', '--format=%s'), '✨ feat: add staged file');
  const remaining = await status({ cwd });
  assert.deepEqual(remaining.staged, []);
  assert.ok(remaining.unstaged.some(entry => entry.path === file));
  assert.ok(remaining.untracked.some(entry => entry.path === 'unrelated.txt'));
});

test('staged-only commit refuses an empty index without staging working files', async () => {
  await write('unrelated.txt', 'keep this out');
  const result = await commit({ cwd, message: 'chore: no staged changes', stagedOnly: true });
  assert.equal(result.ok, false);
  assert.match(result.error, /No staged changes/);
  assert.equal((await status({ cwd })).untracked.length, 1);
  assert.equal(await git('ls-files'), '');
});

for (const change of ['index', 'empty index', 'head', 'branch']) {
  test(`guarded commit refuses a changed ${change}`, async () => {
    await git('commit', '--allow-empty', '-m', 'base');
    await write('file.txt', 'described version');
    await stage({ cwd, paths: ['file.txt'] });
    const reviewed = await preview();
    assert.equal(reviewed.ok, true, reviewed.error);
    if (change === 'index') {
      await write('file.txt', 'different staged version');
      await stage({ cwd, paths: ['file.txt'] });
    } else if (change === 'empty index') {
      await git('reset', 'HEAD', '--', 'file.txt');
    } else if (change === 'head') {
      await git('commit', '--only', '--allow-empty', '-m', 'other commit');
    } else {
      await git('checkout', '-b', 'other-branch');
    }
    const head = await git('rev-parse', 'HEAD');
    const index = await git('write-tree');
    const result = await commit({ cwd, message: 'feat: stale description', stagedOnly: true, expectedSnapshot: reviewed.commitSnapshot });
    assert.equal(result.ok, false);
    assert.match(result.error, /checkout or staged content changed/);
    assert.equal(await git('rev-parse', 'HEAD'), head);
    assert.equal(await git('write-tree'), index);
  });
}

test('guarded commits work on a detached HEAD', async () => {
  await git('commit', '--allow-empty', '-m', 'base');
  await git('checkout', '--detach');
  await write('file.txt', 'detached content');
  await stage({ cwd, paths: ['file.txt'] });
  const reviewed = await preview();
  assert.equal(reviewed.commitSnapshot.branch, null);
  const result = await commit({ cwd, message: 'feat: detached change', expectedSnapshot: reviewed.commitSnapshot });
  assert.equal(result.ok, true, result.error);
});

test('staging waits for validation and commit to finish on the same checkout', async () => {
  await git('commit', '--allow-empty', '-m', 'base');
  await write('described.txt', 'described change');
  await write('later.txt', 'staged during commit');
  await stage({ cwd, paths: ['described.txt'] });
  const reviewed = await preview();
  const hook = path.join(cwd, '.git', 'hooks', 'pre-commit');
  await fs.writeFile(hook, '#!/bin/sh\nprintf ready > .git/minnow-ready\nwhile [ ! -f .git/minnow-release ]; do sleep 0.01; done\n', { mode: 0o755 });

  const committing = commit({ cwd, message: 'feat: described change', stagedOnly: true, expectedSnapshot: reviewed.commitSnapshot });
  let staging;
  try {
    for (let i = 0; i < 500; i++) {
      if (await fs.access(path.join(cwd, '.git', 'minnow-ready')).then(() => true, () => false)) break;
      if (i === 499) assert.fail('Commit hook did not start');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    let staged = false;
    staging = stage({ cwd, paths: ['later.txt'] }).then(result => { staged = true; return result; });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(staged, false);
  } finally {
    await fs.writeFile(path.join(cwd, '.git', 'minnow-release'), 'release');
    assert.equal((await committing).ok, true);
    if (staging) assert.equal((await staging).ok, true);
  }
  assert.equal(await git('show', '--format=', '--name-only', 'HEAD'), 'described.txt');
  assert.equal(await git('diff', '--cached', '--name-only'), 'later.txt');
});

test('guarded commits preserve normal Git hook updates to the index', async () => {
  await write('file.txt', 'unformatted');
  await stage({ cwd, paths: ['file.txt'] });
  const reviewed = await preview();
  const hook = path.join(cwd, '.git', 'hooks', 'pre-commit');
  await fs.writeFile(hook, '#!/bin/sh\nprintf formatted > file.txt\ngit add -- file.txt\n', { mode: 0o755 });
  const result = await commit({ cwd, message: 'feat: staged change', stagedOnly: true, expectedSnapshot: reviewed.commitSnapshot });
  assert.equal(result.ok, true, result.error);
  assert.equal(await git('show', 'HEAD:file.txt'), 'formatted');
  assert.equal(await git('status', '--porcelain'), '');
});

test('guarded commits honor the existing worktree mutation lock', async () => {
  await write('file.txt', 'content');
  await stage({ cwd, paths: ['file.txt'] });
  const reviewed = await preview();
  acquireActionWorktree(cwd, 'test-action');
  try {
    const result = await commit({ cwd, message: 'feat: locked change', stagedOnly: true, expectedSnapshot: reviewed.commitSnapshot });
    assert.equal(result.ok, false);
    assert.match(result.error, /local action is running/);
  } finally {
    releaseActionWorktree(cwd, 'test-action');
  }
});

test('commit previews require the full staged index', async () => {
  for (const options of [{}, { cached: true, path: 'file.txt' }, { cached: true, workingTree: true }]) {
    const result = await diff({ cwd, ...options, forCommit: true });
    assert.equal(result.ok, false);
    assert.match(result.error, /complete staged index/);
  }
});
