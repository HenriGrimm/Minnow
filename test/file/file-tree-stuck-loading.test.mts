/**
 * The file tree must never sit on "Loading project…" forever.
 *
 * `renderFileTree` paints that placeholder whenever the root listing is missing,
 * so any render that lands after the last refresh settled used to leave it up
 * permanently — one window showed its files while the other showed the
 * placeholder for the rest of the session. A render with nothing in flight now
 * kicks a refresh instead of just painting the placeholder.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, mock, test } from 'node:test';
import { Window } from 'happy-dom';

import { resetFilePanelStateForTests } from '../../src/state/file-panel.ts';
import { resetWorkspaceStateForTests } from '../../src/state/workspace.ts';
import { setFileTreeServerAvailable } from '../../src/ui/file-tree-server.ts';
import { installHappyDomGlobals, teardownHappyDomAsync } from '../os/dom-helpers.mts';

let testWindow: Window | null = null;
let listCalls = 0;

function setupDom(): void {
  testWindow?.close();
  testWindow = new Window();
  installHappyDomGlobals(testWindow);
  document.body.innerHTML =
    '<div id="fileSidebarTitle">Files</div><div id="fileTreeHost"></div>';
}

/** Stub the tool client so `fetchListing` never touches the network. */
function mockToolClient(result: string): void {
  listCalls = 0;
  mock.module('../../src/tools/client.ts', {
    namedExports: {
      executeTool: async (name: string) => {
        if (name === 'list_directory') listCalls += 1;
        return { content: result };
      },
    },
  });
}

afterEach(async () => {
  const { stopFileTreeGitStatusPollForTests } = await import('../../src/ui/file-tree.ts');
  stopFileTreeGitStatusPollForTests();
  mock.reset();
  if (testWindow) {
    await teardownHappyDomAsync(testWindow);
    testWindow = null;
  }
  resetWorkspaceStateForTests();
  resetFilePanelStateForTests();
  setFileTreeServerAvailable(false);
});

describe('file tree stuck-loading recovery', { concurrency: false }, () => {
  test('a render with an empty cache and nothing in flight kicks a refresh', async () => {
    setupDom();
    mockToolClient('[dir] src\n[file] README.md');
    const { renderFileTree, invalidateFileTreeCache } = await import('../../src/ui/file-tree.ts');
    setFileTreeServerAvailable(true);
    invalidateFileTreeCache();

    renderFileTree();
    assert.equal(
      document.querySelector('.file-tree-loading')?.textContent,
      'Loading project…',
      'the placeholder still shows while the kicked refresh runs',
    );

    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.ok(listCalls >= 1, 'renderFileTree should have kicked a listing');
    assert.match(document.getElementById('fileTreeHost')?.textContent ?? '', /README\.md/);
  });

  test('a failing listing shows an error instead of the placeholder', async () => {
    setupDom();
    mockToolClient('Error: Path "." resolves outside the workspace directory.');
    const { refreshFileTree } = await import('../../src/ui/file-tree.ts');
    setFileTreeServerAvailable(true);

    await refreshFileTree();

    const text = document.getElementById('fileTreeHost')?.textContent ?? '';
    assert.equal(text.includes('Loading project…'), false);
    assert.match(text, /resolves outside the workspace/);
    assert.equal(document.querySelector('.file-tree-readiness-actions'), null);
  });

  test('disabled browsing links to its permission and retries after it is enabled', async () => {
    setupDom();
    let enabled = false;
    let navigated: unknown[] = [];
    mock.module('../../src/tools/client.ts', {
      namedExports: {
        executeTool: async () => ({ content: enabled
          ? '[file] README.md'
          : 'Error: tool "list_directory" is disabled in Settings (set permission to Ask or Full to use it).',
        }),
      },
    });
    mock.module('../../src/ui/settings-page.ts', {
      namedExports: { navigateToSettingsField: (...args: unknown[]) => { navigated = args; } },
    });
    const { refreshFileTree } = await import('../../src/ui/file-tree.ts');
    setFileTreeServerAvailable(true);
    await refreshFileTree();
    const buttons = document.querySelectorAll<HTMLButtonElement>('.file-tree-readiness-action');
    assert.equal(buttons.length, 2);
    buttons[0]!.click();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(navigated, ['tools.item.list_directory', 'tools']);
    enabled = true;
    buttons[1]!.click();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.match(document.getElementById('fileTreeHost')?.textContent ?? '', /README\.md/);
    assert.equal(document.querySelector('.file-tree-readiness-actions'), null);
  });
});
