/**
 * File tree ↔ git panel worktree cwd sync.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';
import { launchInstance, resetInstancesForTests } from '../../src/os/instances.ts';
import {
  panelPathsEqual,
  resolvePanelWorktreeCwd,
  resolvePanelBrowseCwd,
} from '../../src/ui/panel-worktree-cwd.ts';
import {
  buildFileTreeToolContext,
  fileTreeListingRootsEqual,
  resetFileTreeListingRootForTests,
  setFileTreeListingWorkspaceRoot,
} from '../../src/ui/file-tree-listing-root.ts';
import {
  resetFilePanelStateForTests,
  patchFilePanelState,
  getFilePanelState,
} from '../../src/state/file-panel.ts';
import {
  stopFileTreeGitStatusPollForTests,
} from '../../src/ui/file-tree.ts';
import {
  resetWorkspaceStateForTests,
  setWorkspaceFromServer,
} from '../../src/state/workspace.ts';
import { setFileTreeServerAvailable } from '../../src/ui/file-tree-server.ts';
import { shouldScheduleFileTreeRefresh } from '../../src/ui/file-tree-auto-refresh.ts';
import {
  resetSessionPersistenceForTests,
  setSessionStateForTests,
} from '../../src/state/sessions.ts';
import { setStorageModeForTests } from '../../src/config/storage-mode.ts';
import { installHappyDomGlobals, teardownHappyDomAsync } from '../os/dom-helpers.mts';

const MAIN_WS = 'C:/projects/minnow';
const WORKTREE = 'C:/projects/minnow/.minnow/worktrees/task-abc';

/** happy-dom windows keep the event loop alive unless closed. */
let testWindow: Window | null = null;

function setupDom(): void {
  testWindow?.close();
  testWindow = new Window();
  installHappyDomGlobals(testWindow);
  document.body.innerHTML =
    '<div id="fileSidebarTitle">Files</div><div id="fileTreeHost"></div>';
}

beforeEach(() => {
  setStorageModeForTests('localStorage');
  resetInstancesForTests();
});

afterEach(async () => {
  stopFileTreeGitStatusPollForTests();
  if (testWindow) {
    await teardownHappyDomAsync(testWindow);
    testWindow = null;
  }
  setSessionStateForTests(null);
  resetSessionPersistenceForTests();
  resetWorkspaceStateForTests();
  resetFileTreeListingRootForTests();
  resetFilePanelStateForTests();
  setFileTreeServerAvailable(false);
  resetInstancesForTests();
  setStorageModeForTests(null);
});

// ── resolvePanelWorktreeCwd ──────────────────────────────────────────────────

describe('resolvePanelWorktreeCwd', () => {
  test('returns undefined for main workspace path', () => {
    setWorkspaceFromServer({ path: MAIN_WS, label: 'minnow', isDefault: false });
    assert.equal(resolvePanelWorktreeCwd(MAIN_WS), undefined);
    assert.equal(resolvePanelWorktreeCwd(`${MAIN_WS}\\`), undefined);
  });

  test('returns absolute path for isolated worktree', () => {
    setWorkspaceFromServer({ path: MAIN_WS, label: 'minnow', isDefault: false });
    assert.equal(resolvePanelWorktreeCwd(WORKTREE), WORKTREE);
  });

  test('returns undefined when panel cwd is empty', () => {
    setWorkspaceFromServer({ path: MAIN_WS, label: 'minnow', isDefault: false });
    assert.equal(resolvePanelWorktreeCwd(undefined), undefined);
    assert.equal(resolvePanelWorktreeCwd(''), undefined);
  });
});

// ── panelPathsEqual ──────────────────────────────────────────────────────────

describe('panelPathsEqual', () => {
  test('normalizes slashes and trailing separators', () => {
    assert.equal(panelPathsEqual('a/b/', 'a\\b'), true);
  });

  test('treats Windows drive-letter casing as equal', () => {
    assert.equal(
      panelPathsEqual('C:/Users/me/repo', 'c:\\Users\\me\\repo'),
      true,
    );
  });
});

// ── fileTreeListingRootsEqual ────────────────────────────────────────────────

describe('fileTreeListingRootsEqual', () => {
  test('treats undefined and main workspace as equivalent', () => {
    setWorkspaceFromServer({ path: MAIN_WS, label: 'minnow', isDefault: false });
    assert.equal(fileTreeListingRootsEqual(undefined, MAIN_WS), true);
    assert.equal(fileTreeListingRootsEqual(MAIN_WS, undefined), true);
  });

  test('detects different worktree roots', () => {
    setWorkspaceFromServer({ path: MAIN_WS, label: 'minnow', isDefault: false });
    assert.equal(fileTreeListingRootsEqual(undefined, WORKTREE), false);
    assert.equal(fileTreeListingRootsEqual(WORKTREE, WORKTREE), true);
  });
});

// ── buildFileTreeToolContext ─────────────────────────────────────────────────

