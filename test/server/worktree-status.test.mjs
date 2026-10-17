import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { worktreeStatus } from '../../server/git/git-ops.js';

test('worktree status follows real HEAD ancestry, dirtiness, and later commits', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-worktree-status-'));
  const repo = path.join(root, 'repo');
  const worktree = path.join(root, 'worktree');
  await fs.mkdir(repo);
  const git = (args, cwd = repo) => execFileSync('git', args, { cwd, windowsHide: true, stdio: 'pipe' });
  try {
    git(['init', '-b', 'main']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test']);
    git(['commit', '--allow-empty', '-m', 'initial']);
    git(['worktree', 'add', '-b', 'feature', worktree]);
    await fs.writeFile(path.join(worktree, 'feature.txt'), 'feature\n');
    git(['add', '.'], worktree);
    git(['commit', '-m', 'feature'], worktree);
    assert.deepEqual(await worktreeStatus({ cwd: worktree }), {
      ok: true, branch: 'feature', trunk: 'main', merged: false, dirty: false,
    });
    git(['merge', '--no-ff', 'feature', '-m', 'merge feature']);
    assert.equal((await worktreeStatus({ cwd: worktree })).merged, true);
    await fs.writeFile(path.join(worktree, 'feature.txt'), 'more work\n');
    const dirty = await worktreeStatus({ cwd: worktree });
    assert.equal(dirty.merged, true);
    assert.equal(dirty.dirty, true);
    git(['add', '.'], worktree);
    git(['commit', '-m', 'more work'], worktree);
    assert.equal((await worktreeStatus({ cwd: worktree })).merged, false);
    git(['checkout', '--detach'], worktree);
    git(['branch', '-D', 'feature']);
    assert.equal((await worktreeStatus({ cwd: worktree })).merged, false, 'uses HEAD even after branch deletion');
    git(['branch', '-m', 'main', 'master']);
    assert.equal((await worktreeStatus({ cwd: worktree })).trunk, 'master');
    git(['branch', '-m', 'master', 'trunk']);
    assert.equal((await worktreeStatus({ cwd: worktree })).merged, null, 'unknown base is not unmerged');
    git(['update-ref', 'refs/remotes/origin/main', 'trunk']);
    assert.equal((await worktreeStatus({ cwd: worktree })).trunk, 'origin/main');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
