/**
 * File-tree DnD drop regression — the drop handler must resolve the drag source
 * the same way the drop-target highlight does (the dragstart-captured path), so a
 * drop on a folder moves the file/folder immediately with no confirm dialog.
 *
 * Regression: the highlight (dragover) reads `activeDragSourcePath`, but the drop
 * handler used to resolve the source from the DataTransfer, which is empty at drop
 * time in most browsers — making the drop a silent no-op.
 *
 * Run with --experimental-test-module-mocks (mock.module) via the tsx-mocks-loader.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, mock, test } from 'node:test';
import { Window } from 'happy-dom';

const WORKSPACE_FILE_MIME = 'application/x-minnow-workspace-file';

type MoveCall = { source: string; destination: string; operation: string };
const movePathCalls: MoveCall[] = [];
const statusCalls: Array<[string, string]> = [];

mock.module('../../src/ui/file-tree-ops.ts', {
  namedExports: {
    movePath: async (source: string, destination: string, operation: string) => {
      movePathCalls.push({ source, destination, operation });
      return true;
    },
  },
});

mock.module('../../src/attachments/workspace-ref.ts', {
  namedExports: { WORKSPACE_FILE_MIME },
});

mock.module('../../src/tools/client.ts', {
  namedExports: { getLocalServerAvailable: () => true },
});

mock.module('../../src/ui/file-tree.ts', {
  namedExports: { expandDir: async () => {} },
});

mock.module('../../src/ui/status.ts', {
  namedExports: {
    setStatus: (state: string, msg: string) => {
      statusCalls.push([state, msg]);
    },
  },
});

mock.module('../../src/ui/import-external-files.ts', {
  namedExports: { importDroppedEntriesToWorkspace: async () => {} },
});

mock.module('../../src/attachments/directory-drop.ts', {
  namedExports: {
    collectDroppedTreeEntries: async () => ({ entries: [], error: null }),
  },
});

const dnd = await import('../../src/ui/file-tree-dnd.ts');
const nativeDrag = await import('../../src/attachments/native-file-drag.ts');

let win: Window;

function setupDom(rows: string): void {
  win = new Window();
  globalThis.document = win.document;
  globalThis.HTMLElement = win.HTMLElement;
  document.body.innerHTML = `<div id="fileTreeHost" role="tree">${rows}</div>`;
}

/**
 * A workspace drag whose DataTransfer payload is empty at drop time (the bug):
 * `types` still advertises the workspace MIME (so the drag classifies as a
 * workspace drag and the drop handler runs), but `getData` returns ''.
 */
function makeDataTransfer(path: string, emptyData = false) {
  return {
    types: [WORKSPACE_FILE_MIME, 'text/plain'],
    files: [],
    getData: (type: string) =>
      emptyData ? '' : type === WORKSPACE_FILE_MIME || type === 'text/plain' ? path : '',
    setData: () => {},
    dropEffect: 'move',
    effectAllowed: 'move',
  } as unknown as DataTransfer;
}

function dispatchDrag(type: string, target: Element, dataTransfer?: DataTransfer): void {
  const event = new win.DragEvent(type, { bubbles: true, cancelable: true });
  if (dataTransfer) {
    Object.defineProperty(event, 'dataTransfer', { value: dataTransfer, configurable: true });
  }
  target.dispatchEvent(event);
}

