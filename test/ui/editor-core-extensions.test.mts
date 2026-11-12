import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Window } from 'happy-dom';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { fileEditorEscapeBlurBinding, fileEditorKeymapExtensions } from '../../src/ui/file-editor-keymap.ts';
import { editorCoreExtensions } from '../../src/ui/editor-core-extensions.ts';

function setupDom(): void {
  const window = new Window();
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Node = window.Node;
  globalThis.MutationObserver = window.MutationObserver;
  globalThis.ResizeObserver = window.ResizeObserver;
}

describe('editor core extensions precedence', () => {
  test('editorCoreExtensions bundles history, search, and folding', () => {
    const exts = editorCoreExtensions({
      filePath: 'hello.js',
      wordWrap: true,
      tabSize: 4,
      renderWhitespace: true,
    });
    assert.ok(exts.length >= 10);
  });

  test('fileEditor Escape binding runs with core defaultKeymap loaded', () => {
    setupDom();
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new EditorView({
      state: EditorState.create({
        doc: 'hello',
        extensions: [...editorCoreExtensions({ filePath: 'src/hello.js', wordWrap: false, tabSize: 2 }), ...fileEditorKeymapExtensions()],
      }),
      parent,
    });
    assert.equal(view.contentDOM.getAttribute('aria-label'), 'Editor for src/hello.js');
    assert.equal(fileEditorEscapeBlurBinding.run!(view), true);
    view.destroy();
  });
});
