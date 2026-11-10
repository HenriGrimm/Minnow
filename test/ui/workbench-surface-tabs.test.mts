import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Window } from 'happy-dom';

test('files and browser pages share the surface strip and keep their content when moved or hidden', async () => {
  const win = new Window({ url: 'http://localhost' });
  Object.assign(globalThis, {
    window: win,
    document: win.document,
    localStorage: win.localStorage,
    HTMLElement: win.HTMLElement,
    HTMLInputElement: win.HTMLInputElement,
    CustomEvent: win.CustomEvent,
    MutationObserver: win.MutationObserver,
    requestAnimationFrame: win.requestAnimationFrame.bind(win),
    cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
  });
  const markup = new win.DOMParser().parseFromString(
    readFileSync(new URL('../../index.html', import.meta.url), 'utf8'), 'text/html',
  );
  const stage = document.importNode(markup.getElementById('workspaceSplit')!, true) as HTMLElement;
  document.body.append(stage);
  const { createEmptyChatObject, setSessionStateForTests } = await import('../../src/state/sessions');
  const chat = createEmptyChatObject('fixture', '/workspace');
  setSessionStateForTests({ version: 6, activeId: chat.id, sidebarCollapsed: false, chats: [chat] });

  const { mountSurfacePanels, registerSurface, openSurface, moveActiveSurface, toggleSurfacePanel } =
    await import('../../src/ui/surfaces/surfaces-column');
  const { createWorkbenchContent } = await import('../../src/ui/surfaces/workbench-content');
  const { getViewerTab, openViewerTab, snapshotViewerTabEditorContent } = await import('../../src/ui/file-viewer-tab-store');
  const { showViewerSplit } = await import('../../src/ui/file-layout');
  const { listPreviewTabs, openPreviewTab } = await import('../../src/ui/preview-tab-store');
  const { resetFilePanelStateForTests } = await import('../../src/state/file-panel');
  const turn = () => new Promise(resolve => setTimeout(resolve, 0));

  try {
    openPreviewTab(null);
    localStorage.setItem(`minnow.graphite.surfaces.v1.thread.${JSON.stringify(['/workspace', chat.id])}`, JSON.stringify({
      open: ['files', 'preview'],
      side: { shown: true, active: 'preview' },
    }));
    registerSurface('files', { render: () => document.getElementById('fileSidebar') });
    mountSurfacePanels(stage, { content: createWorkbenchContent(stage) });
    const side = document.getElementById('surfaceSide')!;
    const bottom = document.getElementById('surfaceBottom')!;
    const selected = (panel: HTMLElement) => panel.querySelector('[role="tab"][aria-selected="true"]')?.textContent;
    const tabs = (panel: HTMLElement) => Array.from(panel.querySelectorAll('[role="tab"]'), node => node.textContent);
    assert.deepEqual(tabs(side), ['Files', 'New browser tab']);
    assert.equal(selected(side), 'New browser tab');
    side.querySelector<HTMLElement>('[aria-label="Close New browser tab"]')!.click();
    await turn();

    await openViewerTab('notes.md', { content: 'saved text', viewMode: 'markdown-preview' });
    showViewerSplit('notes.md');
    await turn();
    assert.deepEqual(tabs(side), ['Files', 'notes.md']);
    assert.equal(selected(side), 'notes.md');
    const viewer = side.querySelector('#fileViewerPane');
    assert.ok(viewer);
    snapshotViewerTabEditorContent('notes.md', 'unsaved text', true);
    await turn();
    assert.equal(side.querySelector('[aria-selected="true"]')?.getAttribute('aria-description'), 'Unsaved changes');

    assert.equal(openSurface('preview', { panel: 'side' }), true);
    await turn();
    assert.deepEqual(tabs(side), ['Files', 'notes.md', 'New browser tab']);
    assert.equal(selected(side), 'New browser tab');
    const preview = side.querySelector('#previewPane');
    assert.ok(preview);
    assert.equal(side.querySelector('.unified-tab-bar'), null);

    moveActiveSurface('side');
    await turn();
    assert.equal(selected(side), 'notes.md');
    assert.equal(selected(bottom), 'New browser tab');
    assert.equal(bottom.querySelector('#previewPane'), preview);
    assert.equal(side.querySelector('#fileViewerPane'), viewer);
    assert.equal(getViewerTab('notes.md')?.cachedEditorContent, 'unsaved text');

    toggleSurfacePanel('bottom');
    toggleSurfacePanel('bottom');
    await turn();
    assert.equal(bottom.querySelector('#previewPane'), preview);
    assert.equal(listPreviewTabs().length, 1);

    bottom.querySelector<HTMLElement>('[aria-label="Close New browser tab"]')!.click();
    await turn();
    assert.equal(listPreviewTabs().length, 0);
    assert.equal(selected(side), 'notes.md');
    assert.equal(document.getElementById('previewPane'), preview);
  } finally {
    resetFilePanelStateForTests();
    setSessionStateForTests(null);
    await win.happyDOM.close();
  }
});