describe('buildFileTreeToolContext', () => {
  test('includes workspaceRoot when listing a worktree', () => {
    setFileTreeListingWorkspaceRoot(WORKTREE);
    assert.deepEqual(buildFileTreeToolContext(), { workspaceRoot: WORKTREE });
  });

  test('omits workspaceRoot for main workspace listing', () => {
    setFileTreeListingWorkspaceRoot(undefined);
    assert.deepEqual(buildFileTreeToolContext(), {});
  });
});

// ── syncFileTreeToPanelWorktree ──────────────────────────────────────────────

describe('syncFileTreeToPanelWorktree', () => {
  test('resets panel state and listing root when cwd changes', async () => {
    setupDom();
    launchInstance('code');
    setWorkspaceFromServer({ path: MAIN_WS, label: 'minnow', isDefault: false });
    setFileTreeServerAvailable(false);
    patchFilePanelState({
      expandedDirs: ['src'],
      selectedPath: 'src/ui/file-tree.ts',
      openViewerTabs: ['src/ui/file-tree.ts'],
      activeViewerTab: 'src/ui/file-tree.ts',
    });

    const { syncFileTreeToPanelWorktree } = await import('../../src/ui/file-tree.ts');
    await syncFileTreeToPanelWorktree(WORKTREE);

    const state = getFilePanelState();
    assert.deepEqual(state.expandedDirs, []);
    assert.equal(state.selectedPath, null);
    assert.deepEqual(state.openViewerTabs, []);
    assert.equal(state.activeViewerTab, null);
    assert.equal(buildFileTreeToolContext().workspaceRoot, WORKTREE);
    assert.match(
      document.getElementById('fileSidebarTitle')?.textContent ?? '',
      /Files · task-abc/,
    );
  });

  test('no-op panel reset when root unchanged', async () => {
    setupDom();
    launchInstance('code');
    setWorkspaceFromServer({ path: MAIN_WS, label: 'minnow', isDefault: false });
    setFileTreeListingWorkspaceRoot(undefined);
    patchFilePanelState({ expandedDirs: ['docs'], selectedPath: 'docs/readme.md' });

    const { syncFileTreeToPanelWorktree } = await import('../../src/ui/file-tree.ts');
    await syncFileTreeToPanelWorktree(MAIN_WS);

    assert.deepEqual(getFilePanelState().expandedDirs, ['docs']);
    assert.equal(buildFileTreeToolContext().workspaceRoot, undefined);
  });

  test('force refresh preserves expansion when listing root unchanged', async () => {
    setupDom();
    launchInstance('code');
    setWorkspaceFromServer({ path: MAIN_WS, label: 'minnow', isDefault: false });
    setFileTreeListingWorkspaceRoot(undefined);
    patchFilePanelState({ expandedDirs: ['docs'], selectedPath: 'docs/readme.md' });

    const { syncFileTreeToPanelWorktree } = await import('../../src/ui/file-tree.ts');
    await syncFileTreeToPanelWorktree(MAIN_WS, { force: true });

    assert.deepEqual(getFilePanelState().expandedDirs, ['docs']);
    assert.equal(getFilePanelState().selectedPath, 'docs/readme.md');
  });

  test('force refresh keeps preview tabs but preserves file tree state', async () => {
    setupDom();
    launchInstance('code');
    setWorkspaceFromServer({ path: MAIN_WS, label: 'minnow', isDefault: false });
    setFileTreeListingWorkspaceRoot(undefined);
    patchFilePanelState({
      rightPaneMode: 'preview',
      viewerOpen: true,
      previewTabs: [{ id: 'tab-1', source: { kind: 'url', url: 'http://localhost:3000' } }],
      activePreviewTab: 'tab-1',
      expandedDirs: ['docs'],
      selectedPath: 'docs/readme.md',
    });

    const { syncFileTreeToPanelWorktree } = await import('../../src/ui/file-tree.ts');
    await syncFileTreeToPanelWorktree(MAIN_WS, { force: true });

    assert.equal(getFilePanelState().rightPaneMode, 'preview');
    assert.deepEqual(getFilePanelState().previewTabs, [
      { id: 'tab-1', source: { kind: 'url', url: 'http://localhost:3000' } },
    ]);
    assert.equal(getFilePanelState().activePreviewTab, 'tab-1');
    assert.deepEqual(getFilePanelState().expandedDirs, ['docs']);
    assert.equal(getFilePanelState().selectedPath, 'docs/readme.md');
  });

});

// ── file tree tool ───────────────────────────────────────────────────────────

describe('file tree tool context merge', () => {
  test('buildFileTreeToolContext supplies workspaceRoot for listing worktree', () => {
    setFileTreeListingWorkspaceRoot(WORKTREE);
    const merged = { ...buildFileTreeToolContext(), chatId: 'chat-1' };
    assert.deepEqual(merged, { workspaceRoot: WORKTREE, chatId: 'chat-1' });
  });
});

// ── resolvePanelBrowseCwd ────────────────────────────────────────────────────

