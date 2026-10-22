import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { checkoutSwitch, checkoutSavedChanges, checkoutRestoreChanges } from '../../server/git/checkout-switch.js';
import { stashList } from '../../server/git/git-ops.js';
import { acquireActionWorktree, releaseActionWorktree } from '../../server/git/action-run-lock.js';

const exec = promisify(execFile);
async function fixture(t) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-checkout-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const git = async (...args) => (await exec('git', args, { cwd, windowsHide: true })).stdout.trim();
  await git('init', '-b', 'main');
  await git('config', 'user.email', 'test@example.com');
  await git('config', 'user.name', 'Checkout test');
  await git('config', 'core.autocrlf', 'false');
  await fs.writeFile(path.join(cwd, 'tracked.txt'), 'base\n');
  await git('add', '.'); await git('commit', '-m', 'base');
  await git('branch', 'feature');
  const dirty = async () => {
    await fs.writeFile(path.join(cwd, 'tracked.txt'), 'staged\n');
    await git('add', 'tracked.txt');
    await fs.writeFile(path.join(cwd, 'tracked.txt'), 'unstaged\n');
    await fs.writeFile(path.join(cwd, 'new.txt'), 'new file\n');
  };
  return { cwd, git, dirty };
}

test('dirty switches require a choice and bring preserves staged, unstaged and new files', async (t) => {
  const { cwd, git, dirty } = await fixture(t);
  await dirty();
  const before = await git('status', '--porcelain');
  const ask = await checkoutSwitch({ cwd, branch: 'feature' });
  assert.equal(ask.needsChoice, true); assert.equal(ask.fileCount, 2);
  assert.equal(await git('branch', '--show-current'), 'main');
  assert.equal((await checkoutSwitch({ cwd, branch: 'feature', expectedBranch: 'main', dirtyHandling: 'bring' })).ok, true);
  assert.equal(await git('status', '--porcelain'), before);
  assert.deepEqual((await checkoutSavedChanges({ cwd })).savedChanges, []);
});

test('leave persists a branch save and restores index plus new files by SHA after stash indices move', async (t) => {
  const { cwd, git, dirty } = await fixture(t);
  await dirty();
  const before = await git('status', '--porcelain');
  assert.equal((await checkoutSwitch({ cwd, branch: 'feature', dirtyHandling: 'leave' })).ok, true);
  assert.equal(await git('status', '--porcelain'), '');
  const [save] = (await checkoutSavedChanges({ cwd })).savedChanges;
  assert.equal(save.branch, 'main'); assert.equal(save.fileCount, 2);
  const readable = (await stashList({ cwd })).stashes.join('\n');
  assert.match(readable, /Minnow saved changes on main/);
  assert.doesNotMatch(readable, /minnow-checkout:/);
  await fs.writeFile(path.join(cwd, 'other.txt'), 'unrelated\n');
  await git('stash', 'push', '-u', '-m', 'Unrelated stash');
  assert.equal((await checkoutSwitch({ cwd, branch: 'main' })).ok, true);
  assert.equal((await checkoutRestoreChanges({ cwd, sha: save.sha, expectedBranch: 'main' })).ok, true);
  assert.equal(await git('status', '--porcelain'), before);
  assert.equal(await fs.readFile(path.join(cwd, 'new.txt'), 'utf8'), 'new file\n');
  assert.equal(await git('show', ':tracked.txt'), 'staged');
  assert.deepEqual((await checkoutSavedChanges({ cwd })).savedChanges, []);
  assert.match(await git('stash', 'list'), /Unrelated stash/);
});

test('failed leave checkout rolls back files and staging without leaving a redundant stash', async (t) => {
  const { cwd, git, dirty } = await fixture(t);
  await dirty(); const before = await git('status', '--porcelain');
  const result = await checkoutSwitch({ cwd, branch: 'missing', dirtyHandling: 'leave' });
  assert.equal(result.ok, false);
  assert.equal(await git('branch', '--show-current'), 'main');
  assert.equal(await git('status', '--porcelain'), before);
  assert.equal(await git('show', ':tracked.txt'), 'staged');
  assert.deepEqual((await checkoutSavedChanges({ cwd })).savedChanges, []);
});

test('restore rejects a different branch, worktree, missing save and dirty destination', async (t) => {
  const { cwd, git, dirty } = await fixture(t);
  await dirty(); await checkoutSwitch({ cwd, branch: 'feature', dirtyHandling: 'leave' });
  const [save] = (await checkoutSavedChanges({ cwd })).savedChanges;
  assert.equal((await checkoutRestoreChanges({ cwd, sha: save.sha, expectedBranch: 'main' })).ok, false);
  const wt = path.join(cwd, 'linked');
  await git('worktree', 'add', wt, 'main');
  assert.deepEqual((await checkoutSavedChanges({ cwd: wt })).savedChanges, []);
  assert.equal((await checkoutRestoreChanges({ cwd: wt, sha: save.sha, expectedBranch: 'main' })).ok, false);
  await git('worktree', 'remove', wt);
  await checkoutSwitch({ cwd, branch: 'main' });
  await fs.writeFile(path.join(cwd, 'another.txt'), 'dirty\n');
  assert.equal((await checkoutRestoreChanges({ cwd, sha: save.sha, expectedBranch: 'main' })).ok, false);
  await fs.unlink(path.join(cwd, 'another.txt'));
  assert.equal((await checkoutRestoreChanges({ cwd, sha: 'missing', expectedBranch: 'main' })).ok, false);
  assert.equal((await checkoutSavedChanges({ cwd })).savedChanges[0].sha, save.sha);
});

test('restore conflict retains the saved stash', async (t) => {
  const { cwd, git, dirty } = await fixture(t);
  await dirty(); await checkoutSwitch({ cwd, branch: 'feature', dirtyHandling: 'leave' });
  const [save] = (await checkoutSavedChanges({ cwd })).savedChanges;
  await checkoutSwitch({ cwd, branch: 'main' });
  await fs.writeFile(path.join(cwd, 'tracked.txt'), 'incompatible\n');
  await git('add', '.'); await git('commit', '-m', 'changed base');
  const result = await checkoutRestoreChanges({ cwd, sha: save.sha, expectedBranch: 'main' });
  assert.equal(result.ok, false); assert.equal(result.conflict, true);
  assert.equal((await checkoutSavedChanges({ cwd })).savedChanges[0].sha, save.sha);
});

test('clean creation works; stale requests and running actions prevent mutation', async (t) => {
  const { cwd, git } = await fixture(t);
  assert.equal((await checkoutSwitch({ cwd, branch: 'feature', expectedBranch: 'other' })).ok, false);
  assert.equal((await checkoutSwitch({ cwd, branch: ' -B' })).ok, false);
  acquireActionWorktree(cwd, 'test-action');
  await assert.rejects(checkoutSwitch({ cwd, branch: 'feature' }), /local action/);
  releaseActionWorktree(cwd, 'test-action');
  assert.equal((await checkoutSwitch({ cwd, branch: 'new-feature', create: true, startPoint: 'main' })).ok, true);
  assert.equal(await git('branch', '--show-current'), 'new-feature');
});
