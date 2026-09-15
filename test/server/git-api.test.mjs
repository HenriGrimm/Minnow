/**
 * POST /api/git — git operations against a temp repository.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { after, before, describe, test } from 'node:test';
import {
  branches,
  cherryPick,
  commit,
  deleteBranch,
  deleteRemoteBranch,
  diff,
  filterUserFacingBranches,
  isMinnowBoardBranch,
  log,
  merge,
  parseBranchList,
  parseWorktreeLockedBranches,
  rebase,
  show,
  stage,
  stashList,
  stashPush,
  status,
  snapshotCreate,
  snapshotDiff,
  snapshotRestore,
  worktreeAdd,
  worktreeRemove,
  checkout,
} from '../../server/git/git-ops.js';
import { handleGitRequest } from '../../server/git/middleware.js';
import { setWorkspaceRoot } from '../../server/workspace/root.js';
import { closeWorkspace, openWorkspace } from '../../server/workspace/open-workspaces.js';
import { httpRequest } from '../config/test-helpers.js';

const execFileAsync = promisify(execFile);

function createGitTestServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    void handleGitRequest(req, res, url.pathname).then((handled) => {
      if (!handled) {
        res.statusCode = 404;
        res.end('not found');
      }
    });
  });
}

describe('git API', () => {
  let repoDir;
  let plainDir;
  let server;
  let baseUrl;

  before(async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-git-api-'));
    repoDir = path.join(root, 'repo');
    plainDir = path.join(root, 'plain');
    await fs.mkdir(repoDir, { recursive: true });
    await fs.mkdir(plainDir, { recursive: true });

    await setWorkspaceRoot(repoDir);
    await execFileAsync('git', ['init'], { cwd: repoDir, windowsHide: true });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], {
      cwd: repoDir,
      windowsHide: true,
    });
    await execFileAsync('git', ['config', 'user.name', 'Test'], {
      cwd: repoDir,
      windowsHide: true,
    });

    server = createGitTestServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  test('status buckets untracked and modified files', async () => {
    await fs.writeFile(path.join(repoDir, 'tracked.txt'), 'v1\n', 'utf8');
    await execFileAsync('git', ['add', 'tracked.txt'], { cwd: repoDir, windowsHide: true });
    await execFileAsync('git', ['commit', '-m', 'add tracked'], {
      cwd: repoDir,
      windowsHide: true,
    });

    await fs.writeFile(path.join(repoDir, 'tracked.txt'), 'v2\n', 'utf8');
    await fs.writeFile(path.join(repoDir, 'new.txt'), 'hello\n', 'utf8');

    const res = await status({ cwd: repoDir });
    assert.equal(res.ok, true);
    assert.ok(res.untracked?.some((f) => f.path === 'new.txt' && f.status === '?'));
    assert.ok(res.unstaged?.some((f) => f.path === 'tracked.txt'));
  });

  test('stage, commit, and log', async () => {
    await stage({ cwd: repoDir, paths: ['new.txt'] });
    const stagedStatus = await status({ cwd: repoDir });
    assert.ok(stagedStatus.staged?.some((f) => f.path === 'new.txt'));

    const committed = await commit({ cwd: repoDir, message: 'add new file' });
    assert.equal(committed.ok, true);
    assert.match(committed.sha ?? '', /^[0-9a-f]{40}$/);

    const history = await log({ cwd: repoDir, count: 5 });
    assert.equal(history.ok, true);
    assert.ok(history.commits?.some((c) => c.subject === 'add new file'));
  });

  test('commit expands gitmoji shortcodes into Unicode', async () => {
    await fs.writeFile(path.join(repoDir, 'gitmoji.txt'), 'x', 'utf8');
    await stage({ cwd: repoDir, paths: ['gitmoji.txt'] });
    const committed = await commit({
      cwd: repoDir,
      message: ':sparkles: add gitmoji fixture',
    });
    assert.equal(committed.ok, true);
    const history = await log({ cwd: repoDir, count: 5 });
    assert.ok(history.commits?.some((c) => c.subject === '✨ add gitmoji fixture'));
  });

  test('stage skips paths that no longer match anything', async () => {
    // MIN-651: the chat ledger keeps every path an agent touched, including a file it
    // created and deleted again. One such ghost used to abort the whole `git add`.
    await fs.writeFile(path.join(repoDir, 'kept.txt'), 'kept\n', 'utf8');

    const res = await stage({
      cwd: repoDir,
      paths: ['kept.txt', 'created-then-deleted.txt'],
    });

    assert.equal(res.ok, true);
    assert.deepEqual(res.stagedPaths, ['kept.txt']);
    assert.deepEqual(res.skippedPaths, ['created-then-deleted.txt']);

    const staged = await status({ cwd: repoDir });
    assert.ok(staged.staged?.some((f) => f.path === 'kept.txt'));
  });

  test('stage keeps deletions of tracked files', async () => {
    await fs.writeFile(path.join(repoDir, 'doomed.txt'), 'bye\n', 'utf8');
    await execFileAsync('git', ['add', 'doomed.txt'], { cwd: repoDir, windowsHide: true });
    await execFileAsync('git', ['commit', '-m', 'add doomed'], {
      cwd: repoDir,
      windowsHide: true,
    });
    await fs.rm(path.join(repoDir, 'doomed.txt'));

    // Deleted but still tracked: it matches the index, so the removal must stage.
    const res = await stage({ cwd: repoDir, paths: ['doomed.txt'] });
    assert.equal(res.ok, true);
    assert.deepEqual(res.stagedPaths, ['doomed.txt']);

    const staged = await status({ cwd: repoDir });
    assert.ok(staged.staged?.some((f) => f.path === 'doomed.txt' && f.status === 'D'));

    await execFileAsync('git', ['commit', '-m', 'remove doomed'], {
      cwd: repoDir,
      windowsHide: true,
    });
  });

  test('stage reports success when every path is gone', async () => {
    const res = await stage({ cwd: repoDir, paths: ['ghost-a.txt', 'ghost-b.txt'] });
    assert.equal(res.ok, true);
    assert.deepEqual(res.stagedPaths, []);
    assert.deepEqual(res.skippedPaths, ['ghost-a.txt', 'ghost-b.txt']);
  });

  test('commit auto-stages all changes when index is empty', async () => {
    await fs.writeFile(path.join(repoDir, 'auto.txt'), 'auto\n', 'utf8');
    await fs.writeFile(path.join(repoDir, 'tracked.txt'), 'v3\n', 'utf8');

    const committed = await commit({ cwd: repoDir, message: 'commit without staging' });
    assert.equal(committed.ok, true);
    assert.match(committed.sha ?? '', /^[0-9a-f]{40}$/);

    const after = await status({ cwd: repoDir });
    assert.equal(after.ok, true);
    assert.equal(after.staged?.length ?? 0, 0);
    assert.equal(after.unstaged?.length ?? 0, 0);
    assert.equal(after.untracked?.length ?? 0, 0);
  });

  test('diff workingTree includes unstaged and untracked changes', async () => {
    await fs.writeFile(path.join(repoDir, 'wt-mod.txt'), 'mod\n', 'utf8');
    await fs.writeFile(path.join(repoDir, 'wt-new.txt'), 'new\n', 'utf8');

    const patch = await diff({ cwd: repoDir, workingTree: true });
    assert.equal(patch.ok, true);
    assert.match(patch.patch ?? '', /wt-mod\.txt/);
    assert.match(patch.patch ?? '', /wt-new\.txt/);
  });

  test('diff and show return patch output', async () => {
    await fs.writeFile(path.join(repoDir, 'tracked.txt'), 'v4\n', 'utf8');

    const patch = await diff({ cwd: repoDir, path: 'tracked.txt' });
    assert.equal(patch.ok, true);
    assert.match(patch.patch ?? '', /tracked\.txt/);

    const history = await log({ cwd: repoDir, count: 1 });
    const sha = history.commits?.[0]?.hash;
    assert.ok(sha);

    const detail = await show({ cwd: repoDir, sha });
    assert.equal(detail.ok, true);
    assert.match(detail.stat ?? '', /files? changed/);
    assert.match(detail.patch ?? '', /diff --git/);
    assert.match(detail.stdout ?? '', /diff --git/);
    assert.match(detail.stdout ?? '', /Author:/);
  });

  test('branches lists current branch', async () => {
    const listed = await branches({ cwd: repoDir });
    assert.equal(listed.ok, true);
    assert.ok(listed.current);
    assert.ok(listed.local?.includes(listed.current));
  });

  test('parseBranchList omits branches checked out in other worktrees', () => {
    const parsed = parseBranchList(
      [
        '  main',
        '* develop',
        '+ feature/other-worktree',
        '  remotes/origin/main',
      ].join('\n'),
    );
    assert.equal(parsed.current, 'develop');
    assert.deepEqual(parsed.local, ['main', 'develop']);
    assert.deepEqual(parsed.lockedLocal, ['feature/other-worktree']);
    assert.deepEqual(parsed.remote, ['remotes/origin/main']);
  });

  test('filterUserFacingBranches omits locked worktree branches and keeps unlocked board refs', () => {
    assert.equal(isMinnowBoardBranch('minnow/board/x/task/W1-A'), true);
    assert.equal(isMinnowBoardBranch('feature/foo'), false);

    const locked = parseWorktreeLockedBranches(
      [
        'worktree /repo/main',
        'branch refs/heads/main',
        '',
        'worktree /repo/wt',
        'branch refs/heads/feature/wt',
        '',
        'worktree /home/.minnow/worktrees/repo/board/task',
        'branch refs/heads/minnow/board/x/task',
      ].join('\n'),
      '/repo/main',
    );
    assert.deepEqual([...locked].sort(), ['feature/wt', 'minnow/board/x/task']);

    const filtered = filterUserFacingBranches(
      ['main', 'feature/wt', 'minnow/board/x/integration', 'minnow/board/x/task', 'release'],
      locked,
    );
    assert.deepEqual(filtered, ['main', 'minnow/board/x/integration', 'release']);
  });

  test('deleteBranch removes a non-current branch', async () => {
    const before = await branches({ cwd: repoDir });
    const original = before.current;
    assert.ok(original);

    await execFileAsync('git', ['checkout', '-b', 'to-delete'], {
      cwd: repoDir,
      windowsHide: true,
    });
    await execFileAsync('git', ['checkout', original], { cwd: repoDir, windowsHide: true });

    const removed = await deleteBranch({ cwd: repoDir, branch: 'to-delete' });
    assert.equal(removed.ok, true);

    const after = await branches({ cwd: repoDir });
    assert.ok(!after.local?.includes('to-delete'));
  });

  test('deleteBranch rejects main and master', async () => {
    const mainResult = await deleteBranch({ cwd: repoDir, branch: 'main' });
    assert.equal(mainResult.ok, false);
    assert.match(mainResult.error ?? '', /main or master/i);

    const branchList = await branches({ cwd: repoDir });
    if (branchList.local?.includes('master')) {
      const masterResult = await deleteBranch({ cwd: repoDir, branch: 'master' });
      assert.equal(masterResult.ok, false);
      assert.match(masterResult.error ?? '', /main or master/i);
    }
  });

  test('remote deletion removes only the requested remote ref and preserves local branches', async () => {
    const remoteDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-remote-delete-'));
    const git = (args) => execFileAsync('git', args, { cwd: repoDir, windowsHide: true });
    await git(['init', '--bare', remoteDir]);
    await git(['remote', 'add', 'delete-test', remoteDir]);
    try {
      await git(['branch', 'feature/remote-delete']);
      await git(['push', 'delete-test', 'feature/remote-delete', 'HEAD:refs/heads/main']);
      for (const branch of ['delete-test/main', 'delete-test/master', 'delete-test/HEAD', 'missing/foo', 'delete-test/../bad']) {
        assert.equal((await deleteRemoteBranch({ cwd: repoDir, branch })).ok, false, branch);
      }
      const result = await deleteRemoteBranch({ cwd: repoDir, branch: 'remotes/delete-test/feature/remote-delete' });
      assert.equal(result.ok, true, result.error);
      const refs = await git(['ls-remote', '--heads', 'delete-test']);
      assert.doesNotMatch(refs.stdout, /feature\/remote-delete/);
      assert.match(refs.stdout, /refs\/heads\/main/);
      await git(['show-ref', '--verify', 'refs/heads/feature/remote-delete']);
      assert.equal((await deleteRemoteBranch({ cwd: repoDir, branch: 'delete-test/feature/remote-delete' })).ok, false);
    } finally {
      await git(['remote', 'remove', 'delete-test']);
      await git(['branch', '-D', 'feature/remote-delete']);
      await fs.rm(remoteDir, { recursive: true, force: true });
    }
  });

  test('worktreeAdd and worktreeRemove manage linked worktrees', async () => {
    const added = await worktreeAdd({
      cwd: repoDir,
      branch: 'wt-feature',
      path: path.join(repoDir, '.worktrees', 'wt-feature'),
    });
    assert.equal(added.ok, true);
    assert.equal(added.branch, 'wt-feature');

    const listed = await branches({ cwd: repoDir });
    assert.equal(listed.ok, true);
    assert.ok(!listed.local?.includes('wt-feature'));

    const removed = await worktreeRemove({
      cwd: repoDir,
      path: path.join(repoDir, '.worktrees', 'wt-feature'),
    });
    assert.equal(removed.ok, true);

    const afterRemove = await branches({ cwd: repoDir });
    assert.equal(afterRemove.ok, true);
    assert.ok(afterRemove.local?.includes('wt-feature'));
  });

  test('worktreeRemove allows deleting the selected linked worktree when cwd is that path', async () => {
    const wtPath = path.join(repoDir, '.worktrees', 'wt-remove-self');
    const added = await worktreeAdd({
      cwd: repoDir,
      branch: 'wt-remove-self',
      path: wtPath,
    });
    assert.equal(added.ok, true);

    const removed = await worktreeRemove({ cwd: wtPath, path: wtPath });
    assert.equal(removed.ok, true);
  });

  test('worktreeRemove rejects removing the principal worktree', async () => {
    const removed = await worktreeRemove({ cwd: repoDir, path: repoDir });
    assert.equal(removed.ok, false);
    assert.match(removed.error ?? '', /Cannot remove the main worktree|is a main working tree/i);
  });

  test('worktreeAdd slugifies invalid branch names', async () => {
    const added = await worktreeAdd({
      cwd: repoDir,
      branch: 'Test Worktree',
    });
    assert.equal(added.ok, true);
    assert.equal(added.branch, 'test-worktree');
    assert.match(String(added.path ?? '').replace(/\\/g, '/'), /test-worktree$/);

    const removed = await worktreeRemove({
      cwd: repoDir,
      path: added.path,
    });
    assert.equal(removed.ok, true);
  });

  test('worktreeAdd starts a new branch from baseRef instead of HEAD', async () => {
    const before = await branches({ cwd: repoDir });
    const original = before.current;
    await checkout({ cwd: repoDir, branch: 'wt-base-src', create: true });
    await fs.writeFile(path.join(repoDir, 'wt-base-only.txt'), 'from-base\n', 'utf8');
    await execFileAsync('git', ['add', 'wt-base-only.txt'], { cwd: repoDir, windowsHide: true });
    await execFileAsync('git', ['commit', '-m', 'wt base src'], {
      cwd: repoDir,
      windowsHide: true,
    });
    const back = await checkout({ cwd: repoDir, branch: original });
    assert.equal(back.ok, true);

    const wtPath = path.join(repoDir, '.worktrees', 'wt-from-base');
    const added = await worktreeAdd({
      cwd: repoDir,
      branch: 'wt-from-base',
      path: wtPath,
      baseRef: 'wt-base-src',
    });
    assert.equal(added.ok, true);
    assert.equal(added.branch, 'wt-from-base');
    const marker = await fs.readFile(path.join(wtPath, 'wt-base-only.txt'), 'utf8');
    assert.match(marker, /from-base/);
    await assert.rejects(() => fs.access(path.join(repoDir, 'wt-base-only.txt')));

    const removed = await worktreeRemove({ cwd: repoDir, path: wtPath });
    assert.equal(removed.ok, true);
  });

  test('worktreeAdd checkoutExisting attaches a local branch without -b', async () => {
    const before = await branches({ cwd: repoDir });
    const original = before.current;
    await checkout({ cwd: repoDir, branch: 'wt-existing-co', create: true });
    const back = await checkout({ cwd: repoDir, branch: original });
    assert.equal(back.ok, true);

    const wtPath = path.join(repoDir, '.worktrees', 'wt-existing-co');
    const added = await worktreeAdd({
      cwd: repoDir,
      branch: 'wt-existing-co',
      path: wtPath,
      checkoutExisting: true,
    });
    assert.equal(added.ok, true);
    assert.equal(added.branch, 'wt-existing-co');

    const removed = await worktreeRemove({ cwd: repoDir, path: wtPath });
    assert.equal(removed.ok, true);
  });

  test('worktreeAdd checkoutExisting rejects a branch already checked out', async () => {
    const current = (await branches({ cwd: repoDir })).current;
    assert.ok(current);
    const failed = await worktreeAdd({
      cwd: repoDir,
      branch: current,
      checkoutExisting: true,
    });
    assert.equal(failed.ok, false);
    assert.match(failed.error ?? '', /already checked out|is already used by worktree/i);
  });

  test('worktreeAdd checkoutExisting tracks a remote-only ref', async () => {
    const wtPath = path.join(repoDir, '.worktrees', 'wt-from-remote');
    await execFileAsync('git', ['update-ref', 'refs/remotes/origin/wt-from-remote', 'HEAD'], {
      cwd: repoDir,
      windowsHide: true,
    });
    const added = await worktreeAdd({
      cwd: repoDir,
      branch: 'origin/wt-from-remote',
      path: wtPath,
      checkoutExisting: true,
    });
    assert.equal(added.ok, true);
    assert.equal(added.branch, 'wt-from-remote');
    const removed = await worktreeRemove({ cwd: repoDir, path: wtPath });
    assert.equal(removed.ok, true);
  });

  test('checkout create slugifies invalid branch names', async () => {
    const before = await branches({ cwd: repoDir });
    const original = before.current;
    const created = await checkout({
      cwd: repoDir,
      branch: 'Test Branch',
      create: true,
    });
    assert.equal(created.ok, true);
    assert.equal(created.branch, 'test-branch');

    const listed = await branches({ cwd: repoDir });
    assert.ok(listed.local?.includes('test-branch'));

    const back = await checkout({ cwd: repoDir, branch: original });
    assert.equal(back.ok, true);
  });

  test('POST /api/git status honors cwd', async () => {
    // An allowed folder that simply is not a repo still answers normally.
    openWorkspace(plainDir);
    try {
      const missing = await httpRequest(baseUrl, 'POST', '/api/git', {
        op: 'status',
        cwd: plainDir,
      });
      assert.equal(missing.status, 200);
      assert.equal(missing.json?.ok, false);
      assert.match(missing.json?.error ?? '', /Not a git repository/);
    } finally {
      closeWorkspace(plainDir);
    }

    const ok = await httpRequest(baseUrl, 'POST', '/api/git', {
      op: 'status',
      cwd: repoDir,
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.json?.ok, true);
    assert.ok(Array.isArray(ok.json?.staged));
  });

  test('POST /api/git rejects a cwd outside the workspace allowlist', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-git-outside-'));
    try {
      const res = await httpRequest(baseUrl, 'POST', '/api/git', {
        op: 'status',
        cwd: outside,
      });
      assert.equal(res.status, 400);
      assert.match(res.json?.error ?? '', /not in the allowlist/);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  test('rejects unknown git op', async () => {
    const res = await httpRequest(baseUrl, 'POST', '/api/git', { op: 'nope' });
    assert.equal(res.status, 400);
    assert.match(res.json?.error ?? '', /Unknown git op/);
  });

  test('merge merges a topic branch', async () => {
    const main = (await branches({ cwd: repoDir })).current;
    assert.ok(main);

    await execFileAsync('git', ['checkout', '-b', 'git-api-merge-target'], {
      cwd: repoDir,
      windowsHide: true,
    });
    await fs.writeFile(path.join(repoDir, 'git-api-merge.txt'), 'merge-target\n', 'utf8');
    await execFileAsync('git', ['add', 'git-api-merge.txt'], { cwd: repoDir, windowsHide: true });
    await execFileAsync('git', ['commit', '-m', 'git-api merge target'], {
      cwd: repoDir,
      windowsHide: true,
    });

    await execFileAsync('git', ['checkout', main], { cwd: repoDir, windowsHide: true });
    const merged = await merge({ cwd: repoDir, branch: 'git-api-merge-target' });
    assert.equal(merged.ok, true);
  });

  test('stash push and list', async () => {
    await fs.writeFile(path.join(repoDir, 'git-api-stash.txt'), 'stash-me\n', 'utf8');

    const stashed = await stashPush({ cwd: repoDir, message: 'git-api stash' });
    assert.equal(stashed.ok, true);

    const stashEntries = await stashList({ cwd: repoDir });
    assert.equal(stashEntries.ok, true);
    assert.ok((stashEntries.stashes ?? []).length >= 1);
  });

  test('rebase replays branch commits onto main', async () => {
    const main = (await branches({ cwd: repoDir })).current;
    assert.ok(main);

    await execFileAsync('git', ['checkout', '-b', 'git-api-rebase-branch'], {
      cwd: repoDir,
      windowsHide: true,
    });
    await fs.writeFile(path.join(repoDir, 'git-api-rebase.txt'), 'rebase\n', 'utf8');
    await execFileAsync('git', ['add', 'git-api-rebase.txt'], { cwd: repoDir, windowsHide: true });
    await execFileAsync('git', ['commit', '-m', 'git-api rebase commit'], {
      cwd: repoDir,
      windowsHide: true,
    });

    await execFileAsync('git', ['checkout', main], { cwd: repoDir, windowsHide: true });
    await fs.writeFile(path.join(repoDir, 'git-api-main-only.txt'), 'main-only\n', 'utf8');
    await execFileAsync('git', ['add', 'git-api-main-only.txt'], { cwd: repoDir, windowsHide: true });
    await execFileAsync('git', ['commit', '-m', 'git-api main advance'], {
      cwd: repoDir,
      windowsHide: true,
    });

    await execFileAsync('git', ['checkout', 'git-api-rebase-branch'], {
      cwd: repoDir,
      windowsHide: true,
    });
    const rebased = await rebase({ cwd: repoDir, onto: main });
    assert.equal(rebased.ok, true);
  });

  test('cherry-pick applies a commit onto main', async () => {
    const main = (await branches({ cwd: repoDir })).current;
    assert.ok(main);

    await execFileAsync('git', ['checkout', '-b', 'git-api-cherry-src'], {
      cwd: repoDir,
      windowsHide: true,
    });
    await fs.writeFile(path.join(repoDir, 'git-api-cherry.txt'), 'cherry\n', 'utf8');
    await execFileAsync('git', ['add', 'git-api-cherry.txt'], { cwd: repoDir, windowsHide: true });
    await execFileAsync('git', ['commit', '-m', 'git-api cherry source'], {
      cwd: repoDir,
      windowsHide: true,
    });

    const logRes = await log({ cwd: repoDir, count: 1 });
    assert.equal(logRes.ok, true);
    const pickSha = logRes.commits?.[0]?.hash;
    assert.ok(pickSha);

    await execFileAsync('git', ['checkout', main], { cwd: repoDir, windowsHide: true });
    const picked = await cherryPick({ cwd: repoDir, sha: pickSha });
    assert.equal(picked.ok, true);
  });

  test('POST /api/git stashList honors cwd', async () => {
    const viaApi = await httpRequest(baseUrl, 'POST', '/api/git', {
      op: 'stashList',
      cwd: repoDir,
    });
    assert.equal(viaApi.status, 200);
    assert.equal(viaApi.json?.ok, true);
  });

  test('snapshotCreate makes a dangling commit without touching HEAD or index', async () => {
    const headBefore = (
      await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, windowsHide: true })
    ).stdout.trim();

    await fs.writeFile(path.join(repoDir, 'snap-a.txt'), 'before\n', 'utf8');
    await execFileAsync('git', ['add', 'snap-a.txt'], { cwd: repoDir, windowsHide: true });
    const cachedBefore = (
      await execFileAsync('git', ['diff', '--cached'], { cwd: repoDir, windowsHide: true })
    ).stdout;

    await fs.writeFile(path.join(repoDir, 'snap-a.txt'), 'after\n', 'utf8');
    await fs.writeFile(path.join(repoDir, 'snap-untracked.txt'), 'new\n', 'utf8');

    const created = await snapshotCreate({
      cwd: repoDir,
      message: 'minnow test snapshot',
    });
    assert.equal(created.ok, true);
    assert.match(created.sha ?? '', /^[0-9a-f]{40}$/i);
    assert.equal(created.headSha, headBefore);

    const headAfter = (
      await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, windowsHide: true })
    ).stdout.trim();
    assert.equal(headAfter, headBefore);

    const cachedAfter = (
      await execFileAsync('git', ['diff', '--cached'], { cwd: repoDir, windowsHide: true })
    ).stdout;
    assert.equal(cachedAfter, cachedBefore);

    // Dangling: not reachable from HEAD tip.
    const contains = await execFileAsync(
      'git',
      ['merge-base', '--is-ancestor', created.sha, 'HEAD'],
      { cwd: repoDir, windowsHide: true },
    ).then(
      () => true,
      () => false,
    );
    assert.equal(contains, false);
  });

  test('snapshotRestore rewrites WT without moving HEAD and cleans untracked', async () => {
    const headBefore = (
      await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, windowsHide: true })
    ).stdout.trim();

    await fs.writeFile(path.join(repoDir, 'snap-restore.txt'), 'v1\n', 'utf8');
    const pre = await snapshotCreate({ cwd: repoDir, message: 'pre' });
    assert.equal(pre.ok, true);

    await fs.writeFile(path.join(repoDir, 'snap-restore.txt'), 'v2\n', 'utf8');
    await fs.writeFile(path.join(repoDir, 'snap-restore-extra.txt'), 'extra\n', 'utf8');
    const post = await snapshotCreate({ cwd: repoDir, message: 'post' });
    assert.equal(post.ok, true);

    const changed = await snapshotDiff({
      cwd: repoDir,
      fromSha: pre.sha,
      toSha: post.sha,
    });
    assert.equal(changed.ok, true);
    assert.ok(changed.files?.some((f) => f.path === 'snap-restore.txt'));

    const restored = await snapshotRestore({ cwd: repoDir, sha: pre.sha });
    assert.equal(restored.ok, true);
    assert.match(restored.safetySha ?? '', /^[0-9a-f]{40}$/i);

    const headAfter = (
      await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, windowsHide: true })
    ).stdout.trim();
    assert.equal(headAfter, headBefore);

    const content = await fs.readFile(path.join(repoDir, 'snap-restore.txt'), 'utf8');
    // Normalize CRLF from core.autocrlf on Windows.
    assert.equal(content.replace(/\r\n/g, '\n'), 'v1\n');

    await assert.rejects(() => fs.access(path.join(repoDir, 'snap-restore-extra.txt')));
  });

  test('POST /api/git snapshotCreate honors cwd', async () => {
    const viaApi = await httpRequest(baseUrl, 'POST', '/api/git', {
      op: 'snapshotCreate',
      cwd: repoDir,
      message: 'via http',
    });
    assert.equal(viaApi.status, 200);
    assert.equal(viaApi.json?.ok, true);
    assert.match(viaApi.json?.sha ?? '', /^[0-9a-f]{40}$/i);
  });
});
