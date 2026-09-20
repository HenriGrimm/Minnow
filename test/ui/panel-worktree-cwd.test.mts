import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  normalizePanelCwdAfterWorktreeListChange,
  resolveKnownWorktreePath,
  resolvePanelBrowseCwd,
  resolveWorktreeListForRender,
  worktreeOptionsMatch,
} from '../../src/ui/panel-worktree-cwd.ts';
import { setWorkspaceFromServer } from '../../src/state/workspace.ts';
import type { Chat, ChatGroup } from '../../src/types.ts';

const WS = 'C:/repo';
const WT_A = 'C:/repo/.worktrees/feature-a';

describe('panel worktree cwd helpers', () => {
  test('resolveKnownWorktreePath prefers an exact match', () => {
    const worktrees = [
      { path: WS, branch: 'main' },
      { path: WT_A, branch: 'feature-a' },
    ];
    assert.equal(resolveKnownWorktreePath(worktrees, WT_A, WS), WT_A);
  });

  test('resolveKnownWorktreePath falls back to the workspace root', () => {
    const worktrees = [
      { path: WS, branch: 'main' },
      { path: WT_A, branch: 'feature-a' },
    ];
    assert.equal(
      resolveKnownWorktreePath(worktrees, 'C:/repo/.worktrees/removed', WS),
      WS,
    );
  });

  test('normalizePanelCwdAfterWorktreeListChange clears a removed worktree', () => {
    const worktrees = [{ path: WS, branch: 'main' }];
    assert.equal(
      normalizePanelCwdAfterWorktreeListChange(WT_A, worktrees, WS),
      undefined,
    );
  });

  test('normalizePanelCwdAfterWorktreeListChange keeps a still-present worktree', () => {
    const worktrees = [
      { path: WS, branch: 'main' },
      { path: WT_A, branch: 'feature-a' },
    ];
    assert.equal(
      normalizePanelCwdAfterWorktreeListChange(WT_A, worktrees, WS),
      WT_A,
    );
  });
});

describe('panel browse cwd follows the chat worktree, not leftover board state', () => {
  function makePlanner(): Chat {
    return {
      id: 'planner-1',
      name: 'planner',
      workspacePath: WS,
      modelId: 'm1',
      modeId: 'orchestrate',
      boardGroupId: 'grp-1',
      history: [],
      lastStats: null,
      modelInfo: {},
      updatedAt: 1,
    };
  }

  function makeGroup(): ChatGroup {
    return {
      id: 'grp-1',
      name: 'board',
      workspacePath: WS,
      viewMode: 'board',
      plannerChatId: 'planner-1',
      orchestrateBoard: {
        planPath: 'documentation/plans/x.md',
        tasks: [{ id: 't1', worktreePath: WT_A }],
        waves: [],
        startedAt: 1,
        lastUpdatedAt: 1,
        isolationMode: 'per-task',
        integrationBranch: 'minnow/board/grp-1/integration',
      },
    } as unknown as ChatGroup;
  }

  test('planner resolves the workspace when no board group is active', () => {
    setWorkspaceFromServer({ path: WS, label: 'repo', isDefault: false });
    const planner = makePlanner();

    assert.equal(resolvePanelBrowseCwd({ chat: planner, groups: [] }), WS);
  });

  test('planner still resolves the workspace when a leftover board group is present', () => {
    setWorkspaceFromServer({ path: WS, label: 'repo', isDefault: false });
    const planner = makePlanner();
    const group = makeGroup();

    assert.equal(
      resolvePanelBrowseCwd({ chat: planner, groups: [group] }),
      WS,
    );
  });
});

describe('worktree dropdown rendering decisions', () => {
  const real = [
    { path: WS, branch: 'master' },
    { path: WT_A, branch: 'feature-a' },
  ];
  const fallback = { path: WS, branch: undefined };

  test('a failed list keeps the worktrees already on screen', () => {
    assert.deepEqual(
      resolveWorktreeListForRender({ parsed: [], previous: real, fallback }),
      real,
    );
  });

  test('the synthetic workspace row only fills an empty dropdown', () => {
    assert.deepEqual(
      resolveWorktreeListForRender({ parsed: [], previous: [], fallback }),
      [fallback],
    );
    assert.deepEqual(
      resolveWorktreeListForRender({ parsed: [], previous: [], fallback: null }),
      [],
    );
  });

  test('a fresh list always wins', () => {
    assert.deepEqual(
      resolveWorktreeListForRender({ parsed: real, previous: [fallback], fallback }),
      real,
    );
  });

  test('a changed label rebuilds the dropdown even when paths are unchanged', () => {
    const options = [{ value: WS, label: '(unknown) — workspace' }];
    const rows = [{ value: WS, label: 'master — workspace' }];
    assert.equal(worktreeOptionsMatch(options, rows), false);
  });

  test('a path that only differs by separator rebuilds the dropdown', () => {
    const options = [{ value: 'C:\repo', label: 'master — workspace' }];
    const rows = [{ value: 'C:/repo', label: 'master — workspace' }];
    assert.equal(worktreeOptionsMatch(options, rows), false);
  });

  test('identical rows are left alone', () => {
    const rows = [
      { value: WS, label: 'master — workspace' },
      { value: WT_A, label: 'feature-a — feature-a' },
    ];
    assert.equal(worktreeOptionsMatch([...rows], rows), true);
  });
});
