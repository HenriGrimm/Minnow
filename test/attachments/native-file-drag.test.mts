/**
 * Native drag-out session: a tree drag handed to Electron's `startDrag` comes back
 * over Minnow carrying only `Files`, and must still read as a workspace drag.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';

import {
  endNativeWorkspaceDrag,
  getActiveNativeWorkspaceDrag,
  resetNativeFileDragForTests,
  startNativeWorkspaceDrag,
} from '../../src/attachments/native-file-drag.ts';
import {
  classifyFileDrag,
  hasExternalFileDrag,
  readWorkspaceDragPath,
} from '../../src/attachments/external-file-drop.ts';
import {
  capturePayloadFromDataTransfer,
  dataTransferLooksCapturable,
  resetCaptureDragForTests,
} from '../../src/ui/capture-drag.ts';

type StartCall = { root: string; paths: string[] };

let win: Window;
let startCalls: StartCall[];
let startResult: boolean;
let endedListener: (() => void) | null;

function installBridge(platform = 'win32'): void {
  (win as unknown as { minnow: unknown }).minnow = {
    app: { platform, isElectron: true },
    shell: {
      startFileDrag: (root: string, paths: string[]) => {
        startCalls.push({ root, paths });
        return startResult;
      },
      onFileDragEnded: (callback: () => void) => {
        endedListener = callback;
        return () => {
          if (endedListener === callback) endedListener = null;
        };
      },
    },
  };
}

function fileTransfer(fileCount = 1): DataTransfer {
  const items = Array.from({ length: fileCount }, () => ({ kind: 'file', type: '' }));
  return {
    types: ['Files'],
    files: [],
    items,
    dropEffect: 'none',
    getData: () => '',
  } as unknown as DataTransfer;
}

function dragStartEvent(): DragEvent & { prevented: boolean } {
  const event = {
    prevented: false,
    preventDefault() {
      event.prevented = true;
    },
  };
  return event as unknown as DragEvent & { prevented: boolean };
}

function dispatchDrag(target: EventTarget, type: string, dataTransfer: DataTransfer): Event {
  const event = new win.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
  target.dispatchEvent(event as unknown as Event);
  return event as unknown as Event;
}

beforeEach(() => {
  win = new Window();
  const g = globalThis as Record<string, unknown>;
  g.window = win;
  g.document = win.document;
  g.Element = win.Element;
  g.HTMLElement = win.HTMLElement;
  g.HTMLInputElement = win.HTMLInputElement;
  g.HTMLTextAreaElement = win.HTMLTextAreaElement;
  g.Event = win.Event;
  startCalls = [];
  startResult = true;
  endedListener = null;
});

afterEach(() => {
  resetNativeFileDragForTests();
  resetCaptureDragForTests();
  const g = globalThis as Record<string, unknown>;
  delete g.window;
});

describe('startNativeWorkspaceDrag', () => {
  test('leaves the HTML5 drag alone outside Electron', () => {
    const event = dragStartEvent();
    assert.equal(startNativeWorkspaceDrag(event, 'C:\\repo', ['src/a.ts']), false);
    assert.equal(event.prevented, false);
    assert.equal(getActiveNativeWorkspaceDrag(), null);
  });

  test('leaves the HTML5 drag alone when main cannot resolve the paths', () => {
    installBridge();
    startResult = false;
    const event = dragStartEvent();
    assert.equal(startNativeWorkspaceDrag(event, '/repo', ['gone.ts']), false);
    assert.equal(event.prevented, false);
    assert.equal(getActiveNativeWorkspaceDrag(), null);
  });

  test('hands root + paths to the bridge and cancels the HTML5 drag', () => {
    installBridge();
    const event = dragStartEvent();
    assert.equal(startNativeWorkspaceDrag(event, '/repo', ['src']), true);
    assert.equal(event.prevented, true);
    assert.deepEqual(startCalls, [{ root: '/repo', paths: ['src'] }]);
    assert.deepEqual(getActiveNativeWorkspaceDrag(), { paths: ['src'] });
  });
});

describe('native drag coming back over Minnow', () => {
  test('classifies as a workspace drag with the tree path', () => {
    installBridge();
    startNativeWorkspaceDrag(dragStartEvent(), '/repo', ['src/a.ts']);
    const transfer = fileTransfer();
    assert.equal(hasExternalFileDrag(transfer), false);
    assert.equal(classifyFileDrag(transfer), 'workspace');
    assert.equal(readWorkspaceDragPath(transfer), 'src/a.ts');
  });

  test('is capturable as the workspace file', () => {
    installBridge();
    startNativeWorkspaceDrag(dragStartEvent(), '/repo', ['src/a.ts']);
    const transfer = fileTransfer();
    assert.equal(dataTransferLooksCapturable(transfer), true);
    assert.deepEqual(capturePayloadFromDataTransfer(transfer), {
      sourceLabel: 'Workspace file',
      items: [{ kind: 'file', label: 'a.ts', detail: 'src/a.ts', codeRef: { path: 'src/a.ts' } }],
    });
  });

  test('an OS drag with a different file count stays external', () => {
    installBridge();
    startNativeWorkspaceDrag(dragStartEvent(), '/repo', ['src/a.ts']);
    assert.equal(classifyFileDrag(fileTransfer(3)), 'external');
  });

  test('after the session ends, Files drags are external again', () => {
    installBridge();
    let ended = 0;
    startNativeWorkspaceDrag(dragStartEvent(), '/repo', ['src/a.ts'], () => {
      ended += 1;
    });
    endNativeWorkspaceDrag();
    assert.equal(ended, 1);
    assert.equal(classifyFileDrag(fileTransfer()), 'external');
  });
});

describe('session end', () => {
  test('main-process "drag ended" ends the session', () => {
    installBridge('linux');
    let ended = false;
    startNativeWorkspaceDrag(dragStartEvent(), '/repo', ['a.ts'], () => {
      ended = true;
    });
    assert.ok(endedListener);
    endedListener();
    assert.equal(ended, true);
    assert.equal(getActiveNativeWorkspaceDrag(), null);
    assert.equal(endedListener, null);
  });

  test('a new mouse press ends a session macOS never reported', () => {
    installBridge('darwin');
    startNativeWorkspaceDrag(dragStartEvent(), '/repo', ['a.ts']);
    win.dispatchEvent(new win.MouseEvent('mousedown', { buttons: 1 }));
    assert.equal(getActiveNativeWorkspaceDrag(), null);
  });

  test('macOS: pointer moving with no button held ends the session', () => {
    installBridge('darwin');
    startNativeWorkspaceDrag(dragStartEvent(), '/repo', ['a.ts']);
    win.dispatchEvent(new win.MouseEvent('mousemove', { buttons: 1 }));
    assert.ok(getActiveNativeWorkspaceDrag());
    win.dispatchEvent(new win.MouseEvent('mousemove', { buttons: 0 }));
    assert.equal(getActiveNativeWorkspaceDrag(), null);
  });

  test('Windows ignores stray mousemove and relies on IPC', () => {
    installBridge('win32');
    startNativeWorkspaceDrag(dragStartEvent(), '/repo', ['a.ts']);
    win.dispatchEvent(new win.MouseEvent('mousemove', { buttons: 0 }));
    assert.ok(getActiveNativeWorkspaceDrag());
  });
});

describe('unclaimed drop spots', () => {
  test('a plain element refuses the drop instead of letting Chromium open the file', () => {
    installBridge();
    document.body.innerHTML = '<div id="blank"></div>';
    startNativeWorkspaceDrag(dragStartEvent(), '/repo', ['src/a.ts']);
    const transfer = fileTransfer();
    const over = dispatchDrag(document.getElementById('blank')!, 'dragover', transfer);
    assert.equal(over.defaultPrevented, true);
    assert.equal(transfer.dropEffect, 'none');
  });

  test('a text field receives the path, like the HTML5 text/plain drag', () => {
    installBridge();
    document.body.innerHTML = '<textarea id="field"></textarea>';
    const field = document.getElementById('field') as unknown as HTMLTextAreaElement;
    startNativeWorkspaceDrag(dragStartEvent(), '/repo', ['src/a.ts']);
    const transfer = fileTransfer();
    dispatchDrag(field, 'dragover', transfer);
    assert.equal(transfer.dropEffect, 'copy');
    const drop = dispatchDrag(field, 'drop', transfer);
    assert.equal(drop.defaultPrevented, true);
    assert.equal(field.value, 'src/a.ts');
  });

  test('a target that claimed the drop is left alone', () => {
    installBridge();
    document.body.innerHTML = '<textarea id="field"></textarea>';
    const field = document.getElementById('field') as unknown as HTMLTextAreaElement;
    field.addEventListener('drop', (event) => event.preventDefault());
    startNativeWorkspaceDrag(dragStartEvent(), '/repo', ['src/a.ts']);
    dispatchDrag(field, 'drop', fileTransfer());
    assert.equal(field.value, '');
  });
});
