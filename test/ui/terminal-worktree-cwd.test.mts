/**
 * Terminal worktree cwd resolution (MIN-349) — follows file explorer root.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import {
  formatTerminalCwdHeader,
  formatTerminalShellHint,
  formatTerminalTabTitle,
  formatTerminalTabTooltip,
  getTerminalCwdLabelSuffix,
  isTerminalWorktreeCwd,
  resolveFileExplorerTerminalCwd,
  terminalCwdsEqual,
} from '../../src/ui/terminal-worktree-cwd.ts';
import {
  resetFileTreeListingRootForTests,
  setFileTreeListingWorkspaceRoot,
} from '../../src/ui/file-tree-listing-root.ts';
import {
  resetWorkspaceStateForTests,
  setWorkspaceFromServer,
} from '../../src/state/workspace.ts';

const MAIN_WS = 'C:/projects/minnow';
const WORKTREE = 'C:/projects/minnow/.minnow/worktrees/task-abc';

afterEach(() => {
  resetWorkspaceStateForTests();
  resetFileTreeListingRootForTests();
});

describe('resolveFileExplorerTerminalCwd', () => {
  test('prefers file tree listing worktree root', () => {
    setWorkspaceFromServer({ path: MAIN_WS, label: 'minnow', isDefault: false });
    setFileTreeListingWorkspaceRoot(WORKTREE);
    assert.equal(resolveFileExplorerTerminalCwd(), WORKTREE);
  });

  test('falls back to git panel cwd when listing root is unset', async () => {
    setWorkspaceFromServer({ path: MAIN_WS, label: 'minnow', isDefault: false });
    setFileTreeListingWorkspaceRoot(undefined);
    // Patch via module: use listing root unset + simulate panel cwd via direct fn
    const { setGitPanelCwd, getGitPanelCwd } = await import('../../src/ui/git-panel.ts');
    setGitPanelCwd(WORKTREE);
    assert.equal(resolveFileExplorerTerminalCwd(), WORKTREE);
    setGitPanelCwd(undefined);
    assert.equal(getGitPanelCwd(), undefined);
  });

  test('falls back to main workspace when no worktree is selected', () => {
    setWorkspaceFromServer({ path: MAIN_WS, label: 'minnow', isDefault: false });
    setFileTreeListingWorkspaceRoot(undefined);
    const cwd = resolveFileExplorerTerminalCwd();
    assert.equal(cwd, MAIN_WS);
  });
});

describe('terminal cwd labels', () => {
  test('worktree suffix uses basename', () => {
    setWorkspaceFromServer({ path: MAIN_WS, label: 'minnow', isDefault: false });
    assert.equal(getTerminalCwdLabelSuffix(WORKTREE), ' · task-abc');
    assert.equal(getTerminalCwdLabelSuffix(MAIN_WS), '');
    assert.equal(isTerminalWorktreeCwd(WORKTREE), true);
    assert.equal(isTerminalWorktreeCwd(MAIN_WS), false);
  });

  test('header labels worktree distinctly', () => {
    setWorkspaceFromServer({ path: MAIN_WS, label: 'minnow', isDefault: false });
    assert.equal(formatTerminalCwdHeader(WORKTREE), 'task-abc (worktree)');
    assert.equal(formatTerminalCwdHeader(MAIN_WS), 'minnow');
  });

  test('tab titles show workspace vs worktree scope', () => {
    setWorkspaceFromServer({ path: MAIN_WS, label: 'minnow', isDefault: false });
    assert.equal(formatTerminalTabTitle('PowerShell 7', MAIN_WS), 'PowerShell 7 · workspace');
    assert.equal(
      formatTerminalTabTitle('PowerShell 7', WORKTREE),
      'PowerShell 7 · task-abc',
    );
    assert.match(formatTerminalTabTooltip('PowerShell 7', WORKTREE), /task-abc/);
    assert.match(formatTerminalTabTooltip('PowerShell 7', MAIN_WS), /main workspace/);
  });
});

describe('formatTerminalShellHint', () => {
  test('is empty for a plain workspace tab', () => {
    setWorkspaceFromServer({ path: MAIN_WS, label: 'minnow', isDefault: false });
    assert.equal(formatTerminalShellHint(MAIN_WS), '');
  });

  test('mentions worktree path when scoped', () => {
    setWorkspaceFromServer({ path: MAIN_WS, label: 'minnow', isDefault: false });
    const hint = formatTerminalShellHint(WORKTREE);
    assert.match(hint, /file explorer worktree/);
    assert.match(hint, /task-abc/);
  });

  test('prompts for new tab after file root change', () => {
    setWorkspaceFromServer({ path: MAIN_WS, label: 'minnow', isDefault: false });
    const hint = formatTerminalShellHint(WORKTREE, {
      scopeChanged: true,
      activeShellDiffers: true,
    });
    assert.match(hint, /open a new terminal tab/);
    assert.match(hint, /File root changed/);
  });
});

describe('terminalCwdsEqual', () => {
  test('normalizes path separators', () => {
    assert.equal(terminalCwdsEqual('a/b/', 'a\\b'), true);
  });
});
