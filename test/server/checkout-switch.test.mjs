import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { mock, test } from 'node:test';
import { stashList } from '../../server/git/git-ops.js';
import { acquireActionWorktree, releaseActionWorktree } from '../../server/git/action-run-lock.js';

const exec = promisify(execFile);
const pullCheckouts = [];
mock.module('../../server/git/gh-cli.js', {
  namedExports: {
    runGh: async (args, { cwd }) => {
      if (args[0] === '--version') return { code: 0, stdout: 'gh version 2.0.0' };
      if (args[0] === 'api') return { code: 0, stdout: 'minnow-test' };
      pullCheckouts.push(args);
      if (args[2] !== '43') await exec('git', ['checkout', 'feature'], { cwd, windowsHide: true });
      return args[2] === '42' ? { code: 0, stdout: '' } : { code: 1, stderr: 'Checkout failed' };
    },
  },
});
const { checkoutSwitch, checkoutSavedChanges, checkoutRestoreChanges } = await import('../../server/git/checkout-switch.js');

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

test('remote checkout creates a local branch with its upstream after a dirty-file choice', async (t) => {
  const { cwd, git, dirty } = await fixture(t);
  await git('remote', 'add', 'upstream', cwd);
  await git('update-ref', 'refs/remotes/upstream/fix/search', 'HEAD');
  await dirty();
  const input = { cwd, branch: 'fix/search', create: true, startPoint: 'upstream/fix/search', expectedBranch: 'main' };
  assert.equal((await checkoutSwitch(input)).needsChoice, true);
  assert.equal(await git('branch', '--show-current'), 'main');
  assert.equal((await checkoutSwitch({ ...input, dirtyHandling: 'leave' })).ok, true);
  assert.equal(await git('branch', '--show-current'), 'fix/search');
  assert.equal(await git('rev-parse', '--abbrev-ref', '@{upstream}'), 'upstream/fix/search');
  assert.equal(await git('status', '--porcelain'), '');
  assert.equal((await checkoutSavedChanges({ cwd })).savedChanges[0].branch, 'main');
});

test('pull request checkout waits for dirty-file consent and returns the actual local branch', async (t) => {
  const { cwd, git, dirty } = await fixture(t);
  await git('remote', 'add', 'origin', 'https://github.com/owner/repo.git');
  await dirty();
  const input = {
    cwd, branch: 'fork-head', expectedBranch: 'main',
    pullRequest: { number: 42, url: 'https://github.com/owner/repo/pull/42' },
  };
  assert.equal((await checkoutSwitch(input)).needsChoice, true);
  assert.equal(await git('branch', '--show-current'), 'main');
  const checkout = { ...input, dirtyHandling: 'leave' };
  const mismatched = await checkoutSwitch({ ...checkout, pullRequest: { ...input.pullRequest, url: 'https://github.com/other/repo/pull/42' } });
  assert.match(mismatched.error, /different repository/);
  assert.equal(pullCheckouts.length, 0);
  assert.deepEqual((await checkoutSavedChanges({ cwd })).savedChanges, []);
  assert.deepEqual(await checkoutSwitch(checkout), { ok: true, branch: 'feature' });
  assert.deepEqual(pullCheckouts.at(-1), ['pr', 'checkout', '42', '--repo', 'github.com/owner/repo']);
  assert.equal(await git('status', '--porcelain'), '');
  assert.equal((await checkoutSavedChanges({ cwd })).savedChanges[0].branch, 'main');
});

test('failed PR checkout restores saved changes only if still on the original branch', async (t) => {
  const { cwd, git, dirty } = await fixture(t);
  await git('remote', 'add', 'origin', 'https://github.com/owner/repo.git');
  await dirty();
  const before = await git('status', '--porcelain');
  const checkout = (number) => checkoutSwitch({
    cwd, branch: 'fork-head', expectedBranch: 'main', dirtyHandling: 'leave',
    pullRequest: { number, url: `https://github.com/owner/repo/pull/${number}` },
  });
  assert.equal((await checkout(43)).ok, false);
  assert.equal(await git('status', '--porcelain'), before);
  assert.deepEqual((await checkoutSavedChanges({ cwd })).savedChanges, []);
  const partial = await checkout(44);
  assert.equal(partial.ok, false);
  assert.equal(partial.branch, 'feature');
  assert.match(partial.error, /changes remain saved on main/);
  assert.equal(await git('status', '--porcelain'), '');
  assert.equal((await checkoutSavedChanges({ cwd })).savedChanges[0].branch, 'main');
});
