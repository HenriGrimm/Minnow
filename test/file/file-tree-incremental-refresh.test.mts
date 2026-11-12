/**
 * Incremental file tree refresh — targeted invalidation and scroll preservation.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';
import { launchInstance, resetInstancesForTests } from '../../src/os/instances.ts';
import {
  getFilePanelState,
  resetFilePanelStateForTests,
  patchFilePanelState,
} from '../../src/state/file-panel.ts';
import { affectedDirsFromTool } from '../../src/ui/file-tree-invalidation.ts';
import { setFileTreeServerAvailable } from '../../src/ui/file-tree-server.ts';
import { resetWorkspaceStateForTests } from '../../src/state/workspace.ts';
import { installHappyDomGlobals, teardownHappyDomAsync } from '../os/dom-helpers.mts';

let testWindow: Window | null = null;

function setupDom(): void {
  testWindow?.close();
  testWindow = new Window();
  installHappyDomGlobals(testWindow);
  globalThis.CSS = testWindow.CSS;
  document.body.innerHTML =
    '<div id="fileSidebarTitle">Files</div><div id="fileTreeHost" style="height:200px;overflow:auto"></div>';
}

beforeEach(() => {
  resetInstancesForTests();
});

afterEach(async () => {
  const { stopFileTreeGitStatusPollForTests } = await import('../../src/ui/file-tree.ts');
  stopFileTreeGitStatusPollForTests();
  if (testWindow) {
    await teardownHappyDomAsync(testWindow);
    testWindow = null;
  }
  resetWorkspaceStateForTests();
  resetFilePanelStateForTests();
  setFileTreeServerAvailable(false);
  resetInstancesForTests();
});

describe('affectedDirsFromTool', () => {
  test('maps save_file to parent directory', () => {
    assert.deepEqual(affectedDirsFromTool('save_file', { path: 'src/ui/file-tree.ts' }), [
      'src/ui',
    ]);
  });

  test('maps move_file to source and destination parents', () => {
    assert.deepEqual(
      affectedDirsFromTool('move_file', {
        source: 'src/old.ts',
        destination: 'lib/new.ts',
      }),
      ['src', 'lib'],
    );
  });

  test('maps delete_path to parent and prunes expanded dirs', () => {
    patchFilePanelState({ expandedDirs: ['src', 'src/ui', 'docs'] });
    assert.deepEqual(affectedDirsFromTool('delete_path', { path: 'src/ui' }), ['src']);
    assert.deepEqual(getFilePanelState().expandedDirs, ['src', 'docs']);
  });
});

describe('renderFileTree scroll preservation', () => {
  test('restores scrollTop after render', async () => {
    setupDom();
    launchInstance('code');
    setFileTreeServerAvailable(true);
    patchFilePanelState({ treeRoot: '.' });

    const { renderFileTree, seedFileTreeListingForTests } = await import(
      '../../src/ui/file-tree.ts'
    );
    seedFileTreeListingForTests('.', { dirs: ['src'], files: ['README.md'] });

    const host = document.getElementById('fileTreeHost')!;
    host.scrollTop = 120;

    renderFileTree();

    assert.equal(host.scrollTop, 120);
  });
});

test('the visible tree picks up external files without a manual refresh', async (t) => {
  setupDom();
  launchInstance('code');
  setFileTreeServerAvailable(true);
  patchFilePanelState({ treeRoot: '.', expandedDirs: ['src'] });
  const tree = await import('../../src/ui/file-tree.ts');
  tree.seedFileTreeListingForTests('.', { dirs: ['src'], files: ['README.md'] });
  tree.seedFileTreeListingForTests('src', { dirs: [], files: [] });
  const host = document.getElementById('fileTreeHost')!;
  host.checkVisibility = () => true;
  tree.renderFileTree();
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (input, init) => {
    if (!String(input).includes('/api/tools/workspace-files')) return Response.json({ ok: true });
    const { args } = JSON.parse(String(init?.body));
    return Response.json({ result: args.path === '.'
      ? '[dir] src\n[file] README.md\n[file] new.txt'
      : '[file] nested.txt' });
  };
  tree.startFileTreeGitStatusPoll();
  const deadline = Date.now() + 2000;
  while (!host.querySelector('[data-path="src/nested.txt"]') && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(host.querySelector('[data-path="new.txt"]'));
  assert.ok(host.querySelector('[data-path="src/nested.txt"]'));
});
