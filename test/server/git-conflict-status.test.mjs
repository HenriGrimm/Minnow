import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { parsePorcelainStatus, status } from '../../server/git/git-ops.js';

const exec = promisify(execFile);
const filename = 'conflicted café file.txt';

async function fixture(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-conflict-'));
  const repo = path.join(dir, 'repo');
  await fs.mkdir(repo);
  const git = async (...args) => exec('git', args, { cwd: repo, windowsHide: true });
  try {
    await git('init', '-b', 'main');
    await git('config', 'user.email', 'test@example.com');
    await git('config', 'user.name', 'Test');
    await fs.writeFile(path.join(repo, filename), 'base\n');
    await git('add', '.');
    await git('commit', '-m', 'base');
    await git('checkout', '-b', 'topic');
    await fs.writeFile(path.join(repo, filename), 'topic\n');
    await git('commit', '-am', 'topic');
    await git('checkout', 'main');
    await fs.writeFile(path.join(repo, filename), 'main\n');
    await git('commit', '-am', 'main');
    await run({ dir, repo, git });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('every unmerged index state is reported as a conflict without breaking legacy buckets', () => {
  for (const code of ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']) {
    const parsed = parsePorcelainStatus(`## topic\n${code} path.ts\n`);
    assert.deepEqual(parsed.conflicted, [{ path: 'path.ts', status: 'U' }]);
    assert.ok(parsed.staged.length + parsed.unstaged.length > 0);
  }
  const renamed = parsePorcelainStatus('## topic\0R  new name.ts\0old name.ts\0 M normal.ts\0', true);
  assert.deepEqual(renamed.staged, [{ path: 'new name.ts', status: 'R' }]);
  assert.deepEqual(renamed.unstaged, [{ path: 'normal.ts', status: 'M' }]);
});

test('a real merge reports exact conflict paths and stays paused after files are staged', async () => fixture(async ({ repo, git }) => {
  await assert.rejects(git('merge', 'topic'));
  let result = await status({ cwd: repo });
  assert.equal(result.ok, true);
  assert.equal(result.operation, 'merge');
  assert.deepEqual(result.conflicted, [{ path: filename, status: 'U' }]);
  await fs.writeFile(path.join(repo, filename), 'both\n');
  await git('add', '--', filename);
  result = await status({ cwd: repo });
  assert.deepEqual(result.conflicted, []);
  assert.equal(result.operation, 'merge');
  await git('commit', '-m', 'resolve');
  result = await status({ cwd: repo });
  assert.equal(result.operation, undefined);
  assert.deepEqual(result.conflicted, []);
}));

test('a rebase conflict is identified separately from a merge', async () => fixture(async ({ repo, git }) => {
  await git('checkout', 'topic');
  await assert.rejects(git('rebase', 'main'));
  const result = await status({ cwd: repo });
  assert.equal(result.operation, 'rebase');
  assert.equal(result.conflicted[0].path, filename);
}));

test('merge state is read from a linked worktree git directory', async () => fixture(async ({ dir, git }) => {
  const checkout = path.join(dir, 'linked');
  await git('worktree', 'add', checkout, 'topic');
  await assert.rejects(exec('git', ['merge', 'main'], { cwd: checkout, windowsHide: true }));
  const result = await status({ cwd: checkout });
  assert.equal(result.branch, 'topic');
  assert.equal(result.operation, 'merge');
  assert.equal(result.conflicted[0].path, filename);
}));
