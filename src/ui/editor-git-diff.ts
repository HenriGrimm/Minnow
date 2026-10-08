import { StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import { diffLines } from 'diff';

export interface EditorGitDiff {
  baseline: string;
  staged: boolean;
}

class RemovedLines extends WidgetType {
  constructor(readonly lines: string[], readonly firstLine: number) { super(); }
  eq(other: RemovedLines): boolean {
    return this.firstLine === other.firstLine && this.lines.join('\n') === other.lines.join('\n');
  }
  toDOM(): HTMLElement {
    const block = document.createElement('div');
    block.className = 'cm-git-removed';
    block.setAttribute('aria-label', 'Removed lines');
    this.lines.forEach((text, index) => {
      const row = document.createElement('div');
      const number = document.createElement('span');
      number.className = 'cm-git-old-number';
      number.textContent = `${this.firstLine + index} −`;
      const code = document.createElement('span');
      code.textContent = text || ' ';
      row.append(number, code);
      block.appendChild(row);
    });
    return block;
  }
  ignoreEvent(): boolean { return false; }
}

/** Decorations leave the actual editor document untouched, including on save. */
export function gitDiffDecorations(state: EditorView['state'], baseline: string): DecorationSet {
  const parts = diffLines(baseline.replace(/\r\n?/g, '\n'), state.doc.toString(), { timeout: 40 });
  if (!parts) return Decoration.none;
  const ranges = [];
  let newLine = 1;
  let oldLine = 1;
  for (const part of parts) {
    const lines = part.value.split('\n');
    if (lines.at(-1) === '') lines.pop();
    if (part.removed) {
      const pos = newLine <= state.doc.lines ? state.doc.line(newLine).from : state.doc.length;
      ranges.push(Decoration.widget({ widget: new RemovedLines(lines, oldLine), block: true,
        side: newLine <= state.doc.lines ? -1 : 1 }).range(pos));
      oldLine += lines.length;
    } else {
      for (const _line of lines) {
        if (part.added && newLine <= state.doc.lines) {
          ranges.push(Decoration.line({ class: 'cm-git-added', attributes: { 'aria-label': 'Added line' } })
            .range(state.doc.line(newLine).from));
        }
        newLine++;
        if (!part.added) oldLine++;
      }
    }
  }
  return Decoration.set(ranges, true);
}

export function editorGitDiffExtensions(review?: EditorGitDiff): Extension[] {
  if (!review) return [];
  return [StateField.define<DecorationSet>({
    create: (state) => gitDiffDecorations(state, review.baseline),
    update: (value, transaction) => transaction.docChanged
      ? gitDiffDecorations(transaction.state, review.baseline) : value,
    provide: (field) => EditorView.decorations.from(field),
  }), EditorView.baseTheme({
    '.cm-git-added': { backgroundColor: 'color-mix(in oklch, var(--mn-success) 18%, transparent)' },
    '.cm-git-added::before': { content: '"+"', color: 'var(--mn-success)', marginRight: '1ch' },
    '.cm-git-removed': { backgroundColor: 'color-mix(in oklch, var(--mn-danger) 16%, transparent)',
      whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', padding: '0 4px', color: 'var(--mn-fg)' },
    '.cm-git-old-number': { display: 'inline-block', minWidth: '6ch', marginRight: '1ch',
      color: 'var(--mn-fg-muted)', userSelect: 'none', textAlign: 'right' },
  })];
}
