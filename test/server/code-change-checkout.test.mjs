import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { withCodeChangeCheckout } from '../../server/tools/code-change-checkout.js';
import { codeChangeForGitCommit } from '../../server/tools/git-change-stats.js';
import { resetMinnowHomeCache } from '../../server/config/home.js';

test('mutation provenance survives later branch changes and records the actual worktree', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-change-branch-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'repo');
  const slot = path.join(temp, 'slot');
  await fs.mkdir(root);
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main');
  const change = { path: 'new.txt', additions: 1, deletions: 0 };
  assert.equal((await withCodeChangeCheckout(change, root)).gitBranch, 'main', 'unborn branch');
  git('config', 'user.name', 'Minnow Test'); git('config', 'user.email', 'test@example.test');
  await fs.writeFile(path.join(root, 'new.txt'), 'new\n');
  git('add', '.'); git('commit', '-m', 'initial');
  git('checkout', '-b', 'feature');
  const recorded = await withCodeChangeCheckout(change, root);
  const commit = await codeChangeForGitCommit(root);
  assert.equal(commit.gitBranch, 'feature');
  assert.ok(commit.commitSha);
  git('checkout', 'main');
  assert.equal(recorded.gitBranch, 'feature');
  git('worktree', 'add', '-b', 'isolated', slot);
  const isolated = await withCodeChangeCheckout(change, slot);
  assert.equal(isolated.gitBranch, 'isolated');
  assert.equal(path.resolve(isolated.workspacePath), path.resolve(slot));
  git('checkout', '--detach');
  assert.equal((await withCodeChangeCheckout(change, root)).gitBranch, 'HEAD');
  const plain = await withCodeChangeCheckout(change, temp);
  assert.equal(plain.gitBranch, undefined);
  assert.equal(plain.workspacePath, temp);
  const nested = path.join(root, 'nested');
  await fs.mkdir(nested);
  assert.equal((await withCodeChangeCheckout(change, nested)).workspacePath, nested, 'paths remain relative to the tool workspace, not Git root');

  const previousHome = process.env.MINNOW_HOME;
  process.env.MINNOW_HOME = path.join(temp, 'home'); resetMinnowHomeCache();
  try {
    const { executeServerTool } = await import('../../server/runtime/tools-middleware.js');
    const output = await executeServerTool('save_file', { path: 'agent.txt', content: 'agent change\n' }, { workspaceRoot: slot });
    assert.equal(output.codeChange?.gitBranch, 'isolated', output.result);
    assert.equal(path.resolve(output.codeChange.workspacePath), path.resolve(slot));
  } finally {
    if (previousHome === undefined) delete process.env.MINNOW_HOME; else process.env.MINNOW_HOME = previousHome;
    resetMinnowHomeCache();
  }
});
