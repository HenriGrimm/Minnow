import { EditorSelection } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { ViewerTabState } from './file-viewer-tab-store';

/** Consume navigation on both a fresh mount and an already-visible editor. */
export function applyPendingViewerSelection(view: EditorView, tab: ViewerTabState): void {
  const doc = view.state.doc;
  if (tab.pendingInitialLineRange) {
    const { startLine, endLine } = tab.pendingInitialLineRange;
    tab.pendingInitialLineRange = null;
    tab.pendingInitialSelection = null;
    const fromLine = Math.max(1, Math.min(startLine, doc.lines));
    const toLine = Math.max(fromLine, Math.min(endLine, doc.lines));
    view.dispatch({
      selection: EditorSelection.range(doc.line(fromLine).from, doc.line(toLine).to),
      scrollIntoView: true,
    });
  } else if (tab.pendingInitialSelection) {
    const { line, character } = tab.pendingInitialSelection;
    tab.pendingInitialSelection = null;
    const lineInfo = doc.line(Math.max(1, Math.min(line + 1, doc.lines)));
    const anchor = lineInfo.from + Math.max(0, Math.min(character, lineInfo.length));
    view.dispatch({ selection: EditorSelection.cursor(anchor), scrollIntoView: true });
  }
}
