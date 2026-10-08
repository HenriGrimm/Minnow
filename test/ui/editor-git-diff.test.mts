import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EditorState } from '@codemirror/state';
import { EditorView, type DecorationSet } from '@codemirror/view';
import { Window } from 'happy-dom';
import { editorGitDiffExtensions, gitDiffDecorations } from '../../src/ui/editor-git-diff.ts';

test('diff decorations highlight additions and show removed content without changing the document', async () => {
  const win = new Window();
  const original = globalThis.document;
  globalThis.document = win.document as unknown as Document;
  try {
    const content = 'unchanged\nnew\ntrailing  \n';
    const state = EditorState.create({ doc: content });
    const decorations = gitDiffDecorations(state, 'unchanged\n<script>old</script>\ntrailing\n');
    const additions: number[] = [];
    const removed: string[] = [];
    decorations.between(0, state.doc.length, (from, _to, decoration) => {
      if (decoration.spec.class === 'cm-git-added') additions.push(state.doc.lineAt(from).number);
      if (decoration.spec.widget) {
        const dom = decoration.spec.widget.toDOM();
        assert.equal(dom.querySelector('script'), null);
        removed.push(dom.textContent!);
      }
    });
    assert.deepEqual(additions, [2, 3]);
    assert.match(removed.join('\n'), /<script>old<\/script>/);
    assert.equal(state.doc.toString(), content);
  } finally {
    globalThis.document = original;
    await win.close();
  }
});

test('inline highlights recalculate after typing and leave save content free of deleted lines', () => {
  const state = EditorState.create({ doc: 'old\n', extensions: editorGitDiffExtensions({ baseline: 'old\n', staged: false }) });
  const next = state.update({ changes: { from: 0, to: 3, insert: 'new' } }).state;
  const decorations = next.facet(EditorView.decorations)[0] as DecorationSet;
  assert.equal(decorations.size, 2);
  assert.equal(next.doc.toString(), 'new\n');
  const restored = next.update({ changes: { from: 0, to: 3, insert: 'old' } }).state;
  assert.equal((restored.facet(EditorView.decorations)[0] as DecorationSet).size, 0);
});

test('deletions at EOF and entirely deleted files keep their old text visible', () => {
  for (const [before, after] of [['keep\nremove', 'keep'], ['removed\n', '']]) {
    const state = EditorState.create({ doc: after });
    const decorations = gitDiffDecorations(state, before);
    let widgets = 0;
    decorations.between(0, state.doc.length, (_from, _to, decoration) => { if (decoration.spec.widget) widgets++; });
    assert.equal(widgets, 1);
    assert.equal(state.doc.toString(), after);
  }
});
