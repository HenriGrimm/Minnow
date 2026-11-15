/**
 * Isolated chat worktrees in a workspace folder that holds several repos.
 */

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { enableChatWorktree, removeChatWorktree } from '../../server/worktree/worktree-ops.js';
import { mergeChatWorktree } from '../../server/worktree/merge-chat.js';
import { MIRROR_MANIFEST, readMirrorManifest } from '../../server/worktree/multi-repo.js';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { runWithToolContext } from '../../server/runtime/path-access.js';
import { invalidateWorkspaceRepos } from '../../server/workspace/repos.js';
import { initializeWorkspaceGit } from '../../server/workspace/initialize-git.js';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();

async function makeRepo(dir, file) {
  await fs.mkdir(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  await fs.writeFile(path.join(dir, file), 'one\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'initial');
}

describe('multi-repo chat worktrees', () => {
  let tmp;
  let root;
  let oldHome;
  const inWorkspace = (fn) => runWithToolContext(fn, { workspaceRoot: root });

  before(async () => {
    tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mn-multi-wt-')));
    root = path.join(tmp, 'app');
    oldHome = process.env.MINNOW_HOME;
    process.env.MINNOW_HOME = path.join(tmp, 'home');
    resetMinnowHomeCache();
    await makeRepo(path.join(root, 'frontend'), 'web.txt');
    await makeRepo(path.join(root, 'backend'), 'api.txt');
    invalidateWorkspaceRepos();
  });

  after(async () => {
    if (oldHome === undefined) delete process.env.MINNOW_HOME;
    else process.env.MINNOW_HOME = oldHome;
    resetMinnowHomeCache();
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  test('enable creates one worktree per repo, mirrored, on one branch', async () => {
    const result = await inWorkspace(() => enableChatWorktree({ chatId: 'c1', title: 'Add endpoint' }));
    assert.equal(result.ok, true, result.error);
    assert.match(result.branch, /^minnow\/add-endpoint-/);
    const manifest = await readMirrorManifest(result.path);
    assert.deepEqual(manifest.repos.map((r) => r.id), ['backend', 'frontend']);
    for (const id of ['backend', 'frontend']) {
      assert.equal(git(path.join(result.path, id), 'symbolic-ref', '--short', 'HEAD'), result.branch);
    }
    // core.autocrlf may rewrite line endings on checkout; content is what matters.
    assert.equal((await fs.readFile(path.join(result.path, 'backend', 'api.txt'), 'utf8')).trim(), 'one');
    // The parent of the mirror is not a repository, and neither is the workspace.
    assert.throws(() => git(root, 'rev-parse', '--is-inside-work-tree'));
    const again = await inWorkspace(() => enableChatWorktree({ chatId: 'c1', title: 'Other' }));
    assert.equal(again.branch, result.branch);
  });

  test('merge lands only the repos the chat changed, then removes the mirror', async () => {
    const enabled = await inWorkspace(() => enableChatWorktree({ chatId: 'c1', title: 'Add endpoint' }));
    const wtBackend = path.join(enabled.path, 'backend');
    await fs.writeFile(path.join(wtBackend, 'api.txt'), 'two\n');
    git(wtBackend, 'commit', '-q', '-am', 'backend change');
    const frontendBefore = git(path.join(root, 'frontend'), 'rev-parse', 'main');

    const merged = await inWorkspace(() => mergeChatWorktree({ chatId: 'c1', branch: enabled.branch, targetBranch: 'main' }));
    assert.equal(merged.ok, true, merged.error);
    assert.deepEqual(merged.repos.map((r) => [r.repo, Boolean(r.unchanged)]), [['backend', false], ['frontend', true]]);
    assert.match(git(path.join(root, 'backend'), 'log', '--oneline', '-3', 'main'), /backend change/);
    assert.equal(git(path.join(root, 'frontend'), 'rev-parse', 'main'), frontendBefore);
    await assert.rejects(fs.access(path.join(enabled.path, MIRROR_MANIFEST)));
  });

  test('a conflict in one repo keeps the mirror and reports that repo', async () => {
    const enabled = await inWorkspace(() => enableChatWorktree({ chatId: 'c2', title: 'Conflict' }));
    const wtFront = path.join(enabled.path, 'frontend');
    await fs.writeFile(path.join(wtFront, 'web.txt'), 'agent\n');
    git(wtFront, 'commit', '-q', '-am', 'agent edit');
    await fs.writeFile(path.join(root, 'frontend', 'web.txt'), 'user\n');
    git(path.join(root, 'frontend'), 'commit', '-q', '-am', 'user edit');

    const merged = await inWorkspace(() => mergeChatWorktree({ chatId: 'c2', branch: enabled.branch, targetBranch: 'main' }));
    assert.equal(merged.ok, false);
    assert.equal(merged.conflict, true);
    assert.match(merged.error, /^frontend:/);
    assert.ok(await readMirrorManifest(enabled.path));

    const removed = await inWorkspace(() => removeChatWorktree({ chatId: 'c2' }));
    assert.equal(removed.ok, true);
    await assert.rejects(fs.access(enabled.path));
    assert.doesNotMatch(git(path.join(root, 'frontend'), 'worktree', 'list'), /Conflict|c2/);
  });

  test('a board refuses a folder of repos without touching the parent', async () => {
    const { ensureBoardWorkspaceGit } = await import('../../server/orchestrator/worktree-lifecycle.js');
    const result = await inWorkspace(() => ensureBoardWorkspaceGit());
    assert.equal(result.ok, false);
    assert.match(result.error, /Boards run in a single repository, and this folder holds several \(backend, frontend\)/);
    await assert.rejects(fs.access(path.join(root, '.git')));
  });

  test('git init refuses a folder of repos', async () => {
    const result = await initializeWorkspaceGit(root);
    assert.equal(result.ok, false);
    assert.match(result.error, /several git repositories \(backend, frontend\)/);
    await assert.rejects(fs.access(path.join(root, '.git')));
  });
});
