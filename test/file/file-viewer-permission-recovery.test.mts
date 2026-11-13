import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { installHappyDomGlobals, teardownHappyDomAsync } from '../os/dom-helpers.mts';

test('file access errors offer local retry without changing the agent permission mode', async () => {
  const win = new Window();
  installHappyDomGlobals(win);
  document.body.innerHTML = '<div id="fileViewerHost"></div>';
  try {
    const { setViewerError } = await import('../../src/ui/file-viewer.ts');
    setViewerError('Permission denied while reading the file.');
    const buttons = document.querySelectorAll<HTMLButtonElement>('.file-tree-readiness-action');
    assert.deepEqual(Array.from(buttons, (button) => button.textContent), ['Retry opening file']);
    setViewerError('Reading with read_file needs approval.');
    assert.equal(document.querySelector('.file-tree-readiness-action'), null);
    setViewerError('File does not exist');
    assert.equal(document.querySelector('.file-tree-readiness-action'), null);
  } finally {
    await teardownHappyDomAsync(win);
  }
});
