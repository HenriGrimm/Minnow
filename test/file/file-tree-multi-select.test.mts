/**
 * File tree multi-select — Ctrl/Cmd-click toggles, Shift-click ranges, and the
 * selection survives the tree re-rendering itself.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';
import { launchInstance, resetInstancesForTests } from '../../src/os/instances.ts';
import {
  patchFilePanelState,
  resetFilePanelStateForTests,
} from '../../src/state/file-panel.ts';
import { setFileTreeServerAvailable } from '../../src/ui/file-tree-server.ts';
import { resetWorkspaceStateForTests } from '../../src/state/workspace.ts';
import { dropNestedEntries } from '../../src/ui/file-tree-path.ts';
import {
  applyRowClickSelection,
  clearTreeSelection,
  getSelectedTreePaths,
  isTreePathSelected,
  MULTISELECT_CLASS,
  pruneTreeSelectionToVisibleRows,
  rangeTreeSelection,
  remapTreeSelectionAfterPathChange,
  replaceTreeSelection,
  resetTreeSelectionForTests,
  selectAllVisibleTreeRows,
  selectionForRow,
  setTreeSelectionAnchor,
  treeSelectionCount,
  visibleTreeRowEntries,
} from '../../src/ui/file-tree-selection.ts';
import { installHappyDomGlobals, teardownHappyDomAsync } from '../os/dom-helpers.mts';

let testWindow: Window | null = null;

function setupDom(): void {
  testWindow?.close();
  testWindow = new Window();
  installHappyDomGlobals(testWindow);
  // happy-dom has no CSS.escape; the tree uses it to look rows up by path.
  (globalThis as { CSS?: { escape: (value: string) => string } }).CSS ??= {
    escape: (value: string) => value.replace(/([^\w-])/g, '\\$1'),
  };
  document.body.innerHTML =
    '<div id="fileSidebarTitle">Files</div><div id="fileTreeHost" style="height:200px;overflow:auto"></div>';
}

/** Render a root listing with `src` expanded, so rows nest like the real tree. */
async function renderTree(): Promise<void> {
  const { renderFileTree, seedFileTreeListingForTests } = await import(
    '../../src/ui/file-tree.ts'
  );
  seedFileTreeListingForTests('.', { dirs: ['src'], files: ['README.md', 'package.json'] });
  seedFileTreeListingForTests('src', { dirs: [], files: ['a.ts', 'b.ts', 'c.ts'] });
  patchFilePanelState({ treeRoot: '.', expandedDirs: ['src'] });
  renderFileTree();
}

function rowFor(path: string): HTMLElement {
  const row = document.querySelector<HTMLElement>(
    `.file-tree-row[data-path="${path}"]`,
  );
  assert.ok(row, `expected a rendered row for ${path}`);
  return row;
}

function clickRow(
  path: string,
  modifiers: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean } = {},
): void {
  const win = testWindow!;
  rowFor(path).dispatchEvent(
    new win.MouseEvent('click', { bubbles: true, cancelable: true, ...modifiers }),
  );
}

beforeEach(() => {
  resetInstancesForTests();
  resetTreeSelectionForTests();
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
  resetTreeSelectionForTests();
  setFileTreeServerAvailable(false);
  resetInstancesForTests();
});

describe('applyRowClickSelection', () => {
  test('plain click selects one row and asks the caller to activate it', () => {
    const outcome = applyRowClickSelection('src/a.ts', 'file', {});
    assert.equal(outcome, 'activate');
    assert.deepEqual(getSelectedTreePaths(), ['src/a.ts']);
  });

  test('Ctrl-click adds a row without activating it', () => {
    applyRowClickSelection('src/a.ts', 'file', {});
    const outcome = applyRowClickSelection('src/b.ts', 'file', { ctrlKey: true });
    assert.equal(outcome, 'selection-only');
    assert.deepEqual(getSelectedTreePaths(), ['src/a.ts', 'src/b.ts']);
  });

  test('Cmd-click toggles a selected row back off', () => {
    applyRowClickSelection('src/a.ts', 'file', {});
    applyRowClickSelection('src/b.ts', 'file', { metaKey: true });
    applyRowClickSelection('src/a.ts', 'file', { metaKey: true });
    assert.deepEqual(getSelectedTreePaths(), ['src/b.ts']);
  });

  test('a later plain click collapses the selection back to one row', () => {
    applyRowClickSelection('src/a.ts', 'file', {});
    applyRowClickSelection('src/b.ts', 'file', { ctrlKey: true });
    applyRowClickSelection('README.md', 'file', {});
    assert.deepEqual(getSelectedTreePaths(), ['README.md']);
  });

  test('normalizes backslash paths so a row is never selected twice', () => {
    applyRowClickSelection('src\\a.ts', 'file', {});
    applyRowClickSelection('src/a.ts', 'file', { ctrlKey: true });
    assert.equal(treeSelectionCount(), 0);
  });
});

