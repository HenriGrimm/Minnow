import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { pathAccessStore } from '../../server/runtime/path-access.js';
import { getChatWorktreePath } from '../../server/worktree/paths.js';
import { createChatWorktree } from '../../server/worktree/worktree-ops.js';
import { mergeChatWorktree } from '../../server/worktree/merge-chat.js';

test('Home approvals preserve dirty checkout files, stop conflicts before main, and serialize merges', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-home-merge-'));
  const repo = path.join(root, 'repo'); await fs.mkdir(repo);
  const oldHome = process.env.MINNOW_HOME; process.env.MINNOW_HOME = path.join(root, 'home'); resetMinnowHomeCache();
  const git = (args, cwd = repo) => execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf8', stdio: 'pipe' }).trim();
  try {
    git(['init', '-b', 'main']); git(['config', 'core.autocrlf', 'false']); git(['config', 'user.email', 'test@example.com']); git(['config', 'user.name', 'Test']);
    await fs.writeFile(path.join(repo, 'base.txt'), 'base\n'); git(['add', '.']); git(['commit', '-m', 'base']);
    await pathAccessStore.run({ workspaceRootOverride: repo }, async () => {
      const start = async (id, file, content) => {
        const result = await createChatWorktree({ chatId: id, branch: `wt/${id}`, baseRef: 'main' }); assert.equal(result.ok, true);
        await fs.writeFile(path.join(result.path, file), content); git(['add', '.'], result.path); git(['commit', '-m', id], result.path); return result.path;
      };
      const first = await start('first', 'first.txt', 'first\n');
      await fs.writeFile(path.join(repo, 'base.txt'), 'user edits\n');
      const merged = await mergeChatWorktree({ chatId: 'first', branch: 'wt/first' });
      assert.equal(merged.ok, true); assert.equal(merged.removed, true);
      assert.equal(await fs.readFile(path.join(repo, 'base.txt'), 'utf8'), 'user edits\n');
      assert.equal(await fs.readFile(path.join(repo, 'first.txt'), 'utf8'), 'first\n');
      await assert.rejects(fs.access(first));
      git(['restore', 'base.txt']);
      const conflict = await start('conflict', 'base.txt', 'agent change\n');
      await fs.writeFile(path.join(repo, 'base.txt'), 'main change\n'); git(['add', '.']); git(['commit', '-m', 'main changed']);
      const before = git(['rev-parse', 'HEAD']);
      const stopped = await mergeChatWorktree({ chatId: 'conflict', branch: 'wt/conflict' });
      assert.equal(stopped.ok, false); assert.equal(stopped.conflict, true);
      assert.equal(git(['rev-parse', 'HEAD']), before); await fs.access(conflict);
      assert.equal(git(['status', '--porcelain']), '');
      const dirty = await start('dirty', 'dirty.txt', 'committed\n');
      await fs.writeFile(path.join(dirty, 'dirty.txt'), 'uncommitted\n');
      assert.equal((await mergeChatWorktree({ chatId: 'dirty', branch: 'wt/dirty' })).ok, false);
      assert.equal(await fs.readFile(path.join(dirty, 'dirty.txt'), 'utf8'), 'uncommitted\n');
      await start('second', 'second.txt', 'second\n'); await start('third', 'third.txt', 'third\n');
      const results = await Promise.all(['second', 'third'].map(id => mergeChatWorktree({ chatId: id, branch: `wt/${id}` })));
      assert.ok(results.every(result => result.ok));
      assert.equal(await fs.readFile(path.join(repo, 'second.txt'), 'utf8'), 'second\n'); assert.equal(await fs.readFile(path.join(repo, 'third.txt'), 'utf8'), 'third\n');
      assert.equal((await mergeChatWorktree({ chatId: 'dirty', branch: 'main' })).ok, false);
      assert.equal((await mergeChatWorktree({ chatId: 'dirty', branch: '--bad' })).ok, false);
      assert.equal(getChatWorktreePath('dirty'), dirty);
    });
  } finally {
    if (oldHome === undefined) delete process.env.MINNOW_HOME; else process.env.MINNOW_HOME = oldHome;
    resetMinnowHomeCache(); await fs.rm(root, { recursive: true, force: true });
  }
});
