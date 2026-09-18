/**
 * File-tree context menu includes Copy path and Open in System Explorer.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { setFileTreeServerAvailable } from '../../src/ui/file-tree-server.ts';

const {
  buildFileMenuItems,
  buildFolderMenuItems,
  buildMenuContext,
} = await import('../../src/ui/file-tree-context-menu.ts');
const selection = await import('../../src/ui/file-tree-selection.ts');

describe('file-tree Open in System Explorer', () => {
  afterEach(() => {
    setFileTreeServerAvailable(true);
  });

  test('file menu includes Open in System Explorer when server is up', () => {
    setFileTreeServerAvailable(true);
    const items = buildFileMenuItems(buildMenuContext('src/main.ts', 'file'));
    const reveal = items.find((item) => item.label === 'Open in System Explorer');
    assert.ok(reveal);
    assert.equal(reveal.disabled, false);
    assert.equal(typeof reveal.action, 'function');
  });

  test('folder menu includes Open in System Explorer when server is up', () => {
    setFileTreeServerAvailable(true);
    const items = buildFolderMenuItems(buildMenuContext('src', 'dir'));
    const reveal = items.find((item) => item.label === 'Open in System Explorer');
    assert.ok(reveal);
    assert.equal(reveal.disabled, false);
  });

  test('Open in System Explorer is disabled offline', () => {
    setFileTreeServerAvailable(false);
    const items = buildFileMenuItems(buildMenuContext('README.md', 'file'));
    const reveal = items.find((item) => item.label === 'Open in System Explorer');
    assert.ok(reveal);
    assert.equal(reveal.disabled, true);
    assert.match(reveal.title ?? '', /Open Minnow/i);
  });
});

describe('file-tree Copy path', () => {
  afterEach(() => {
    setFileTreeServerAvailable(true);
  });

  test('file menu includes Copy path', () => {
    const items = buildFileMenuItems(buildMenuContext('src/main.ts', 'file'));
    const copyPath = items.find((item) => item.label === 'Copy path');
    assert.ok(copyPath);
    assert.equal(copyPath.disabled ?? false, false);
    assert.equal(typeof copyPath.action, 'function');
  });

  test('folder menu includes Copy path', () => {
    const items = buildFolderMenuItems(buildMenuContext('src', 'dir'));
    const copyPath = items.find((item) => item.label === 'Copy path');
    assert.ok(copyPath);
    assert.equal(copyPath.disabled ?? false, false);
    assert.equal(typeof copyPath.action, 'function');
  });
});

describe('file-tree context menu with a multi-row selection', () => {
  afterEach(() => {
    selection.resetTreeSelectionForTests();
    setFileTreeServerAvailable(true);
  });

  test('a row inside the selection gets counted batch labels', () => {
    setFileTreeServerAvailable(true);
    selection.replaceTreeSelection([
      { path: 'src/a.ts', kind: 'file' },
      { path: 'src/b.ts', kind: 'file' },
      { path: 'docs', kind: 'dir' },
    ]);

    const labels = buildFileMenuItems(buildMenuContext('src/a.ts', 'file')).map(
      (item) => item.label,
    );
    assert.ok(labels.includes('Delete 3 items'));
    assert.ok(labels.includes('Cut 3 items'));
    assert.ok(labels.includes('Copy 2 files'));
  });

  test('rename is disabled for a multi-row selection', () => {
    setFileTreeServerAvailable(true);
    selection.replaceTreeSelection([
      { path: 'src/a.ts', kind: 'file' },
      { path: 'src/b.ts', kind: 'file' },
    ]);

    const rename = buildFileMenuItems(buildMenuContext('src/a.ts', 'file')).find(
      (item) => item.label === 'Rename…',
    );
    assert.equal(rename.disabled, true);
    assert.match(rename.title ?? '', /one item at a time/i);
  });

  test('a row outside the selection keeps the single-item labels', () => {
    setFileTreeServerAvailable(true);
    selection.replaceTreeSelection([
      { path: 'src/a.ts', kind: 'file' },
      { path: 'src/b.ts', kind: 'file' },
    ]);

    const labels = buildFileMenuItems(buildMenuContext('README.md', 'file')).map(
      (item) => item.label,
    );
    assert.ok(labels.includes('Delete'));
    assert.ok(!labels.some((label) => label.startsWith('Delete ')));
  });

  test('a folder-only selection disables Copy, which is files-only', () => {
    setFileTreeServerAvailable(true);
    selection.replaceTreeSelection([
      { path: 'src', kind: 'dir' },
      { path: 'docs', kind: 'dir' },
    ]);

    const copy = buildFolderMenuItems(buildMenuContext('src', 'dir')).find(
      (item) => item.label === 'Copy',
    );
    assert.equal(copy.disabled, true);
    assert.match(copy.title ?? '', /only available for files/i);
  });
});