describe('selectionForRow', () => {
  test('returns the whole selection for a row inside it', () => {
    replaceTreeSelection([
      { path: 'src/a.ts', kind: 'file' },
      { path: 'src/b.ts', kind: 'file' },
    ]);
    assert.deepEqual(
      selectionForRow('src/b.ts', 'file').map((entry) => entry.path),
      ['src/a.ts', 'src/b.ts'],
    );
  });

  test('returns only the row when it is outside the selection', () => {
    replaceTreeSelection([
      { path: 'src/a.ts', kind: 'file' },
      { path: 'src/b.ts', kind: 'file' },
    ]);
    assert.deepEqual(selectionForRow('README.md', 'file'), [
      { path: 'README.md', kind: 'file' },
    ]);
  });
});

describe('Shift-click ranges over the rendered tree', () => {
  test('selects a contiguous range across a folder boundary', async () => {
    setupDom();
    launchInstance('code');
    setFileTreeServerAvailable(true);
    await renderTree();

    assert.deepEqual(
      visibleTreeRowEntries().map((row) => row.path),
      ['src', 'src/a.ts', 'src/b.ts', 'src/c.ts', 'README.md', 'package.json'],
    );

    clickRow('src/a.ts');
    clickRow('README.md', { shiftKey: true });

    assert.deepEqual(getSelectedTreePaths(), [
      'src/a.ts',
      'src/b.ts',
      'src/c.ts',
      'README.md',
    ]);
  });

  test('a backwards range still selects everything between', async () => {
    setupDom();
    launchInstance('code');
    setFileTreeServerAvailable(true);
    await renderTree();

    setTreeSelectionAnchor('src/c.ts');
    const range = rangeTreeSelection('src/c.ts', 'src/a.ts').map((row) => row.path);
    assert.deepEqual(range, ['src/c.ts', 'src/b.ts', 'src/a.ts']);
  });

  test('Ctrl-clicking a folder row selects it instead of expanding it', async () => {
    setupDom();
    launchInstance('code');
    setFileTreeServerAvailable(true);
    await renderTree();

    clickRow('README.md');
    clickRow('src', { ctrlKey: true });

    assert.deepEqual(getSelectedTreePaths(), ['README.md', 'src']);
    // Still expanded: the modifier click must not have toggled the folder.
    assert.equal(rowFor('src').getAttribute('aria-expanded'), 'true');
  });
});

describe('selection is visible to assistive tech', () => {
  test('rows carry aria-selected and the host is multi-selectable', async () => {
    setupDom();
    launchInstance('code');
    setFileTreeServerAvailable(true);
    await renderTree();

    clickRow('src/a.ts');
    clickRow('src/c.ts', { ctrlKey: true });

    const host = document.getElementById('fileTreeHost')!;
    assert.equal(host.getAttribute('aria-multiselectable'), 'true');
    assert.equal(rowFor('src/a.ts').getAttribute('aria-selected'), 'true');
    assert.equal(rowFor('src/b.ts').getAttribute('aria-selected'), 'false');
    assert.equal(rowFor('src/c.ts').getAttribute('aria-selected'), 'true');
    assert.ok(rowFor('src/c.ts').classList.contains(MULTISELECT_CLASS));
    assert.ok(!rowFor('src/b.ts').classList.contains(MULTISELECT_CLASS));
  });

  test('re-rendering repaints the selection onto the new rows', async () => {
    setupDom();
    launchInstance('code');
    setFileTreeServerAvailable(true);
    await renderTree();

    clickRow('src/a.ts');
    clickRow('src/b.ts', { ctrlKey: true });

    const { renderFileTree } = await import('../../src/ui/file-tree.ts');
    renderFileTree();

    assert.deepEqual(getSelectedTreePaths(), ['src/a.ts', 'src/b.ts']);
    assert.ok(rowFor('src/a.ts').classList.contains(MULTISELECT_CLASS));
    assert.equal(rowFor('src/b.ts').getAttribute('aria-selected'), 'true');
  });

  test('Ctrl+A selects every rendered row', async () => {
    setupDom();
    launchInstance('code');
    setFileTreeServerAvailable(true);
    await renderTree();

    selectAllVisibleTreeRows();
    assert.equal(treeSelectionCount(), 6);
  });
});

