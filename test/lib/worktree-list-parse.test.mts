import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  filterUserFacingBranches,
  filterUserFacingWorktrees,
  formatWorktreeOptionLabel,
  getPrincipalWorktree,
  isMinnowBoardBranch,
  parseWorktreeListPorcelain,
  worktreePathsEqual,
} from '../../src/lib/worktree-list-parse.ts';

describe('parseWorktreeListPorcelain', () => {
  it('parses multiple worktrees with branches', () => {
    const output = [
      'worktree /repo/main',
      'HEAD abc1111111111111111111111111111111111',
      'branch refs/heads/main',
      '',
      'worktree /repo/task-1',
      'HEAD def2222222222222222222222222222222222',
      'branch refs/heads/feature/task-1',
      '',
      'worktree /repo/detached',
      'HEAD abc1111111111111111111111111111111111',
      'detached',
    ].join('\n');

    const parsed = parseWorktreeListPorcelain(output);
    assert.equal(parsed.length, 3);
    assert.equal(parsed[0]?.path, '/repo/main');
    assert.equal(parsed[0]?.branch, 'main');
    assert.equal(parsed[0]?.detached, false);
    assert.equal(parsed[1]?.branch, 'feature/task-1');
    assert.equal(parsed[2]?.detached, true);
    assert.equal(parsed[2]?.branch, undefined);
  });
});

describe('filterUserFacingBranches', () => {
  it('drops worktree-locked names and keeps unlocked board branches', () => {
    assert.equal(isMinnowBoardBranch('minnow/board/g/task/W1-A'), true);
    const out = filterUserFacingBranches(
      ['main', 'minnow/board/g/integration', 'feature', 'chat-branch'],
      new Set(['chat-branch']),
    );
    assert.deepEqual(out, ['main', 'minnow/board/g/integration', 'feature']);
  });
});

describe('worktreePathsEqual', () => {
  it('treats Windows drive-letter casing as the same path', () => {
    assert.equal(
      worktreePathsEqual('C:/Users/me/repo', 'c:\\Users\\me\\repo'),
      true,
    );
  });
});

describe('formatWorktreeOptionLabel', () => {
  it('labels main workspace and linked worktrees', () => {
    const main = formatWorktreeOptionLabel(
      { path: '/repo/main', head: 'abc', branch: 'main', detached: false },
      '/repo/main',
    );
    assert.equal(main, 'main — workspace');

    const task = formatWorktreeOptionLabel(
      {
        path: '/home/.minnow/worktrees/board/task-1',
        head: 'def',
        branch: 'minnow/board/x/task/y',
        detached: false,
      },
      '/repo/main',
    );
    assert.match(task, /^minnow\/board\/x\/task\/y — task-1$/);
  });

  it('labels the git principal as main worktree when Code workspace is a linked slot', () => {
    const principal = formatWorktreeOptionLabel(
      { path: '/repo/main', head: 'abc', branch: 'master', detached: false },
      '/home/.minnow/worktrees/repo-deadbeef/chat/tool-test-run',
      { principalPath: '/repo/main' },
    );
    assert.equal(principal, 'master — main worktree');

    const workspaceSlot = formatWorktreeOptionLabel(
      {
        path: '/home/.minnow/worktrees/repo-deadbeef/chat/tool-test-run',
        head: 'def',
        branch: 'tool-test-run',
        detached: false,
      },
      '/home/.minnow/worktrees/repo-deadbeef/chat/tool-test-run',
      { principalPath: '/repo/main' },
    );
    assert.equal(workspaceSlot, 'tool-test-run — workspace');
  });

  it('does not repeat a board branch suffix when it is also the worktree folder', () => {
    for (const leaf of ['integration', 'vin-10-expo-app-wave1-W1-D']) {
      const branch = `minnow/board/vin-10-expo-app/${leaf}`;
      assert.equal(formatWorktreeOptionLabel({
        path: `/home/.minnow/worktrees/board/${leaf}`,
        head: 'abc', branch, detached: false,
      }, '/repo/main'), branch);
    }

    assert.equal(formatWorktreeOptionLabel({
      path: '/home/.minnow/worktrees/board/task-1',
      head: 'abc', branch: 'minnow/board/vin-10-expo-app/task/W1-D', detached: false,
    }, '/repo/main'), 'minnow/board/vin-10-expo-app/task/W1-D — task-1');
  });
});

describe('filterUserFacingWorktrees', () => {
  it('keeps git-listed board slots even when the repo-key folder does not match the workspace basename', () => {
    const workspace = '/repo/minnow';
    const worktrees = [
      { path: '/repo/minnow', head: 'abc', branch: 'main', detached: false },
      {
        path: '/home/.minnow/worktrees/Minnow-abcd1234/board-a/task-W1-A',
        head: 'def',
        branch: 'minnow/board/a/task/W1-A',
        detached: false,
      },
      {
        path: '/tmp/user-worktree',
        head: 'jkl',
        branch: 'feature',
        detached: false,
      },
    ];
    const kept = filterUserFacingWorktrees(worktrees, workspace).map((wt) => wt.path);
    assert.deepEqual(kept, [
      '/repo/minnow',
      '/home/.minnow/worktrees/Minnow-abcd1234/board-a/task-W1-A',
      '/tmp/user-worktree',
    ]);
  });

  it('keeps board slots when Code workspace is a linked worktree (Windows-style paths)', () => {
    const principal = 'C:/Users/me/Documents/Development/Minnow';
    const linked = 'C:/Users/me/.cursor/worktrees/tool-test-run-c70b26fa';
    const boardSlot =
      'C:/Users/me/.minnow/worktrees/Minnow-deadbeef/board-a/integration';
    const worktrees = [
      { path: principal, head: 'abc', branch: 'master', detached: false },
      { path: linked, head: 'def', branch: 'tool-test-run', detached: false },
      {
        path: boardSlot,
        head: 'ghi',
        branch: 'minnow/board/a/integration',
        detached: false,
      },
    ];
    const kept = filterUserFacingWorktrees(worktrees, linked).map((wt) => wt.path);
    assert.equal(getPrincipalWorktree(worktrees)?.path, principal);
    assert.deepEqual(kept, [principal, linked, boardSlot]);
  });
});
