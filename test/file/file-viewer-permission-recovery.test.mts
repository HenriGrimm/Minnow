import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { Window } from 'happy-dom';
import { installHappyDomGlobals, teardownHappyDomAsync } from '../os/dom-helpers.mts';

test('file read permission errors link to the blocked tool without changing permissions', async () => {
  const win = new Window();
  installHappyDomGlobals(win);
  document.body.innerHTML = '<div id="fileViewerHost"></div>';
  let target: unknown[] = [];
  mock.module('../../src/ui/settings-page.ts', {
    namedExports: { navigateToSettingsField: (...args: unknown[]) => { target = args; } },
  });
  try {
    const { setViewerError } = await import('../../src/ui/file-viewer.ts');
    for (const tool of ['get_file_metadata', 'read_file', 'read_file_range']) {
      setViewerError(`tool "${tool}" is disabled in Settings (set permission to Ask or Full to use it).`);
      const buttons = document.querySelectorAll<HTMLButtonElement>('.file-tree-readiness-action');
      assert.equal(buttons.length, 2);
      buttons[0]!.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(target, [`tools.item.${tool}`, 'tools']);
    }
    setViewerError('File does not exist');
    assert.equal(document.querySelector('.file-tree-readiness-action'), null);
  } finally {
    mock.reset();
    await teardownHappyDomAsync(win);
  }
});
