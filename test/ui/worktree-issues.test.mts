import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeWorktreeIssue, worktreeKey, worktreeOrigin } from '../../src/lib/worktree-issues.ts';
import { parseWorktreeListPorcelain } from '../../src/lib/worktree-list-parse.ts';

test('worktreeOrigin names the tool that made a worktree from its folder', () => {
  assert.equal(worktreeOrigin('C:/Users/me/.codex/worktrees/d60f/Minnow')?.id, 'codex');
  assert.equal(worktreeOrigin('C:\\Users\\me\\.claude\\worktrees\\x')?.id, 'claude');
  assert.equal(worktreeOrigin('/home/me/.cursor/worktrees/repo/abc')?.id, 'cursor');
  assert.equal(worktreeOrigin('C:/Users/me/.minnow/worktrees/Minnow-5aaf9e8b/chat/bd5c')?.hint, 'Made by Minnow for a chat');
  assert.equal(worktreeOrigin('C:/Users/me/.minnow/worktrees/Minnow-5aaf9e8b/board-1/task-a')?.hint, 'Made by Minnow for a board task');
  assert.equal(worktreeOrigin('/repo/.worktrees/feature'), null);
});

test('worktreeKey matches Windows paths regardless of slashes and case', () => {
  assert.equal(worktreeKey('C:\\Users\\Me\\.codex\\worktrees\\a\\'), worktreeKey('c:/users/me/.codex/worktrees/a'));
  assert.notEqual(worktreeKey('/trees/A'), worktreeKey('/trees/a'));
});

test('porcelain parsing keeps lock reasons and prunable markers', () => {
  const [, locked, bareLock, prunable] = parseWorktreeListPorcelain([
    'worktree /repo', 'HEAD abc', 'branch refs/heads/main', '',
    'worktree /trees/a', 'HEAD abc', 'detached', 'locked initializing', '',
    'worktree /trees/b', 'HEAD abc', 'detached', 'locked', '',
    'worktree /trees/c', 'HEAD abc', 'detached', 'prunable gitdir file points to non-existent location', '',
  ].join('\n'));
  assert.deepEqual([locked.locked, locked.lockReason], [true, 'initializing']);
  assert.deepEqual([bareLock.locked, bareLock.lockReason], [true, undefined]);
  assert.equal(prunable.prunable, true);
  assert.equal(prunable.locked, undefined);
});

test('describeWorktreeIssue turns git refusals into a named fix', () => {
  const codex = 'C:/Users/me/.codex/worktrees/d60f/Minnow';
  const lockedFailure = {
    ok: false,
    code: 'locked',
    lockReason: 'initializing',
    error: "fatal: cannot remove a locked working tree, lock reason: initializing\nuse 'remove -f -f' to override or unlock first",
  };

  const stale = describeWorktreeIssue({ path: codex, missing: true, locked: true, lockReason: 'initializing' });
  assert.equal(stale?.kind, 'stale');
  assert.match(stale!.message, /Folder already deleted\. Codex left Git's record locked \("initializing"\)/);

  const staleFromFailure = describeWorktreeIssue({ path: codex, failure: { ...lockedFailure, missing: true } });
  assert.equal(staleFromFailure?.kind, 'stale');
  assert.match(staleFromFailure!.detail!, /remove -f -f/);

  const locked = describeWorktreeIssue({ path: codex, failure: lockedFailure });
  assert.equal(locked?.kind, 'locked');
  assert.match(locked!.message, /Locked by Codex \("initializing"\)\. Unlock it only if Codex is no longer working in it/);

  const dirty = describeWorktreeIssue({
    path: '/repo/.claude/worktrees/multi',
    failure: { ok: false, code: 'dirty', error: "fatal: '/x' contains modified or untracked files, use --force to delete it" },
  });
  assert.equal(dirty?.kind, 'dirty');

  const failed = describeWorktreeIssue({ path: '/trees/x', failure: { ok: false, error: 'fatal: permission denied\nmore' } });
  assert.deepEqual([failed?.kind, failed?.message], ['failed', 'permission denied']);

  assert.equal(describeWorktreeIssue({ path: codex, locked: true }), null, 'a live locked worktree needs no fix');
  assert.equal(describeWorktreeIssue({ path: codex, failure: { ok: true } }), null);
});
