import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { Window } from 'happy-dom';
import { installHappyDomGlobals, teardownHappyDomAsync } from '../os/dom-helpers.mts';
import { resetFilePanelStateForTests } from '../../src/state/file-panel.ts';
import { getActiveViewerTab, getViewerTab, openViewerTab, resetViewerTabStoreForTests, snapshotViewerTabEditorContent } from '../../src/ui/file-viewer-tab-store.ts';

mock.module('../../src/ui/file-layout.ts', { namedExports: {
  showViewerSplit() {}, hideViewerSplit() {}, hideViewerPaneDom() {}, isMobileLayout: () => false,
} });
mock.module('../../src/ui/git-commit-diff-panel.ts', { namedExports: { closeGitCommitDiffPanel() {} } });

let win: Window;
beforeEach(() => {
  win = new Window();
  installHappyDomGlobals(win);
  resetFilePanelStateForTests();
  resetViewerTabStoreForTests();
});
afterEach(async () => {
  resetViewerTabStoreForTests();
  resetFilePanelStateForTests();
  await teardownHappyDomAsync(win);
});

test('unstaged review opens the real file tab with full content and an editable diff baseline', async () => {
  const { openGitFileInEditor } = await import('../../src/ui/file-viewer.ts');
  assert.equal(await openGitFileInEditor({ path: 'file.md', staged: false, before: 'old\n', after: 'new\n' }), true);
  const tab = getActiveViewerTab()!;
  assert.equal(tab.path, 'file.md');
  assert.equal(tab.viewMode, 'editor');
  assert.equal(tab.readOnlyExcerpt, false);
  assert.equal(tab.cachedEditorContent, 'new\n');
  assert.deepEqual(tab.gitDiff, { baseline: 'old\n', staged: false });
});

test('opening the workspace diff from Factory preserves the thread copy and its draft', async () => {
  const { setWorkspaceFromServer, resetWorkspaceStateForTests } = await import('../../src/state/workspace.ts');
  const { setFileTreeListingWorkspaceRoot } = await import('../../src/ui/file-tree-listing-root.ts');
  const { openGitFileInEditor } = await import('../../src/ui/file-viewer.ts');
  setWorkspaceFromServer({ path: '/project', label: 'project', isDefault: false });
  setFileTreeListingWorkspaceRoot('/checkouts/factory');
  try {
    await openViewerTab('file.ts', { workspaceRoot: '/checkouts/factory', content: 'thread' });
    snapshotViewerTabEditorContent('file.ts', 'thread draft', true);
    await openViewerTab('second.ts', { workspaceRoot: '/checkouts/factory', content: '' });
    await openGitFileInEditor({ path: 'file.ts', staged: false, before: 'base', after: 'local' });
    assert.equal(getActiveViewerTab()?.workspaceRoot, '/project');
    assert.equal(getActiveViewerTab()?.cachedEditorContent, 'local');
    assert.equal(getViewerTab('file.ts')?.cachedEditorContent, 'thread draft');
  } finally {
    setFileTreeListingWorkspaceRoot(undefined);
    resetWorkspaceStateForTests();
  }
});

test('a dedicated app opens a Factory file in the project window with its original checkout', async () => {
  const sent: unknown[] = [];
  Object.assign(win, { minnow: { viewContext: { appId: 'issues', workspacePath: '/project' },
    window: { sendCodeCommand: async (command: unknown) => { sent.push(command); return { ok: true }; } } } });
  const { openFileInViewer } = await import('../../src/ui/file-viewer.ts');
  await openFileInViewer('file.ts', { workspaceRoot: '/checkouts/factory' });
  assert.deepEqual(sent, [{ kind: 'file', path: 'file.ts', workspacePath: '/project', checkoutPath: '/checkouts/factory' }]);
});

test('staged snapshots remain separate from the working file and cannot save over it', async () => {
  await openViewerTab('file.ts', { content: 'working\n' });
  const { openGitFileInEditor, saveCurrentFile } = await import('../../src/ui/file-viewer.ts');
  await openGitFileInEditor({ path: 'file.ts', cwd: '/worktree', staged: true, before: 'head\n', after: 'index\n' });
  const staged = getActiveViewerTab()!;
  assert.equal(staged.kind, 'attachment');
  assert.equal(staged.readOnlyExcerpt, true);
  assert.equal(staged.cachedEditorContent, 'index\n');
  assert.equal(getViewerTab('file.ts')!.cachedEditorContent, 'working\n');
  assert.equal(await saveCurrentFile(), false);
});

test('an existing unstaged draft survives opening and refreshing its inline review', async () => {
  await openViewerTab('file.ts', { content: 'disk\n' });
  snapshotViewerTabEditorContent('file.ts', 'draft\n', true);
  const { openGitFileInEditor } = await import('../../src/ui/file-viewer.ts');
  await openGitFileInEditor({ path: 'file.ts', staged: false, before: 'base\n', after: 'disk\n' });
  assert.equal(getActiveViewerTab()!.cachedEditorContent, 'draft\n');
  assert.equal(getActiveViewerTab()!.isDirty, true);
  assert.equal(getActiveViewerTab()!.originalContent, 'disk\n');
});
