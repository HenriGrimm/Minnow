import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { Window } from 'happy-dom';
import { installHappyDomGlobals, teardownHappyDomAsync } from '../os/dom-helpers.mts';
import { setFilterQueryValue } from '../../src/ui/file-tree-filter.ts';
import { setFileTreeServerAvailable } from '../../src/ui/file-tree-server.ts';

test('search results open matching lines with mouse and keyboard; name-only results open normally', async () => {
  const win = new Window();
  installHappyDomGlobals(win);
  document.body.innerHTML = '<div id="fileTreeHost"></div>';
  const opened: unknown[][] = [];
  mock.module('../../src/ui/file-viewer.ts', {
    namedExports: { openFileInViewer: (...args: unknown[]) => { opened.push(args); } },
  });
  mock.module('../../src/tools/client.ts', {
    namedExports: { executeTool: async () => ({ content: 'src/app.ts:12:needle\nnotes.md:4:needle' }) },
  });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ files: ['src/app.ts', 'notes.md', 'needle.txt'] });
  const tree = await import('../../src/ui/file-tree.ts');
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
  try {
    setFileTreeServerAvailable(true);
    setFilterQueryValue('needle');
    tree.renderFileTree();
    for (let i = 0; i < 100 && !document.querySelector('.file-tree-content-preview'); i++) await settle();
    const code = document.querySelector<HTMLElement>('[data-path="src/app.ts"]');
    const markdown = document.querySelector<HTMLElement>('[data-path="notes.md"]');
    const nameOnly = document.querySelector<HTMLElement>('[data-path="needle.txt"]');
    assert.ok(code);
    assert.ok(markdown);
    assert.ok(nameOnly);
    code.click();
    markdown.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    code.dispatchEvent(new win.KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    nameOnly.click();
    for (let i = 0; i < 100 && opened.length < 4; i++) await settle();
    assert.deepEqual(opened, [
      ['src/app.ts', { asCode: true, initialLineRange: { startLine: 12, endLine: 12 } }],
      ['notes.md', { asCode: true, initialLineRange: { startLine: 4, endLine: 4 } }],
      ['src/app.ts', { asCode: true, initialLineRange: { startLine: 12, endLine: 12 } }],
      ['needle.txt', undefined],
    ]);
    code.dispatchEvent(new win.MouseEvent('click', { ctrlKey: true, bubbles: true }));
    await settle();
    assert.equal(opened.length, 4, 'multi-selection must not navigate');
  } finally {
    setFilterQueryValue('');
    setFileTreeServerAvailable(false);
    tree.stopFileTreeGitStatusPollForTests();
    globalThis.fetch = previousFetch;
    mock.reset();
    await teardownHappyDomAsync(win);
  }
});
