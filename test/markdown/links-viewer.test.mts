import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { Window } from 'happy-dom';
import { installHappyDomGlobals, teardownHappyDomAsync } from '../os/dom-helpers.mts';
import { resetFilePanelStateForTests } from '../../src/state/file-panel.ts';
import {
  getActiveViewerTab,
  onViewerTabStoreChange,
  openViewerTab,
  resetViewerTabStoreForTests,
  snapshotViewerTabEditorContent,
} from '../../src/ui/file-viewer-tab-store.ts';
import { decorateRenderedMarkdown, resetMarkdownLinkRoutingForTests } from '../../src/markdown/links.ts';

mock.module('../../src/ui/file-layout.ts', { namedExports: {
  showViewerSplit() {}, hideViewerSplit() {}, hideViewerPaneDom() {}, isMobileLayout: () => false,
} });

let win: Window;
beforeEach(async () => {
  win = new Window({ url: 'http://localhost:9473/#/app/code/chat' });
  installHappyDomGlobals(win);
  resetFilePanelStateForTests();
  resetViewerTabStoreForTests();
  resetMarkdownLinkRoutingForTests();
  await import('../../src/ui/file-viewer.ts');
});
afterEach(async () => {
  await teardownHappyDomAsync(win);
  resetMarkdownLinkRoutingForTests();
  resetViewerTabStoreForTests();
  resetFilePanelStateForTests();
});

async function activateReference(markup: string): Promise<void> {
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble msg-bubble--md';
  bubble.innerHTML = markup;
  document.body.appendChild(bubble);
  decorateRenderedMarkdown(bubble);
  let unsubscribe = () => {};
  let timeout: ReturnType<typeof setTimeout>;
  const opened = new Promise<void>((resolve, reject) => {
    timeout = setTimeout(() => reject(new Error('File reference did not open a viewer tab')), 3000);
    unsubscribe = onViewerTabStoreChange(resolve);
  });
  try {
    bubble.querySelector<HTMLAnchorElement>('a')!.click();
    await opened;
    // Let the viewer finish adopting and rendering the opened tab.
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    clearTimeout(timeout!);
    unsubscribe();
  }
  assert.equal(window.location.hash, '#/app/code/chat');
}

for (const [path, reference] of [
  ['docs/README.md', '<code>docs/README.md:1</code>'],
  ['docs/development/agents.md', '<a href="docs/development/agents.md:1-3">Setup</a>'],
  ['README.md', '<a href="README.md#L1-L3">README</a>'],
  ['docs/guide.MARKDOWN', '<code>docs/guide.MARKDOWN:1</code>'],
  ['documentation/plans/build.md', '<code>documentation/plans/build.md:1</code>'],
] as const) {
  test(`${path} reference opens a new tab in Markdown preview`, async () => {
    await activateReference(reference);
    const tab = getActiveViewerTab();
    assert.equal(tab?.path, path);
    assert.equal(tab?.viewMode, 'markdown-preview');
    assert.equal(tab?.pendingInitialLineRange, null);
  });
}

for (const href of ['docs/README.md', 'docs/README.md:1', 'docs/README.md#install']) {
  test(`${href} switches an existing editor to preview and preserves unsaved edits`, async () => {
    const path = 'docs/README.md';
    await openViewerTab(path, { asCode: true, content: '# Install\n\nSaved content' });
    snapshotViewerTabEditorContent(path, '# Install\n\nUnsaved changes', true);
    await activateReference(`<a href="${href}">Read documentation</a>`);
    const tab = getActiveViewerTab();
    assert.equal(tab?.viewMode, 'markdown-preview');
    assert.equal(tab?.cachedEditorContent, '# Install\n\nUnsaved changes');
    assert.equal(tab?.isDirty, true);
  });
}

test('source file references still open the editor at the requested lines', async () => {
  await activateReference('<code>src/main.ts:10-12</code>');
  const tab = getActiveViewerTab();
  assert.equal(tab?.path, 'src/main.ts');
  assert.equal(tab?.viewMode, 'editor');
  assert.deepEqual(tab?.pendingInitialLineRange, { startLine: 10, endLine: 12 });
});
