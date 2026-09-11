/**
 * Board worktree ops: commitWorktree and checkMerged.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { after, before, describe, test } from 'node:test';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import {
  checkMerged,
  checkWorktreeDirty,
  cleanupBoardWorktrees,
  cleanupBoardBranches,
  commitIntegration,
  commitWorktree,
  createWorktree,
  ensureIntegration,
  integrationStats,
  mergeIntegrationIntoWorkspace,
  mergeIntoIntegration,
  peakBoardIntegrationLockDepth,
  pushIntegration,
  rebaseOntoIntegration,
  refreshIntegrationDeps,
  removeWorktree,
  resetBoardIntegrationLock,
  restoreIntegration,
  verifyIntegrationMerge,
  workspaceLandingStats,
  listWorktrees,
  removeWorktreeSlotsBulk,
} from '../../server/worktree/worktree-ops.js';
import { getWorktreeSlotPath } from '../../server/worktree/paths.js';
import { setWorkspaceRoot } from '../../server/workspace/root.js';

const execFileAsync = promisify(execFile);
const BOARD_ID = 'test-board-11111111';

// ── worktree commit ──────────────────────────────────────────────────────────

test('board branch cleanup is scoped, repeatable, and preserves unmerged and checked-out branches', async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-branch-cleanup-'));
  const git = (args) => execFileAsync('git', args, { cwd: repo, windowsHide: true });
  await git(['init']);
  await git(['config', 'user.email', 'test@example.com']);
  await git(['config', 'user.name', 'Test']);
  await git(['commit', '--allow-empty', '-m', 'base']);
  await setWorkspaceRoot(repo);
  const prefix = 'minnow/board/cleanup-test/';
  await git(['branch', `${prefix}integration`]);
  await git(['branch', 'minnow/board/cleanup-test-other/integration']);
  await git(['checkout', '-b', `${prefix}unmerged`]);
  await git(['commit', '--allow-empty', '-m', 'unique work']);
  await git(['checkout', '-b', `${prefix}current`, 'HEAD~1']);
  const result = await cleanupBoardBranches({ boardId: 'cleanup-test' });
  assert.deepEqual(result.removedBranches, [`${prefix}integration`]);
  assert.deepEqual(result.retainedBranches.map((item) => item.branch).sort(), [`${prefix}current`, `${prefix}unmerged`]);
  await git(['rev-parse', '--verify', 'refs/heads/minnow/board/cleanup-test-other/integration']);
  assert.deepEqual((await cleanupBoardBranches({ boardId: 'cleanup-test' })).removedBranches, []);
  assert.equal((await cleanupBoardBranches({ boardId: '*' })).ok, false);
});

describe('worktree commit and merge checks', () => {
  let repoDir;
  let minnowHome;
  let integrationBranch;
  let taskBranch;

  before(async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-wt-ops-'));
    repoDir = path.join(root, 'repo');
    minnowHome = path.join(root, 'minnow-home');
    await fs.mkdir(repoDir, { recursive: true });
    await fs.mkdir(minnowHome, { recursive: true });
    process.env.MINNOW_HOME = minnowHome;
    await setWorkspaceRoot(repoDir);

    await execFileAsync('git', ['init'], { cwd: repoDir, windowsHide: true });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], {
      cwd: repoDir,
      windowsHide: true,
    });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: repoDir, windowsHide: true });
    await fs.writeFile(path.join(repoDir, 'README.md'), '# base\n', 'utf8');
    await execFileAsync('git', ['add', 'README.md'], { cwd: repoDir, windowsHide: true });
    await execFileAsync('git', ['commit', '-m', 'init'], { cwd: repoDir, windowsHide: true });

    integrationBranch = `minnow/board/${BOARD_ID}/integration`;
    taskBranch = `minnow/board/${BOARD_ID}/task/W1-A`;

    const ensured = await ensureIntegration({
      boardId: BOARD_ID,
      branch: integrationBranch,
    });
    assert.equal(ensured.ok, true);

    const created = await createWorktree({
      boardId: BOARD_ID,
      slotId: 'task-W1-A',
      branch: taskBranch,
      baseRef: integrationBranch,
    });
    assert.equal(created.ok, true);
  });

  after(async () => {
    delete process.env.MINNOW_HOME;
  });

  test('commitWorktree returns committed:false when there are no changes', async () => {
    const res = await commitWorktree({
      boardId: BOARD_ID,
      slotId: 'task-W1-A',
      message: 'empty',
    });
    assert.equal(res.ok, true);
    assert.equal(res.committed, false);
  });

  test('checkWorktreeDirty reports clean and dirty task worktrees', async () => {
    const clean = await checkWorktreeDirty({
      boardId: BOARD_ID,
      slotId: 'task-W1-A',
    });
    assert.equal(clean.ok, true);
    assert.equal(clean.dirty, false);
    assert.deepEqual(clean.files, []);

    const taskWt = getWorktreeSlotPath(BOARD_ID, 'task-W1-A', repoDir);
    await fs.writeFile(path.join(taskWt, 'orphan.txt'), 'partial\n', 'utf8');

    const dirty = await checkWorktreeDirty({
      boardId: BOARD_ID,
      slotId: 'task-W1-A',
    });
    assert.equal(dirty.ok, true);
    assert.equal(dirty.dirty, true);
    assert.ok(dirty.files?.some((line) => line.includes('orphan.txt')));
  });

  test('commitWorktree captures untracked files and checkMerged is true after merge', async () => {
    const taskWt = getWorktreeSlotPath(BOARD_ID, 'task-W1-A', repoDir);

    await fs.writeFile(path.join(taskWt, 'feature.txt'), 'hello\n', 'utf8');

    const commit = await commitWorktree({
      boardId: BOARD_ID,
      slotId: 'task-W1-A',
      message: 'add feature',
    });
    assert.equal(commit.ok, true);
    assert.equal(commit.committed, true);

    const before = await checkMerged({ boardId: BOARD_ID, fromBranch: taskBranch });
    assert.equal(before.ok, true);
    assert.equal(before.merged, false);

    const merged = await mergeIntoIntegration({
      boardId: BOARD_ID,
      fromBranch: taskBranch,
      message: 'merge W1-A',
    });
    assert.equal(merged.ok, true);

    const after = await checkMerged({ boardId: BOARD_ID, fromBranch: taskBranch });
    assert.equal(after.ok, true);
    assert.equal(after.merged, true);
  });

  test('refreshIntegrationDeps attempts node install after package.json merge', async () => {
    const taskWt = getWorktreeSlotPath(BOARD_ID, 'task-W1-A', repoDir);
    const intPath = getWorktreeSlotPath(BOARD_ID, 'integration', repoDir);

    await fs.writeFile(
      path.join(taskWt, 'package.json'),
      JSON.stringify({ name: 'wt-ops-test', version: '1.0.0', dependencies: {} }),
      'utf8',
    );
    await fs.writeFile(
      path.join(taskWt, 'package-lock.json'),
      JSON.stringify({
        name: 'wt-ops-test',
        version: '1.0.0',
        lockfileVersion: 3,
        requires: true,
        packages: { '': { name: 'wt-ops-test', version: '1.0.0' } },
      }),
      'utf8',
    );

    const commit = await commitWorktree({
      boardId: BOARD_ID,
      slotId: 'task-W1-A',
      message: 'add package manifest',
    });
    assert.equal(commit.ok, true);
    assert.equal(commit.committed, true);

    const preMergeSha = (
      await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: intPath, windowsHide: true })
    ).stdout.trim();

    const merged = await mergeIntoIntegration({
      boardId: BOARD_ID,
      fromBranch: taskBranch,
      message: 'merge package manifest',
    });
    assert.equal(merged.ok, true);

    const refreshed = await refreshIntegrationDeps({
      boardId: BOARD_ID,
      sinceSha: preMergeSha,
    });
    assert.equal(refreshed.ok, true);
    const attempted = [...(refreshed.ran ?? []), ...(refreshed.failed ?? [])];
    assert.ok(
      attempted.some((cmd) => /^npm install/.test(cmd)),
      `expected npm install attempt, got ${attempted}`,
    );
  });

  test('integrationStats returns numstat for merged integration branch', async () => {
    const initSha = (
      await execFileAsync('git', ['rev-list', '--max-count=1', '--reverse', 'HEAD'], {
        cwd: repoDir,
        windowsHide: true,
      })
    ).stdout.trim();
    const stats = await integrationStats({
      boardId: BOARD_ID,
      baseRef: initSha,
    });
    assert.equal(stats.ok, true);
    assert.ok((stats.fileCount ?? 0) >= 1);
    assert.ok((stats.additions ?? 0) >= 1);
    assert.equal(stats.hasRemote, false);
  });

  test('commitIntegration stages untracked files in integration worktree', async () => {
    const intPath = getWorktreeSlotPath(BOARD_ID, 'integration', repoDir);
    await fs.writeFile(path.join(intPath, 'dashboard-note.txt'), 'finish\n', 'utf8');

    const commit = await commitIntegration({
      boardId: BOARD_ID,
      message: 'integration finish',
    });
    assert.equal(commit.ok, true);
    assert.equal(commit.committed, true);
  });

  test('pushIntegration soft-fails when no origin remote', async () => {
    const push = await pushIntegration({
      boardId: BOARD_ID,
      branch: integrationBranch,
    });
    assert.equal(push.ok, false);
    assert.equal(push.pushed, false);
    assert.equal(push.error, 'no_remote');
  });

  test('workspaceLandingStats reports incoming integration diff before landing', async () => {
    const stats = await workspaceLandingStats({ branch: integrationBranch });
    assert.equal(stats.ok, true);
    assert.equal(stats.alreadyLanded, false);
    assert.ok((stats.fileCount ?? 0) >= 1);
  });

  test('mergeIntegrationIntoWorkspace lands integration into workspace checkout', async () => {
    const merged = await mergeIntegrationIntoWorkspace({
      branch: integrationBranch,
      message: 'land board',
    });
    assert.equal(merged.ok, true);
    assert.equal(merged.merged, true);

    const stats = await workspaceLandingStats({ branch: integrationBranch });
    assert.equal(stats.ok, true);
    assert.equal(stats.alreadyLanded, true);

    const again = await mergeIntegrationIntoWorkspace({ branch: integrationBranch });
    assert.equal(again.ok, true);
    assert.equal(again.alreadyUpToDate, true);
  });
});

// ── worktree conflict merge ──────────────────────────────────────────────────

describe('worktree conflict merge and verification', () => {
  let repoDir;
  let minnowHome;
  let integrationBranch;
  let branchA;
  let branchB;
  let postMergeASha;
  const BOARD_ID = 'test-board-conflict-22222222';

  async function git(args, cwd = repoDir) {
    return execFileAsync('git', args, { cwd, windowsHide: true });
  }

  async function mergeHeadExists(intPath) {
    try {
      await git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], intPath);
      return true;
    } catch {
      return false;
    }
  }

  async function parentCount(intPath) {
    const { stdout } = await git(['rev-list', '--parents', '-n', '1', 'HEAD'], intPath);
    const parts = stdout.trim().split(/\s+/);
    return parts.length - 1;
  }

  before(async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-wt-conflict-'));
    repoDir = path.join(root, 'repo');
    minnowHome = path.join(root, 'minnow-home');
    await fs.mkdir(repoDir, { recursive: true });
    await fs.mkdir(minnowHome, { recursive: true });
    process.env.MINNOW_HOME = minnowHome;
    await setWorkspaceRoot(repoDir);

    await git(['init']);
    await git(['config', 'user.email', 'test@example.com']);
    await git(['config', 'user.name', 'Test']);
    await fs.writeFile(path.join(repoDir, 'README.md'), '# base\n', 'utf8');
    await fs.writeFile(path.join(repoDir, 'shared.txt'), 'base\n', 'utf8');
    await git(['add', '.']);
    await git(['commit', '-m', 'init']);

    integrationBranch = `minnow/board/${BOARD_ID}/integration`;
    branchA = `minnow/board/${BOARD_ID}/task/W2-A`;
    branchB = `minnow/board/${BOARD_ID}/task/W2-B`;

    assert.equal(
      (await ensureIntegration({ boardId: BOARD_ID, branch: integrationBranch })).ok,
      true,
    );

    const wtA = getWorktreeSlotPath(BOARD_ID, 'task-W2-A', repoDir);
    assert.equal(
      (
        await createWorktree({
          boardId: BOARD_ID,
          slotId: 'task-W2-A',
          branch: branchA,
          baseRef: integrationBranch,
        })
      ).ok,
      true,
    );
    await fs.writeFile(path.join(wtA, 'shared.txt'), 'version A\n', 'utf8');
    await fs.writeFile(path.join(wtA, 'added-by-a.txt'), 'from A\n', 'utf8');
    await git(['add', '.'], wtA);
    await git(['commit', '-m', 'W2-A changes'], wtA);

    const wtB = getWorktreeSlotPath(BOARD_ID, 'task-W2-B', repoDir);
    assert.equal(
      (
        await createWorktree({
          boardId: BOARD_ID,
          slotId: 'task-W2-B',
          branch: branchB,
          baseRef: integrationBranch,
        })
      ).ok,
      true,
    );
    await fs.writeFile(path.join(wtB, 'shared.txt'), 'version B\n', 'utf8');
    await fs.writeFile(path.join(wtB, 'added-by-b.txt'), 'from B\n', 'utf8');
    await fs.rm(path.join(wtB, 'README.md'));
    await git(['add', '-A'], wtB);
    await git(['commit', '-m', 'W2-B changes'], wtB);

    const firstMerge = await mergeIntoIntegration({
      boardId: BOARD_ID,
      fromBranch: branchA,
      message: 'merge W2-A',
    });
    assert.equal(firstMerge.ok, true);
    const intPath = getWorktreeSlotPath(BOARD_ID, 'integration', repoDir);
    postMergeASha = (await git(['rev-parse', 'HEAD'], intPath)).stdout.trim();
  });

  after(async () => {
    delete process.env.MINNOW_HOME;
  });

  test('mergeIntoIntegration leaves integration mid-merge on conflict', async () => {
    const intPath = getWorktreeSlotPath(BOARD_ID, 'integration', repoDir);
    const headBefore = (await git(['rev-parse', 'HEAD'], intPath)).stdout.trim();

    const conflict = await mergeIntoIntegration({
      boardId: BOARD_ID,
      fromBranch: branchB,
      message: 'merge W2-B',
    });

    assert.equal(conflict.ok, false);
    assert.equal(conflict.conflict, true);
    assert.ok(conflict.conflictedFiles?.length > 0);
    assert.ok(conflict.conflictedFiles.includes('shared.txt'));
    assert.equal(conflict.integrationSha, headBefore);
    assert.equal(await mergeHeadExists(intPath), true);
  });

  test('resolve + commit --no-edit yields true merge verified by verifyIntegrationMerge', async () => {
    const intPath = getWorktreeSlotPath(BOARD_ID, 'integration', repoDir);

    await fs.writeFile(path.join(intPath, 'shared.txt'), 'merged AB\n', 'utf8');
    await git(['add', '-A'], intPath);
    await git(['commit', '--no-edit'], intPath);

    assert.equal(await parentCount(intPath), 2);

    const merged = await checkMerged({ boardId: BOARD_ID, fromBranch: branchB });
    assert.equal(merged.ok, true);
    assert.equal(merged.merged, true);

    await fs.access(path.join(intPath, 'added-by-b.txt'));
    await fs.access(path.join(intPath, 'added-by-a.txt'));
    await assert.rejects(() => fs.access(path.join(intPath, 'README.md')));

    const verified = await verifyIntegrationMerge({
      boardId: BOARD_ID,
      fromBranch: branchB,
    });
    assert.equal(verified.ok, true);
    assert.equal(verified.verified, true);
    assert.deepEqual(verified.reasons, []);
  });

  test('fake single-parent merge fails verification; restoreIntegration resets tip', async () => {
    const intPath = getWorktreeSlotPath(BOARD_ID, 'integration', repoDir);

    const reset = await restoreIntegration({ boardId: BOARD_ID, sha: postMergeASha });
    assert.equal(reset.ok, true);

    const conflict = await mergeIntoIntegration({
      boardId: BOARD_ID,
      fromBranch: branchB,
      message: 'merge W2-B again',
    });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.conflict, true);
    const integrationSha = conflict.integrationSha;
    assert.ok(integrationSha);

    // Simulate fixer thrash: abort in-progress merge, then commit resolved text as a
    // normal single-parent commit (the corruption mode that bypasses ancestry).
    await git(['merge', '--abort'], intPath);
    await fs.writeFile(path.join(intPath, 'shared.txt'), 'fake merged\n', 'utf8');
    await fs.writeFile(path.join(intPath, 'added-by-b.txt'), 'from B\n', 'utf8');
    await git(['add', '-A'], intPath);
    await git(['commit', '-m', 'fake merge without MERGE_HEAD'], intPath);

    assert.equal(await parentCount(intPath), 1);

    const merged = await checkMerged({ boardId: BOARD_ID, fromBranch: branchB });
    assert.equal(merged.ok, true);
    assert.equal(merged.merged, false);

    const verified = await verifyIntegrationMerge({
      boardId: BOARD_ID,
      fromBranch: branchB,
    });
    assert.equal(verified.ok, true);
    assert.equal(verified.verified, false);
    assert.ok(verified.reasons?.some((r) => /ancestor/i.test(r)));

    const restored = await restoreIntegration({
      boardId: BOARD_ID,
      sha: integrationSha,
    });
    assert.equal(restored.ok, true);
    assert.equal((await git(['rev-parse', 'HEAD'], intPath)).stdout.trim(), integrationSha);
    assert.equal((await git(['status', '--porcelain'], intPath)).stdout.trim(), '');
    assert.equal(await mergeHeadExists(intPath), false);
  });

  test('removeWorktree reports failure when the directory survives', async () => {
    // A slot that reports removed-but-survived becomes an orphan that a later
    // createWorktree silently reuses — dep links and all. It must not claim ok.
    const boardId = 'test-board-remove-survive';
    const slotId = 'task-W1-A';
    const created = await createWorktree({
      boardId,
      slotId,
      branch: `minnow/board/${boardId}/task/W1-A`,
      baseRef: 'HEAD',
    });
    assert.equal(created.ok, true, created.output);
    const wtPath = created.path;

    // Pin the directory so both `git worktree remove` and `fs.rm` fail.
    const parent = path.dirname(wtPath);
    const cwdBefore = process.cwd();
    if (process.platform === 'win32') {
      process.chdir(wtPath); // Windows refuses to remove a process's cwd.
    } else {
      await fs.chmod(parent, 0o500); // POSIX: no unlink rights in the parent.
    }

    try {
      const res = await removeWorktree({ boardId, slotId });
      assert.equal(res.ok, false);
      assert.match(String(res.error), /survived/);
      await fs.access(wtPath);
    } finally {
      if (process.platform === 'win32') process.chdir(cwdBefore);
      else await fs.chmod(parent, 0o700);
    }

    const cleaned = await removeWorktree({ boardId, slotId });
    assert.equal(cleaned.ok, true, cleaned.error);
    await assert.rejects(() => fs.access(wtPath));
  });

  test('removeWorktreeSlotsBulk unregisters missing slots with one prune', async () => {
    const slots = ['bulk-a', 'bulk-b'];
    for (const slotId of slots) {
      const created = await createWorktree({
        boardId: BOARD_ID,
        slotId,
        branch: `minnow/board/${BOARD_ID}/${slotId}`,
        baseRef: integrationBranch,
      });
      assert.equal(created.ok, true, created.output || created.error);
    }

    const bulk = await removeWorktreeSlotsBulk({ boardId: BOARD_ID, slotIds: slots });
    assert.equal(bulk.ok, true, JSON.stringify(bulk.failedSlots));
    assert.equal(bulk.removed.length, 2);

    const listed = await listWorktrees();
    const text = `${listed.output ?? ''}`;
    for (const slotId of slots) {
      assert.equal(text.includes(`/${slotId}`), false, `git still lists ${slotId}: ${text}`);
      await assert.rejects(() => fs.access(getWorktreeSlotPath(BOARD_ID, slotId, repoDir)));
    }
  });

  test('cleanupBoardWorktrees keeps integration by default and removes all when includeIntegration', async () => {
    const partial = await cleanupBoardWorktrees({ boardId: BOARD_ID });
    assert.equal(partial.ok, true);
    assert.equal(partial.keptIntegration, true);

    const intPath = getWorktreeSlotPath(BOARD_ID, 'integration', repoDir);
    await fs.access(intPath);

    const full = await cleanupBoardWorktrees({
      boardId: BOARD_ID,
      includeIntegration: true,
    });
    assert.equal(full.ok, true);
    assert.ok(full.removed >= 1);
    assert.equal(full.keptIntegration, false);

    await assert.rejects(() => fs.access(intPath));
  });

  test('protected cleanup checks first and preserves untracked and staged work', async () => {
    const boardId = 'protected-cleanup';
    const branch = `minnow/board/${boardId}/task`;
    const created = await createWorktree({ boardId, slotId: 'task', branch, baseRef: 'HEAD' });
    assert.equal(created.ok, true);
    const wtPath = getWorktreeSlotPath(boardId, 'task');
    const file = path.join(wtPath, 'unsaved.txt');
    await fs.writeFile(file, 'keep this work');
    for (const staged of [false, true]) {
      if (staged) await execFileAsync('git', ['add', 'unsaved.txt'], { cwd: wtPath, windowsHide: true });
      const result = await cleanupBoardWorktrees({ boardId, includeIntegration: true, protectDirty: true });
      assert.equal(result.ok, false);
      assert.match(result.error, /Uncommitted work/);
      assert.equal(await fs.readFile(file, 'utf8'), 'keep this work');
    }
    await execFileAsync('git', ['commit', '-m', 'save work'], { cwd: wtPath, windowsHide: true });
    const input = { boardId, includeIntegration: true, protectDirty: true };
    assert.equal((await cleanupBoardWorktrees({ ...input, checkOnly: true })).ok, true);
    await fs.access(wtPath);
    assert.equal((await cleanupBoardWorktrees(input)).ok, true);
    await assert.rejects(() => fs.access(wtPath));
    const branches = await cleanupBoardBranches({ boardId });
    assert.equal(branches.retainedBranches[0].branch, branch);
  });

  test('protected cleanup keeps orphaned files, removes empty leftovers, and continues with live worktrees', async () => {
    const boardId = 'orphan-cleanup';
    const orphan = getWorktreeSlotPath(boardId, 'orphan');
    const empty = getWorktreeSlotPath(boardId, 'empty');
    await fs.mkdir(orphan, { recursive: true });
    await fs.mkdir(empty, { recursive: true });
    await fs.writeFile(path.join(orphan, 'source.ts'), 'unverified work');
    const created = await createWorktree({ boardId, slotId: 'live', branch: `minnow/board/${boardId}/live`, baseRef: 'HEAD' });
    assert.equal(created.ok, true);
    const input = { boardId, includeIntegration: true, protectDirty: true };
    const check = await cleanupBoardWorktrees({ ...input, checkOnly: true });
    assert.equal(check.ok, true);
    assert.equal(check.retainedWorktrees[0].path, orphan);
    await fs.access(empty);
    const result = await cleanupBoardWorktrees(input);
    assert.equal(result.ok, true);
    assert.equal(result.removed, 2);
    assert.equal(result.retainedWorktrees[0].path, orphan);
    assert.equal(await fs.readFile(path.join(orphan, 'source.ts'), 'utf8'), 'unverified work');
    await assert.rejects(() => fs.access(empty));
    await assert.rejects(() => fs.access(getWorktreeSlotPath(boardId, 'live')));
    assert.equal((await cleanupBoardWorktrees(input)).removed, 0);
  });
});

/**
 * MIN-706 / P3-B — rebaseOntoIntegration.
 *
 * Each test gets its own temp repo + MINNOW_HOME so histories do not leak.
 * Workspace root and home cache are process-global; this describe is sequential.
 */