describe('resolvePanelBrowseCwd', () => {
  test('chat worktreeRoot wins with no integration-worktree lookup', () => {
    setWorkspaceFromServer({ path: MAIN_WS, label: 'minnow', isDefault: false });
    const boardDir = `${MAIN_WS}/.minnow/worktrees/minnow-abc/board-1`;
    const integrationPath = `${boardDir}/integration`;
    const taskPath = `${boardDir}/task-T1`;
    const integrationBranch = 'minnow/board/board-1/integration';
    const group = {
      id: 'board-1',
      name: 'Board',
      workspacePath: MAIN_WS,
      collapsed: false,
      order: 0,
      createdAt: 0,
      viewMode: 'board' as const,
      orchestrateBoard: {
        planPath: 'documentation/plans/p.md',
        maxConcurrentTasks: 3,
        integrationBranch,
        tasks: [
          {
            id: 'T1',
            title: 'Task',
            wave: 1,
            category: 'code' as const,
            status: 'in_progress' as const,
            worktreePath: taskPath,
          },
        ],
        waves: [{ id: 1, status: 'in_progress' as const }],
        startedAt: 0,
        lastUpdatedAt: 0,
      },
    };
    const chat = {
      id: 'task-chat',
      model: 'model',
      history: [],
      boardGroupId: 'board-1',
      boardTaskId: 'T1',
      worktreeRoot: taskPath,
    };
    assert.equal(
      resolvePanelBrowseCwd({
        chat,
        groups: [group],
      }),
      taskPath,
    );
    assert.notEqual(integrationPath, taskPath);
  });

  test('chat view follows active chat worktree', () => {
    setWorkspaceFromServer({ path: MAIN_WS, label: 'minnow', isDefault: false });
    const chat = {
      id: 'chat-1',
      model: 'model',
      history: [],
      worktreeRoot: WORKTREE,
    };
    assert.equal(
      resolvePanelBrowseCwd({ chat, groups: [] }),
      WORKTREE,
    );
  });
});

// ── syncPanelFromActiveChat browse ───────────────────────────────────────────

describe('syncPanelFromActiveChat browse override', () => {
  test('skips sync while browse override is active', async () => {
    setupDom();
    launchInstance('code');
    setWorkspaceFromServer({ path: MAIN_WS, label: 'minnow', isDefault: false });
    const { createEmptyChatObject, setSessionStateForTests } = await import(
      '../../src/state/sessions.ts'
    );
    const gitPanel = await import('../../src/ui/git-panel.ts');
    const chat = createEmptyChatObject('model');
    chat.id = 'chat-override';
    chat.worktreeRoot = WORKTREE;
    setSessionStateForTests({ activeId: chat.id, chats: [chat], groups: [] });

    gitPanel.setGitPanelCwd('C:/projects/other-wt');
    gitPanel.syncPanelFromActiveChat();
    assert.equal(gitPanel.getGitPanelCwd(), 'C:/projects/other-wt');
    gitPanel.resetGitPanelForTests();
  });

  test('syncs chat worktree after override cleared', async () => {
    setupDom();
    launchInstance('code');
    setWorkspaceFromServer({ path: MAIN_WS, label: 'minnow', isDefault: false });
    const { createEmptyChatObject, setSessionStateForTests } = await import(
      '../../src/state/sessions.ts'
    );
    const gitPanel = await import('../../src/ui/git-panel.ts');
    const chat = createEmptyChatObject('model');
    chat.id = 'chat-override';
    chat.worktreeRoot = WORKTREE;
    setSessionStateForTests({ activeId: chat.id, chats: [chat], groups: [] });

    gitPanel.setGitPanelCwd('C:/projects/other-wt');
    gitPanel.clearPanelCwdUserOverride();
    gitPanel.syncPanelFromActiveChat();
    assert.equal(gitPanel.getGitPanelCwd(), WORKTREE);
    gitPanel.resetGitPanelForTests();
  });
});

// ── shouldScheduleFileTreeRefresh ────────────────────────────────────────────

describe('shouldScheduleFileTreeRefresh with worktree listing', () => {
  test('allows refresh when tool and tree share worktree root', () => {
    setFileTreeServerAvailable(true);
    setFileTreeListingWorkspaceRoot(WORKTREE);
    assert.equal(
      shouldScheduleFileTreeRefresh('save_file', { content: 'Wrote file.' }, WORKTREE),
      true,
    );
  });

  test('skips refresh when tree is main but tool wrote to worktree', () => {
    setFileTreeServerAvailable(true);
    setWorkspaceFromServer({ path: MAIN_WS, label: 'minnow', isDefault: false });
    setFileTreeListingWorkspaceRoot(undefined);
    assert.equal(
      shouldScheduleFileTreeRefresh('save_file', { content: 'Wrote file.' }, WORKTREE),
      false,
    );
  });

  test('skips refresh when tree is worktree but tool wrote to main', () => {
    setFileTreeServerAvailable(true);
    setFileTreeListingWorkspaceRoot(WORKTREE);
    assert.equal(
      shouldScheduleFileTreeRefresh('save_file', { content: 'Wrote file.' }, undefined),
      false,
    );
  });
});
