/**
 * Batch file-tree ops — one confirm and one refresh for a whole selection, with
 * children of a selected folder skipped (the folder's own delete took them).
 *
 * Run with --experimental-test-module-mocks (mock.module) via the tsx-mocks-loader.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';

type ToolCall = { name: string; args: Record<string, unknown> };
const toolCalls: ToolCall[] = [];
const statusCalls: Array<[string, string]> = [];
const confirmMessages: string[] = [];
let refreshCount = 0;
let confirmAnswer = true;
let failToolsMatching: ((call: ToolCall) => boolean) | null = null;

mock.module('../../src/ui/app-dialog.ts', {
  namedExports: {
    appAlert: async () => undefined,
    appPrompt: async () => null,
    appConfirm: async (message: string) => {
      confirmMessages.push(message);
      return confirmAnswer;
    },
  },
});

mock.module('../../src/tools/config.ts', {
  namedExports: { isLocalServerAvailable: () => true },
});

mock.module('../../src/tools/client.ts', {
  namedExports: {
    executeTool: async (name: string, args: Record<string, unknown>) => {
      const call = { name, args };
      toolCalls.push(call);
      if (failToolsMatching?.(call)) return { content: 'Error: EPERM: permission denied' };
      return { content: `ok ${name}` };
    },
  },
});

mock.module('../../src/ui/status.ts', {
  namedExports: {
    setStatus: (state: string, message: string) => {
      statusCalls.push([state, message]);
    },
  },
});

mock.module('../../src/ui/file-tree-refresh-bridge.ts', {
  namedExports: {
    refreshFileTreeViaBridge: async () => {
      refreshCount += 1;
    },
    registerFileTreeRefreshBridge: () => undefined,
  },
});

mock.module('../../src/ui/file-viewer-tab-store.ts', {
  namedExports: {
    isViewerTabDirty: () => false,
    listViewerTabs: () => [],
    closeViewerTabsUnderAncestor: () => undefined,
    remapViewerTabsUnderAncestor: () => undefined,
  },
});

mock.module('../../src/state/sessions.ts', {
  namedExports: {
    getActiveChat: () => null,
    scheduleSaveSessions: () => undefined,
  },
});

mock.module('../../src/ui/file-tree-listing-root.ts', {
  namedExports: { buildFileTreeToolContext: () => ({}) },
});

const ops = await import('../../src/ui/file-tree-ops.ts');
const selection = await import('../../src/ui/file-tree-selection.ts');

function pathsFor(toolName: string): string[] {
  return toolCalls
    .filter((call) => call.name === toolName)
    .map((call) => String(call.args.path ?? call.args.source ?? ''));
}

beforeEach(() => {
  toolCalls.length = 0;
  statusCalls.length = 0;
  confirmMessages.length = 0;
  refreshCount = 0;
  confirmAnswer = true;
  failToolsMatching = null;
  selection.resetTreeSelectionForTests();
});

afterEach(() => {
  ops.clearFileTreeClipboard();
});

describe('deletePaths', () => {
  test('asks once for the whole selection and refreshes once', async () => {
    const deleted = await ops.deletePaths([
      { path: 'src/a.ts', kind: 'file' },
      { path: 'src/b.ts', kind: 'file' },
      { path: 'docs', kind: 'dir' },
    ]);

    assert.equal(deleted, 3);
    assert.equal(confirmMessages.length, 1);
    assert.match(confirmMessages[0]!, /2 files and 1 folder/);
    assert.deepEqual(pathsFor('delete_path'), ['src/a.ts', 'src/b.ts', 'docs']);
    assert.equal(refreshCount, 1);
    assert.deepEqual(statusCalls.at(-1), ['ok', 'Deleted 3 items']);
  });

  test('skips children of a selected folder', async () => {
    const deleted = await ops.deletePaths([
      { path: 'src', kind: 'dir' },
      { path: 'src/a.ts', kind: 'file' },
      { path: 'README.md', kind: 'file' },
    ]);

    assert.equal(deleted, 2);
    assert.deepEqual(pathsFor('delete_path'), ['src', 'README.md']);
  });

  test('a declined confirm deletes nothing', async () => {
    confirmAnswer = false;
    const deleted = await ops.deletePaths([
      { path: 'src/a.ts', kind: 'file' },
      { path: 'src/b.ts', kind: 'file' },
    ]);

    assert.equal(deleted, 0);
    assert.deepEqual(toolCalls, []);
    assert.equal(refreshCount, 0);
  });

  test('a failure mid-batch still deletes the rest and reports the count', async () => {
    failToolsMatching = (call) => call.args.path === 'src/b.ts';
    const deleted = await ops.deletePaths([
      { path: 'src/a.ts', kind: 'file' },
      { path: 'src/b.ts', kind: 'file' },
      { path: 'src/c.ts', kind: 'file' },
    ]);

    assert.equal(deleted, 2);
    assert.deepEqual(pathsFor('delete_path'), ['src/a.ts', 'src/b.ts', 'src/c.ts']);
    assert.deepEqual(statusCalls.at(-1), ['err', 'Deleted 2 of 3 — 1 failed.']);
  });

  test('clears the tree selection so no batch op targets deleted rows', async () => {
    selection.replaceTreeSelection([
      { path: 'src/a.ts', kind: 'file' },
      { path: 'src/b.ts', kind: 'file' },
    ]);
    await ops.deletePaths(selection.getTreeSelection());
    assert.equal(selection.treeSelectionCount(), 0);
  });

  test('a single-item selection keeps the plain per-file confirm', async () => {
    await ops.deletePaths([{ path: 'src/a.ts', kind: 'file' }]);
    assert.deepEqual(confirmMessages, ['Delete "a.ts"?']);
  });
});

describe('movePaths', () => {
  test('moves every source into the destination folder in one refresh', async () => {
    const moved = await ops.movePaths(['src/a.ts', 'src/b.ts'], 'lib');

    assert.equal(moved, 2);
    assert.deepEqual(
      toolCalls.map((call) => [call.args.source, call.args.destination]),
      [
        ['src/a.ts', 'lib/a.ts'],
        ['src/b.ts', 'lib/b.ts'],
      ],
    );
    assert.equal(refreshCount, 1);
    assert.deepEqual(statusCalls.at(-1), ['ok', 'Moved 2 items']);
  });

  test('skips sources already in the destination and folders containing it', async () => {
    const moved = await ops.movePaths(['lib/a.ts', 'lib', 'src/b.ts'], 'lib');

    assert.equal(moved, 1);
    assert.deepEqual(pathsFor('move_file'), ['src/b.ts']);
  });

  test('nothing movable is a quiet no-op, not an error', async () => {
    const moved = await ops.movePaths(['lib/a.ts'], 'lib');

    assert.equal(moved, 0);
    assert.deepEqual(toolCalls, []);
    assert.equal(statusCalls.at(-1)?.[0], 'idle');
  });
});

describe('pasteInto', () => {
  test('a multi-path cut moves every item and empties the clipboard', async () => {
    ops.cutPathsToClipboard(['src/a.ts', 'src/b.ts']);
    const ok = await ops.pasteInto('lib');

    assert.equal(ok, true);
    assert.deepEqual(
      toolCalls.map((call) => [call.name, call.args.source, call.args.destination]),
      [
        ['move_file', 'src/a.ts', 'lib/a.ts'],
        ['move_file', 'src/b.ts', 'lib/b.ts'],
      ],
    );
    assert.equal(ops.getFileTreeClipboard(), null);
    assert.equal(refreshCount, 1);
  });

  test('a multi-path copy copies every item and keeps the clipboard', async () => {
    ops.copyPathsToClipboard(['src/a.ts', 'src/b.ts']);
    const ok = await ops.pasteInto('lib');

    assert.equal(ok, true);
    assert.deepEqual(pathsFor('copy_file'), ['src/a.ts', 'src/b.ts']);
    assert.equal(ops.getFileTreeClipboard()?.paths.length, 2);
  });

  test('every item failing reports failure and keeps a cut clipboard', async () => {
    failToolsMatching = () => true;
    ops.cutPathsToClipboard(['src/a.ts', 'src/b.ts']);
    const ok = await ops.pasteInto('lib');

    assert.equal(ok, false);
    assert.equal(refreshCount, 0);
    assert.equal(ops.getFileTreeClipboard()?.mode, 'cut');
  });
});
