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
