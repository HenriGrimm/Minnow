import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EditorState, type TransactionSpec } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { applyPendingViewerSelection } from '../../src/ui/file-viewer-initial-selection.ts';
import type { ViewerTabState } from '../../src/ui/file-viewer-tab-store.ts';

function setup() {
  const tab = { pendingInitialLineRange: null, pendingInitialSelection: null } as ViewerTabState;
  const requests: TransactionSpec[] = [];
  const view = {
    state: EditorState.create({ doc: 'first\n  matching line\nlast' }),
    dispatch(spec: TransactionSpec) {
      requests.push(spec);
      this.state = this.state.update(spec).state;
    },
  };
  return { tab, view: view as unknown as EditorView, requests };
}

test('line navigation selects the complete matching line and requests scrolling without editing', () => {
  const { tab, view, requests } = setup();
  tab.pendingInitialLineRange = { startLine: 2, endLine: 2 };
  applyPendingViewerSelection(view, tab);
  const selection = view.state.selection.main;
  assert.equal(view.state.sliceDoc(selection.from, selection.to), '  matching line');
  assert.equal(requests[0]?.scrollIntoView, true);
  assert.equal(tab.pendingInitialLineRange, null);
  assert.equal(view.state.doc.toString(), 'first\n  matching line\nlast');
  applyPendingViewerSelection(view, tab);
  assert.equal(requests.length, 1, 'rendering again must not reset the user selection');
  view.dispatch({ selection: { anchor: 0 } });
  tab.pendingInitialLineRange = { startLine: 2, endLine: 2 };
  applyPendingViewerSelection(view, tab);
  assert.equal(view.state.selection.main.from, view.state.doc.line(2).from,
    'a repeated result activation must reselect the line on the same view');
});

test('stale ranges clamp to the current document and supersede older cursor navigation', () => {
  const { tab, view } = setup();
  tab.pendingInitialLineRange = { startLine: 99, endLine: 101 };
  tab.pendingInitialSelection = { line: 0, character: 0 };
  applyPendingViewerSelection(view, tab);
  assert.equal(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to), 'last');
  assert.equal(tab.pendingInitialSelection, null);
  tab.pendingInitialLineRange = { startLine: 0, endLine: 0 };
  applyPendingViewerSelection(view, tab);
  assert.equal(view.state.selection.main.from, 0);
});

test('existing cursor navigation remains zero-based and scrolls to the requested column', () => {
  const { tab, view, requests } = setup();
  tab.pendingInitialSelection = { line: 1, character: 2 };
  applyPendingViewerSelection(view, tab);
  assert.equal(view.state.selection.main.head, view.state.doc.line(2).from + 2);
  assert.equal(view.state.selection.main.empty, true);
  assert.equal(requests[0]?.scrollIntoView, true);
  assert.equal(tab.pendingInitialSelection, null);
});