function settle(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const FILE_ROW =
  `<div class="file-tree-row file-tree-row--file" data-path="notes/a.ts" data-entry-kind="file">a.ts</div>`;
const DOCS_ROW =
  `<div class="file-tree-row file-tree-row--dir" data-path="docs" data-entry-kind="dir">docs</div>`;

afterEach(() => {
  movePathCalls.length = 0;
  statusCalls.length = 0;
  dnd.resetFileTreeDnDForTests();
  nativeDrag.resetNativeFileDragForTests();
  delete (globalThis as { window?: unknown }).window;
});

describe('file-tree DnD drop', () => {
  test('a native drag-out dropped back on a folder still moves (not an OS import)', async () => {
    setupDom(`${FILE_ROW}${DOCS_ROW}`);
    (win as unknown as { minnow: unknown }).minnow = {
      app: { platform: 'win32' },
      shell: { startFileDrag: () => true, onFileDragEnded: () => () => {} },
    };
    (globalThis as { window?: unknown }).window = win;
    dnd.initFileTreeDnD();

    const fileRow = document.querySelector('[data-path="notes/a.ts"]')!;
    const docsRow = document.querySelector('[data-path="docs"]')!;
    const nativeTransfer = (): DataTransfer =>
      ({
        types: ['Files'],
        files: [],
        items: [{ kind: 'file', type: '' }],
        getData: () => '',
        dropEffect: 'none',
      }) as unknown as DataTransfer;

    const start = new win.DragEvent('dragstart', { bubbles: true, cancelable: true });
    fileRow.addEventListener('dragstart', (event) => {
      nativeDrag.startNativeWorkspaceDrag(event as unknown as DragEvent, '/repo', ['notes/a.ts']);
    });
    fileRow.dispatchEvent(start);
    assert.equal(start.defaultPrevented, true, 'HTML5 drag handed to the OS');

    const over = nativeTransfer();
    dispatchDrag('dragover', docsRow, over);
    assert.equal(over.dropEffect, 'copy', 'native drags only allow copy | link');
    assert.ok(docsRow.classList.contains('file-tree-row--drop-target'));

    dispatchDrag('drop', docsRow, nativeTransfer());
    await settle();

    assert.deepEqual(movePathCalls, [
      { source: 'notes/a.ts', destination: 'docs/a.ts', operation: 'move' },
    ]);
  });

  test('dropping a file on a folder moves it immediately (no confirm dialog)', async () => {
    setupDom(`${FILE_ROW}${DOCS_ROW}`);
    dnd.initFileTreeDnD();

    const fileRow = document.querySelector('[data-path="notes/a.ts"]')!;
    const docsRow = document.querySelector('[data-path="docs"]')!;

    dispatchDrag('dragstart', fileRow, makeDataTransfer('notes/a.ts', true));
    dispatchDrag('drop', docsRow, makeDataTransfer('notes/a.ts', true));
    await settle();

    assert.deepEqual(
      movePathCalls,
      [{ source: 'notes/a.ts', destination: 'docs/a.ts', operation: 'move' }],
      'drop moves the file into the folder',
    );
    assert.equal(
      document.getElementById('fileTreeMoveConfirm'),
      null,
      'no move-confirm dialog is shown',
    );
  });

  test('dropping a folder on another folder moves it', async () => {
    setupDom(
      `<div class="file-tree-row file-tree-row--dir" data-path="src" data-entry-kind="dir">src</div>` +
        `<div class="file-tree-row file-tree-row--dir" data-path="lib" data-entry-kind="dir">lib</div>`,
    );
    dnd.initFileTreeDnD();

    const srcRow = document.querySelector('[data-path="src"]')!;
    const libRow = document.querySelector('[data-path="lib"]')!;

    dispatchDrag('dragstart', srcRow, makeDataTransfer('src', true));
    dispatchDrag('drop', libRow, makeDataTransfer('src', true));
    await settle();

    assert.deepEqual(
      movePathCalls,
      [{ source: 'src', destination: 'lib/src', operation: 'move' }],
      'drop moves the folder into the other folder',
    );
    assert.equal(
      document.getElementById('fileTreeMoveConfirm'),
      null,
      'no move-confirm dialog is shown',
    );
  });

  test('dropping a folder into its own subfolder is rejected with a status error', async () => {
    setupDom(
      `<div class="file-tree-row file-tree-row--dir" data-path="src" data-entry-kind="dir">src</div>` +
        `<div class="file-tree-row file-tree-row--dir" data-path="src/nested" data-entry-kind="dir">nested</div>`,
    );
    dnd.initFileTreeDnD();

    const srcRow = document.querySelector('[data-path="src"]')!;
    const nestedRow = document.querySelector('[data-path="src/nested"]')!;

    dispatchDrag('dragstart', srcRow, makeDataTransfer('src', true));
    dispatchDrag('drop', nestedRow, makeDataTransfer('src', true));
    await settle();

    assert.equal(movePathCalls.length, 0, 'no move for a folder into its own subfolder');
    assert.ok(
      statusCalls.some(([, msg]) => msg === 'Cannot move a folder into itself or its subfolder.'),
      'cycle-guard status is shown',
    );
  });

  test('dropping on the host background (no folder row) is a no-op', async () => {
    setupDom(`${FILE_ROW}${DOCS_ROW}`);
    dnd.initFileTreeDnD();

    const fileRow = document.querySelector('[data-path="notes/a.ts"]')!;
    const host = document.getElementById('fileTreeHost')!;

    dispatchDrag('dragstart', fileRow, makeDataTransfer('notes/a.ts', true));
    dispatchDrag('drop', host, makeDataTransfer('notes/a.ts', true));
    await settle();

    assert.equal(movePathCalls.length, 0, 'no move when dropping on the host background');
  });

  test('dragend fallback moves the file when the browser never fires drop', async () => {
    setupDom(`${FILE_ROW}${DOCS_ROW}`);
    dnd.initFileTreeDnD();

    const fileRow = document.querySelector('[data-path="notes/a.ts"]')!;
    const docsRow = document.querySelector('[data-path="docs"]')!;

    // The browser never fires `drop` (a `dragleave` cleared the per-element
    // drop-allowed state just before release). Stub elementFromPoint to return
    // the folder row the cursor released over, so the dragend fallback resolves
    // the target and performs the move.
    win.document.elementFromPoint = () => docsRow;

    dispatchDrag('dragstart', fileRow, makeDataTransfer('notes/a.ts', true));
    dispatchDrag('dragend', fileRow, makeDataTransfer('notes/a.ts', true));
    await settle();

    assert.deepEqual(
      movePathCalls,
      [{ source: 'notes/a.ts', destination: 'docs/a.ts', operation: 'move' }],
      'dragend fallback moves the file into the folder under the cursor',
    );
  });

  test('dragend fallback is a no-op when the release point is not a folder', async () => {
    setupDom(`${FILE_ROW}${DOCS_ROW}`);
    dnd.initFileTreeDnD();

    const fileRow = document.querySelector('[data-path="notes/a.ts"]')!;
    const host = document.getElementById('fileTreeHost')!;

    // Release point resolves to the host background (no folder row).
    win.document.elementFromPoint = () => host;

    dispatchDrag('dragstart', fileRow, makeDataTransfer('notes/a.ts', true));
    dispatchDrag('dragend', fileRow, makeDataTransfer('notes/a.ts', true));
    await settle();

    assert.equal(movePathCalls.length, 0, 'no move when the release point is not a folder');
  });
});
