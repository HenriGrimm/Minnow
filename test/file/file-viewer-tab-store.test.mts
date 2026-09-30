import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import { resetFilePanelStateForTests } from '../../src/state/file-panel.ts';
import {
  activateViewerTab,
  clearAllViewerTabs,
  closeViewerTabsUnderAncestor,
  getActiveViewerTabPath,
  getOpenViewerTabPaths,
  getViewerTab,
  isViewerDocDirty,
  markViewerTabSaved,
  normalizeViewerDocText,
  openViewerTab,
  removeViewerTab,
  reorderViewerTab,
  resetViewerTabStoreForTests,
  restoreWorkspaceViewerTabs,
  retargetViewerTab,
  serializeWorkspaceViewerTabs,
  rebaselineViewerTabFromEditor,
  reconcileViewerTabWithDisk,
  setActiveTabLoadState,
  setViewerTabLoadState,
  snapshotViewerTabEditorContent,
} from '../../src/ui/file-viewer-tab-store.ts';

describe('file-viewer-tab-store', () => {
  beforeEach(() => {
    resetViewerTabStoreForTests();
    resetFilePanelStateForTests();
    globalThis.fetch = (async () =>
      ({ ok: true, json: async () => ({}) }) as Response) as typeof fetch;
  });

  test('openTab focuses existing workspace path without duplicate', async () => {
    const first = await openViewerTab('src/a.ts', { skipUnsavedGuard: true });
    assert.ok(first);
    assert.equal(first.focusedExisting, false);
    await openViewerTab('src/b.ts', { skipUnsavedGuard: true });
    const second = await openViewerTab('src/a.ts', { skipUnsavedGuard: true });
    assert.ok(second);
    assert.equal(second.focusedExisting, true);
    assert.equal(getOpenViewerTabPaths().length, 2);
    assert.equal(getActiveViewerTabPath(), 'src/a.ts');
  });

  test('close last tab clears active path', async () => {
    await openViewerTab('readme.md', { skipUnsavedGuard: true });
    removeViewerTab('readme.md');
    assert.equal(getActiveViewerTabPath(), null);
    assert.deepEqual(getOpenViewerTabPaths(), []);
  });

  test('retargetTab updates path key', async () => {
    await openViewerTab('old/name.ts', { skipUnsavedGuard: true });
    retargetViewerTab('old/name.ts', 'new/name.ts');
    assert.deepEqual(getOpenViewerTabPaths(), ['new/name.ts']);
    assert.equal(getActiveViewerTabPath(), 'new/name.ts');
  });

  test('serializeWorkspaceTabs excludes attachments', async () => {
    await openViewerTab('src/index.ts', { skipUnsavedGuard: true });
    await openViewerTab('.minnow/attachments/snap.txt', {
      skipUnsavedGuard: true,
      kind: 'attachment',
      content: 'hi',
    });
    assert.deepEqual(serializeWorkspaceViewerTabs(), ['src/index.ts']);
  });

  test('restoreWorkspaceViewerTabs preserves order and active', () => {
    restoreWorkspaceViewerTabs(['b.ts', 'a.ts', 'c.ts'], 'a.ts');
    assert.deepEqual(getOpenViewerTabPaths(), ['b.ts', 'a.ts', 'c.ts']);
    assert.equal(getActiveViewerTabPath(), 'a.ts');
  });

  test('closeTabsUnderDeletedAncestor removes nested paths', async () => {
    await openViewerTab('pkg/a.ts', { skipUnsavedGuard: true });
    await openViewerTab('pkg/sub/b.ts', { skipUnsavedGuard: true });
    await openViewerTab('other.ts', { skipUnsavedGuard: true });
    closeViewerTabsUnderAncestor('pkg');
    assert.deepEqual(getOpenViewerTabPaths(), ['other.ts']);
  });

  test('activateTab returns false when confirmUnsaved rejects', async () => {
    await openViewerTab('a.ts', { skipUnsavedGuard: true, content: 'x' });
    const tab = await openViewerTab('b.ts', { skipUnsavedGuard: true, content: 'y' });
    assert.ok(tab);
    tab.tab.isDirty = true;
    const ok = await activateViewerTab('a.ts', {
      confirmUnsaved: () => false,
    });
    assert.equal(ok, false);
    assert.equal(getActiveViewerTabPath(), 'b.ts');
  });

  test('clearAllViewerTabs resets store', async () => {
    await openViewerTab('x.ts', { skipUnsavedGuard: true });
    clearAllViewerTabs();
    assert.equal(getActiveViewerTabPath(), null);
  });

  test('reorderViewerTab updates tab order', async () => {
    await openViewerTab('a.ts', { skipUnsavedGuard: true });
    await openViewerTab('b.ts', { skipUnsavedGuard: true });
    reorderViewerTab('a.ts', 1);
    assert.deepEqual(getOpenViewerTabPaths(), ['b.ts', 'a.ts']);
  });

  test('normalizeViewerDocText collapses CRLF and lone CR to LF', () => {
    assert.equal(normalizeViewerDocText('a\r\nb\r\n'), 'a\nb\n');
    assert.equal(normalizeViewerDocText('a\rb\n'), 'a\nb\n');
    assert.equal(normalizeViewerDocText('plain\n'), 'plain\n');
  });

  test('isViewerDocDirty ignores CRLF vs LF-only mismatch', () => {
    assert.equal(isViewerDocDirty('a\nb\n', 'a\r\nb\r\n'), false);
    assert.equal(isViewerDocDirty('a\nx\n', 'a\r\nb\r\n'), true);
  });

  test('openViewerTab normalizes seeded CRLF content for dirty baseline', async () => {
    const opened = await openViewerTab('index.html', {
      skipUnsavedGuard: true,
      content: '<html></html>\r\n',
    });
    assert.ok(opened);
    assert.equal(opened.tab.originalContent, '<html></html>\n');
    assert.equal(opened.tab.isDirty, false);
    assert.equal(isViewerDocDirty('<html></html>\n', opened.tab.originalContent), false);
  });

  test('setActiveTabLoadState normalizes CRLF content', async () => {
    await openViewerTab('index.html', { skipUnsavedGuard: true });
    setActiveTabLoadState('ready', { content: 'hello\r\nworld\r\n' });
    const tab = getViewerTab('index.html');
    assert.ok(tab);
    assert.equal(tab.originalContent, 'hello\nworld\n');
    assert.equal(tab.isDirty, false);
  });

  test('setViewerTabLoadState updates by path even when another tab is active', async () => {
    await openViewerTab('a.html', { skipUnsavedGuard: true });
    await openViewerTab('b.html', { skipUnsavedGuard: true });
    assert.equal(getActiveViewerTabPath(), 'b.html');
    setViewerTabLoadState('a.html', 'ready', { content: '<p>a</p>\r\n' });
    const a = getViewerTab('a.html');
    assert.ok(a);
    assert.equal(a.loadStatus, 'ready');
    assert.equal(a.originalContent, '<p>a</p>\n');
    assert.equal(getViewerTab('b.html')?.loadStatus, 'loading');
  });

  test('rebaselineViewerTabFromEditor clears false dirty against CM doc', async () => {
    await openViewerTab('index.html', {
      skipUnsavedGuard: true,
      content: 'hello\r\n',
    });
    const tab = getViewerTab('index.html');
    assert.ok(tab);
    tab.isDirty = true;
    rebaselineViewerTabFromEditor('index.html', 'hello\n');
    assert.equal(tab.originalContent, 'hello\n');
    assert.equal(tab.isDirty, false);
  });

  test('a save completion preserves edits made while the write was in flight', async () => {
    const opened = await openViewerTab('index.html', { skipUnsavedGuard: true, content: 'base' });
    assert.ok(opened);
    snapshotViewerTabEditorContent('index.html', 'first draft', true);
    const submittedRevision = opened.tab.revision;
    snapshotViewerTabEditorContent('index.html', 'later draft', true);
    assert.equal(markViewerTabSaved(opened.tab, submittedRevision, 'first draft'), false);
    const tab = getViewerTab('index.html');
    assert.equal(tab?.originalContent, 'first draft');
    assert.equal(tab?.cachedEditorContent, 'later draft');
    assert.equal(tab?.isDirty, true);
  });

  test('reconciliation keeps a merge draft against the new disk baseline', async () => {
    const opened = await openViewerTab('index.html', { skipUnsavedGuard: true, content: 'base' });
    assert.ok(opened);
    assert.equal(reconcileViewerTabWithDisk(opened.tab, 'external', 'local plus external'), true);
    const tab = getViewerTab('index.html');
    assert.equal(tab?.originalContent, 'external');
    assert.equal(tab?.cachedEditorContent, 'local plus external');
    assert.equal(tab?.isDirty, true);
  });

  test('late external reconciliation cannot replace a reopened tab', async () => {
    const opened = await openViewerTab('index.html', { skipUnsavedGuard: true, content: 'old' });
    assert.ok(opened);
    removeViewerTab('index.html');
    const reopened = await openViewerTab('index.html', { skipUnsavedGuard: true, content: 'new' });
    assert.ok(reopened);
    assert.equal(reconcileViewerTabWithDisk(opened.tab, 'disk', 'merge'), false);
    assert.equal(reopened.tab.originalContent, 'new');
    assert.equal(reopened.tab.cachedEditorContent, 'new');
  });

  test('pending save preserves a newer draft after switching tabs and reopening', async () => {
    const opened = await openViewerTab('a.ts', { skipUnsavedGuard: true, content: 'original' });
    assert.ok(opened);
    snapshotViewerTabEditorContent('a.ts', 'first edit', true);
    const submittedRevision = opened.tab.revision;
    let resolveSave!: () => void;
    const pendingSave = new Promise<void>((resolve) => { resolveSave = resolve; });
    const save = pendingSave.then(() => markViewerTabSaved(opened.tab, submittedRevision, 'first edit'));

    snapshotViewerTabEditorContent('a.ts', 'newer draft', true);
    await openViewerTab('b.ts', { skipUnsavedGuard: true, content: 'other' });
    resolveSave();
    assert.equal(await save, false);
    await openViewerTab('a.ts', { skipUnsavedGuard: true });
    assert.equal(getViewerTab('a.ts')?.originalContent, 'first edit');
    assert.equal(getViewerTab('a.ts')?.cachedEditorContent, 'newer draft');
    assert.equal(getViewerTab('a.ts')?.isDirty, true);
  });

  test('pending save cannot update a closed tab reopened at the same path', async () => {
    const opened = await openViewerTab('a.ts', { skipUnsavedGuard: true, content: 'original' });
    assert.ok(opened);
    snapshotViewerTabEditorContent('a.ts', 'old draft', true);
    const submittedRevision = opened.tab.revision;
    removeViewerTab('a.ts');
    const reopened = await openViewerTab('a.ts', { skipUnsavedGuard: true, content: 'reopened' });
    assert.ok(reopened);
    assert.equal(markViewerTabSaved(opened.tab, submittedRevision, 'old draft'), false);
    assert.equal(reopened.tab.originalContent, 'reopened');
    assert.equal(reopened.tab.cachedEditorContent, 'reopened');
  });

  test('save completion uses revision even when the draft returns to the submitted text', async () => {
    const opened = await openViewerTab('a.ts', { skipUnsavedGuard: true, content: 'original' });
    assert.ok(opened);
    snapshotViewerTabEditorContent('a.ts', 'first edit', true);
    const submittedRevision = opened.tab.revision;
    snapshotViewerTabEditorContent('a.ts', 'second edit', true);
    snapshotViewerTabEditorContent('a.ts', 'first edit', true);
    assert.equal(markViewerTabSaved(opened.tab, submittedRevision, 'formatted first edit'), false);
    assert.equal(opened.tab.cachedEditorContent, 'first edit');
    assert.equal(opened.tab.originalContent, 'formatted first edit');
    assert.equal(opened.tab.isDirty, true);
  });
});