describe('selection stays truthful as the tree changes', () => {
  test('rows that stopped being rendered leave the selection', async () => {
    setupDom();
    launchInstance('code');
    setFileTreeServerAvailable(true);
    await renderTree();

    clickRow('src/a.ts');
    clickRow('README.md', { ctrlKey: true });

    // Collapse src: its children are gone, README.md is not.
    patchFilePanelState({ expandedDirs: [] });
    const { renderFileTree } = await import('../../src/ui/file-tree.ts');
    renderFileTree();

    pruneTreeSelectionToVisibleRows();
    assert.deepEqual(getSelectedTreePaths(), ['README.md']);
  });

  test('a rename follows the selection to the new path', () => {
    replaceTreeSelection([
      { path: 'src/a.ts', kind: 'file' },
      { path: 'src/nested', kind: 'dir' },
      { path: 'src/nested/deep.ts', kind: 'file' },
    ]);
    remapTreeSelectionAfterPathChange('src/nested', 'lib/nested');
    assert.deepEqual(getSelectedTreePaths(), [
      'src/a.ts',
      'lib/nested',
      'lib/nested/deep.ts',
    ]);
  });

  test('a delete drops the path and everything under it', () => {
    replaceTreeSelection([
      { path: 'src/a.ts', kind: 'file' },
      { path: 'src/nested', kind: 'dir' },
      { path: 'src/nested/deep.ts', kind: 'file' },
    ]);
    remapTreeSelectionAfterPathChange('src/nested', null);
    assert.deepEqual(getSelectedTreePaths(), ['src/a.ts']);
  });

  test('clicking empty tree background clears the selection', async () => {
    setupDom();
    launchInstance('code');
    setFileTreeServerAvailable(true);
    await renderTree();

    const { initFileTreeCrud } = await import('../../src/ui/file-tree.ts');
    initFileTreeCrud();

    clickRow('src/a.ts');
    assert.equal(treeSelectionCount(), 1);

    const host = document.getElementById('fileTreeHost')!;
    host.dispatchEvent(new testWindow!.MouseEvent('click', { bubbles: true }));
    assert.equal(treeSelectionCount(), 0);
  });

  test('clearTreeSelection also drops the shift-click anchor', () => {
    applyRowClickSelection('src/a.ts', 'file', {});
    clearTreeSelection();
    assert.equal(isTreePathSelected('src/a.ts'), false);
    // With no anchor a shift-click behaves like a plain click.
    assert.equal(applyRowClickSelection('src/c.ts', 'file', { shiftKey: true }), 'activate');
  });
});

describe('dropNestedEntries', () => {
  test('drops children of a selected folder', () => {
    assert.deepEqual(
      dropNestedEntries([
        { path: 'src' },
        { path: 'src/a.ts' },
        { path: 'src/deep/b.ts' },
        { path: 'README.md' },
      ]),
      [{ path: 'src' }, { path: 'README.md' }],
    );
  });

  test('keeps siblings and duplicates of the same path', () => {
    assert.deepEqual(
      dropNestedEntries([{ path: 'src/a.ts' }, { path: 'src/b.ts' }]),
      [{ path: 'src/a.ts' }, { path: 'src/b.ts' }],
    );
  });
});
