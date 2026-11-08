/**
 * Editor selection drag payload and composer drop wiring.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { Window } from 'happy-dom';
import {
  CODE_SELECTION_MIME,
  parseCodeSelectionDragData,
  setCodeSelectionDragData,
} from '../../src/attachments/code-selection-drag.ts';
import { clearAttachments, getPendingAttachments } from '../../src/attachments/store.ts';
import { initComposerDrop } from '../../src/ui/composer-drop.ts';

function setupComposerDom(): void {
  const window = new Window();
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.HTMLTextAreaElement = window.HTMLTextAreaElement;
  globalThis.window = window as unknown as Window & typeof globalThis.window;
  globalThis.DragEvent = window.DragEvent;

  const input = document.createElement('textarea');
  input.id = 'msgInput';
  document.body.appendChild(input);

  const preview = document.createElement('div');
  preview.id = 'attachPreview';
  preview.className = 'hidden';
  document.body.appendChild(preview);

  const inputBar = document.createElement('div');
  inputBar.className = 'input-bar';
  const composer = document.createElement('div');
  composer.className = 'input-bar-composer';
  composer.appendChild(input);
  inputBar.appendChild(composer);
  document.body.appendChild(inputBar);
}

describe('code selection drag payload', () => {
  it('round-trips path and line range', () => {
    const transfer = {
      _data: {} as Record<string, string>,
      setData(type: string, value: string) {
        this._data[type] = value;
      },
      getData(type: string) {
        return this._data[type] ?? '';
      },
    } as DataTransfer;

    setCodeSelectionDragData(transfer, {
      workspacePath: 'src/app.ts',
      startLine: 4,
      endLine: 6,
      text: 'const x = 1;',
    });

    const parsed = parseCodeSelectionDragData(transfer);
    assert.deepEqual(parsed, {
      workspacePath: 'src/app.ts',
      startLine: 4,
      endLine: 6,
      text: 'const x = 1;',
    });
    assert.equal(transfer.getData('text/plain'), 'const x = 1;');
    assert.ok(transfer.getData(CODE_SELECTION_MIME).includes('"workspacePath"'));
  });
});

describe('initComposerDrop code selection', () => {
  afterEach(() => {
    clearAttachments();
    document.body.replaceChildren();
  });

  it('queues a codeRef attachment from editor selection drop', async () => {
    setupComposerDom();
    initComposerDrop();

    const input = document.getElementById('msgInput') as HTMLTextAreaElement;
    const payload = JSON.stringify({
      workspacePath: 'count_cats.py',
      startLine: 10,
      endLine: 12,
      text: 'cat_count = 0',
    });
    const transfer = {
      types: [CODE_SELECTION_MIME, 'text/plain'],
      files: [] as FileList,
      getData: (type: string) =>
        type === CODE_SELECTION_MIME
          ? payload
          : type === 'text/plain'
            ? 'cat_count = 0'
            : '',
      dropEffect: 'none',
      effectAllowed: 'all',
    } as DataTransfer;

    const event = new DragEvent('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: transfer });

    input.dispatchEvent(event);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const pending = getPendingAttachments();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].kind, 'codeRef');
    assert.equal(pending[0].workspacePath, 'count_cats.py');
    assert.equal(pending[0].lineStart, 10);
    assert.equal(pending[0].lineEnd, 12);
  });
});