// ── rebaseOntoIntegration ────────────────────────────────────────────────────

describe('rebaseOntoIntegration (MIN-706)', { concurrency: false }, () => {
  let previousHome;

  before(() => {
    previousHome = process.env.MINNOW_HOME;
  });

  after(() => {
    if (previousHome === undefined) delete process.env.MINNOW_HOME;
    else process.env.MINNOW_HOME = previousHome;
    resetMinnowHomeCache();
    resetBoardIntegrationLock();
  });

  /**
   * Throwaway git repo + board integration worktree.
   * @param {string} suffix
   */
  async function makeRepo(suffix) {
    const boardId = `test-board-rebase-${suffix}`;
    resetBoardIntegrationLock();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `minnow-wt-rebase-${suffix}-`));
    const repoDir = path.join(root, 'repo');
    const minnowHome = path.join(root, 'minnow-home');
    await fs.mkdir(repoDir, { recursive: true });
    await fs.mkdir(minnowHome, { recursive: true });
    process.env.MINNOW_HOME = minnowHome;
    resetMinnowHomeCache();
    await setWorkspaceRoot(repoDir);

    const git = async (args, cwd = repoDir) =>
      execFileAsync('git', args, { cwd, windowsHide: true });

    await git(['init']);
    await git(['config', 'user.email', 'test@example.com']);
    await git(['config', 'user.name', 'Test']);
    await fs.writeFile(path.join(repoDir, 'README.md'), '# base\n', 'utf8');
    await fs.writeFile(path.join(repoDir, 'shared.txt'), 'base\n', 'utf8');
    await git(['add', '.']);
    await git(['commit', '-m', 'init']);

    const integrationBranch = `minnow/board/${boardId}/integration`;
    const ensured = await ensureIntegration({ boardId, branch: integrationBranch });
    assert.equal(ensured.ok, true, ensured.output);

    return { boardId, repoDir, integrationBranch, git };
  }

  /**
   * Attach a task slot. When `files` is set, write and commit them in the slot.
   * @param {{ boardId: string, integrationBranch: string, git: Function, repoDir: string }} h
   * @param {string} slotId
   * @param {Record<string, string> | null} [files]
   */
  async function addTask(h, slotId, files = null) {
    const branch = `minnow/board/${h.boardId}/task/${slotId}`;
    const created = await createWorktree({
      boardId: h.boardId,
      slotId,
      branch,
      baseRef: h.integrationBranch,
    });
    assert.equal(created.ok, true, created.output || created.error);
    const wt = getWorktreeSlotPath(h.boardId, slotId, h.repoDir);
    if (files) {
      for (const [name, content] of Object.entries(files)) {
        await fs.writeFile(path.join(wt, name), content, 'utf8');
      }
      await h.git(['add', '-A'], wt);
      await h.git(['commit', '-m', `commit ${slotId}`], wt);
    }
    return { branch, wt };
  }

  /** @param {string} cwd */
  async function headSha(cwd) {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd,
      windowsHide: true,
    });
    return stdout.trim();
  }

  /** @param {string} cwd */
  async function porcelain(cwd) {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
      cwd,
      windowsHide: true,
    });
    return stdout;
  }

  /**
   * Worktree-aware rebase state dirs. Linked worktrees store these under
   * `.git/worktrees/<id>/`, not the checkout root.
   * @param {string} wtPath
   */
  async function rebaseLeftovers(wtPath) {
    async function gitPath(name) {
      const { stdout } = await execFileAsync('git', ['rev-parse', '--git-path', name], {
        cwd: wtPath,
        windowsHide: true,
      });
      const p = stdout.trim();
      return path.isAbsolute(p) ? p : path.resolve(wtPath, p);
    }
    async function exists(abs) {
      try {
        await fs.access(abs);
        return true;
      } catch {
        return false;
      }
    }
    return {
      merge: await exists(await gitPath('rebase-merge')),
      apply: await exists(await gitPath('rebase-apply')),
    };
  }

  /** @param {string} wtPath */
  async function assertNoRebaseState(wtPath) {
    const left = await rebaseLeftovers(wtPath);
    assert.equal(left.merge, false, `${wtPath} left rebase-merge behind`);
    assert.equal(left.apply, false, `${wtPath} left rebase-apply behind`);
  }

  test('clean rebase: a task branch behind integration rebases and reports the new sha', async () => {
    const h = await makeRepo('clean');
    const a = await addTask(h, 'task-A', { 'file-a.txt': 'from A\n' });
    const b = await addTask(h, 'task-B', { 'file-b.txt': 'from B\n' });

    const merged = await mergeIntoIntegration({
      boardId: h.boardId,
      fromBranch: a.branch,
      message: 'merge A',
    });
    assert.equal(merged.ok, true, merged.output);

    const shaBefore = await headSha(b.wt);
    const rebased = await rebaseOntoIntegration({ boardId: h.boardId, slotId: 'task-B' });
    assert.equal(rebased.ok, true, rebased.error);
    assert.ok(rebased.sha);
    assert.notEqual(rebased.sha, shaBefore);
    assert.equal(await headSha(b.wt), rebased.sha);

    await fs.access(path.join(b.wt, 'file-a.txt'));
    await fs.access(path.join(b.wt, 'file-b.txt'));
    await assertNoRebaseState(b.wt);
  });

  test('conflicting rebase reports exact paths, aborts cleanly, and restores porcelain', async () => {
    const h = await makeRepo('conflict');
    const a = await addTask(h, 'task-A', { 'shared.txt': 'version A\n' });
    const b = await addTask(h, 'task-B', { 'shared.txt': 'version B\n' });

    const merged = await mergeIntoIntegration({
      boardId: h.boardId,
      fromBranch: a.branch,
      message: 'merge A',
    });
    assert.equal(merged.ok, true, merged.output);

    const shaBefore = await headSha(b.wt);
    const porcelainBefore = await porcelain(b.wt);

    const rebased = await rebaseOntoIntegration({ boardId: h.boardId, slotId: 'task-B' });
    assert.equal(rebased.ok, false);
    assert.ok(Array.isArray(rebased.conflicts));
    assert.ok(rebased.conflicts.includes('shared.txt'));

    assert.equal(await headSha(b.wt), shaBefore);
    assert.equal(await porcelain(b.wt), porcelainBefore);
    await assertNoRebaseState(b.wt);

    const intPath = getWorktreeSlotPath(h.boardId, 'integration', h.repoDir);
    await assertNoRebaseState(intPath);
  });

  test('already-current branch returns ok with no change', async () => {
    const h = await makeRepo('current');
    const b = await addTask(h, 'task-B', { 'file-b.txt': 'from B\n' });
    const shaBefore = await headSha(b.wt);
    const porcelainBefore = await porcelain(b.wt);

    const rebased = await rebaseOntoIntegration({ boardId: h.boardId, slotId: 'task-B' });
    assert.equal(rebased.ok, true, rebased.error);
    assert.equal(rebased.sha, shaBefore);
    assert.equal(await headSha(b.wt), shaBefore);
    assert.equal(await porcelain(b.wt), porcelainBefore);
    await assertNoRebaseState(b.wt);
  });

  test('empty branch (no commits) returns ok without touching anything', async () => {
    const h = await makeRepo('empty');
    const b = await addTask(h, 'task-B', null);
    const shaBefore = await headSha(b.wt);
    const porcelainBefore = await porcelain(b.wt);
    const reflogBefore = (await h.git(['reflog', '-1'], b.wt)).stdout.trim();

    const rebased = await rebaseOntoIntegration({ boardId: h.boardId, slotId: 'task-B' });
    assert.equal(rebased.ok, true, rebased.error);
    assert.equal(rebased.sha, shaBefore);
    assert.equal(await headSha(b.wt), shaBefore);
    assert.equal(await porcelain(b.wt), porcelainBefore);
    assert.equal((await h.git(['reflog', '-1'], b.wt)).stdout.trim(), reflogBefore);
    await assertNoRebaseState(b.wt);
  });

  test('concurrent rebase and merge against one integration branch serialise', async () => {
    const h = await makeRepo('serial');
    const a = await addTask(h, 'task-A', { 'file-a.txt': 'from A\n' });
    const b = await addTask(h, 'task-B', { 'file-b.txt': 'from B\n' });
    const c = await addTask(h, 'task-C', { 'file-c.txt': 'from C\n' });

    // Advance integration so B is behind (rebase has work) while C can still merge.
    const mergedA = await mergeIntoIntegration({
      boardId: h.boardId,
      fromBranch: a.branch,
      message: 'merge A',
    });
    assert.equal(mergedA.ok, true, mergedA.output);

    resetBoardIntegrationLock();

    const [rebased, mergedC] = await Promise.all([
      rebaseOntoIntegration({ boardId: h.boardId, slotId: 'task-B' }),
      mergeIntoIntegration({
        boardId: h.boardId,
        fromBranch: c.branch,
        message: 'merge C',
      }),
    ]);

    assert.equal(rebased.ok, true, rebased.error);
    assert.equal(mergedC.ok, true, mergedC.output);
    assert.equal(
      peakBoardIntegrationLockDepth(h.boardId),
      1,
      'rebase and merge must not overlap on one board',
    );

    await assertNoRebaseState(b.wt);
    const intPath = getWorktreeSlotPath(h.boardId, 'integration', h.repoDir);
    await assertNoRebaseState(intPath);
    assert.equal((await porcelain(intPath)).trim(), '');
    assert.equal((await porcelain(b.wt)).trim(), '');
  });

  test('failure path never leaves rebase-merge or rebase-apply behind', async () => {
    const h = await makeRepo('leftover');
    const a = await addTask(h, 'task-A', { 'shared.txt': 'version A\n', 'only-a.txt': 'a\n' });
    const b = await addTask(h, 'task-B', { 'shared.txt': 'version B\n', 'only-b.txt': 'b\n' });

    const merged = await mergeIntoIntegration({
      boardId: h.boardId,
      fromBranch: a.branch,
      message: 'merge A',
    });
    assert.equal(merged.ok, true, merged.output);

    const rebased = await rebaseOntoIntegration({ boardId: h.boardId, slotId: 'task-B' });
    assert.equal(rebased.ok, false);
    assert.ok(rebased.conflicts.includes('shared.txt'));

    await assertNoRebaseState(b.wt);
    const intPath = getWorktreeSlotPath(h.boardId, 'integration', h.repoDir);
    await assertNoRebaseState(intPath);

    // Agent-usable: the unique file from B is still there, A's is not mixed in.
    await fs.access(path.join(b.wt, 'only-b.txt'));
    await assert.rejects(() => fs.access(path.join(b.wt, 'only-a.txt')));
  });
});
