import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { enableChatWorktree } from '../../server/worktree/worktree-ops.js';
import { getChatWorktreePath } from '../../server/worktree/paths.js';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { runWithToolContext } from '../../server/runtime/path-access.js';

const exec = promisify(execFile);

test('automatic chat setup isolates, coalesces, reuses the actual branch, and avoids collisions', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-auto-chat-'));
  const repo = path.join(root, 'repo');
  const oldHome = process.env.MINNOW_HOME;
  process.env.MINNOW_HOME = path.join(root, 'home');
  resetMinnowHomeCache();
  const git = (args, cwd = repo) => exec('git', args, { cwd, windowsHide: true });
  try {
    await fs.mkdir(repo);
    await git(['init']);
    await git(['config', 'user.name', 'Test']);
    await git(['config', 'user.email', 'test@example.com']);
    await fs.writeFile(path.join(repo, 'file.txt'), 'committed');
    await git(['add', '.']);
    await git(['commit', '-m', 'initial']);
    await fs.writeFile(path.join(repo, 'file.txt'), 'local edits');
    const setup = (args) => runWithToolContext(() => enableChatWorktree(args), { workspaceRoot: repo });
    const [first, duplicate] = await Promise.all([
      setup({ chatId: 'one', title: 'MIN-42: Fix Login!' }),
      setup({ chatId: 'one', title: 'MIN-42: Fix Login!' }),
    ]);
    assert.equal(first.ok, true, first.error);
    assert.equal(duplicate.path, first.path);
    assert.match(first.branch, /^minnow\/min-42-fix-login-/);
    assert.equal(await fs.readFile(path.join(first.path, 'file.txt'), 'utf8'), 'committed');
    assert.equal(await fs.readFile(path.join(repo, 'file.txt'), 'utf8'), 'local edits');
    await git(['branch', '-m', 'renamed-by-user'], first.path);
    await fs.writeFile(path.join(first.path, 'keep.txt'), 'keep me');
    const reused = await setup({ chatId: 'one', title: 'Different title' });
    assert.equal(reused.branch, 'renamed-by-user');
    assert.equal(await fs.readFile(path.join(first.path, 'keep.txt'), 'utf8'), 'keep me');
    const other = await setup({ chatId: 'two', title: 'MIN-42: Fix Login!' });
    assert.equal(other.ok, true, other.error);
    assert.notEqual(other.branch, first.branch);
    await git(['worktree', 'remove', other.path]);
    const recreated = await setup({ chatId: 'two', title: 'MIN-42: Fix Login!' });
    assert.equal(recreated.ok, true, recreated.error);
    assert.equal(recreated.branch, `${other.branch}-2`);
    const invalidPath = await runWithToolContext(() => getChatWorktreePath('husk'), { workspaceRoot: repo });
    await fs.mkdir(invalidPath, { recursive: true });
    await fs.writeFile(path.join(invalidPath, 'important.txt'), 'preserve');
    const invalid = await setup({ chatId: 'husk', title: 'Husk' });
    assert.equal(invalid.ok, false);
    assert.match(invalid.error, /not a registered checkout/);
    assert.equal(await fs.readFile(path.join(invalidPath, 'important.txt'), 'utf8'), 'preserve');

    // A failed package setup keeps the same checkout and retries after repair.
    await fs.writeFile(path.join(repo, 'package.json'), JSON.stringify({
      name: 'worktree-setup-test', version: '1.0.0', private: true,
      scripts: { install: 'node -e "process.exit(1)"' },
    }));
    await git(['add', 'package.json']);
    await git(['commit', '-m', 'dependency fixture']);
    const failed = await setup({ chatId: 'retry', title: 'Dependency setup' });
    assert.equal(failed.ok, false);
    assert.match(failed.error, /Setup failed/);
    await fs.writeFile(path.join(failed.path, 'package.json'), JSON.stringify({ name: 'worktree-setup-test', version: '1.0.0', private: true }));
    const repaired = await setup({ chatId: 'retry', title: 'Dependency setup' });
    assert.equal(repaired.ok, true, repaired.error);
    assert.equal(repaired.path, failed.path);
    assert.equal(repaired.branch, failed.branch);
  } finally {
    if (oldHome === undefined) delete process.env.MINNOW_HOME; else process.env.MINNOW_HOME = oldHome;
    resetMinnowHomeCache();
    await fs.rm(root, { recursive: true, force: true });
  }
});
