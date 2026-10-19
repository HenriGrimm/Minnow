/** Read-only unified diff for narrow screens: one column, gutter signs, no side-by-side. */

import type { DiffLine } from '../chat/prompts/text-diff';
import { el } from './dom';

/** Unchanged runs longer than this collapse to their edges. */
const CONTEXT = 3;

export function renderDiff(lines: readonly DiffLine[]): HTMLElement {
  const table = el('div', { className: 'm-diff', attrs: { role: 'table', 'aria-label': 'Changes' } });
  let oldLine = 0;
  let newLine = 0;
  const row = (line: DiffLine) => {
    if (line.type !== 'add') oldLine += 1;
    if (line.type !== 'remove') newLine += 1;
    const number = line.type === 'remove' ? oldLine : newLine;
    const sign = line.type === 'add' ? '+' : line.type === 'remove' ? '−' : ' ';
    return el(
      'div',
      { className: `m-diff__row m-diff__row--${line.type}`, attrs: { role: 'row' } },
      el('span', { className: 'm-diff__num', text: String(number) }),
      el('span', { className: 'm-diff__sign', text: sign, attrs: { 'aria-hidden': 'true' } }),
      el('span', { className: 'm-diff__text', text: line.text || ' ' }),
    );
  };

  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.type !== 'unchanged') {
      table.append(row(lines[i]!));
      i += 1;
      continue;
    }
    let end = i;
    while (end < lines.length && lines[end]!.type === 'unchanged') end += 1;
    const run = lines.slice(i, end);
    const head = i === 0 ? 0 : CONTEXT;
    const tail = end === lines.length ? 0 : CONTEXT;
    if (run.length <= head + tail + 1) {
      for (const line of run) table.append(row(line));
    } else {
      for (const line of run.slice(0, head)) table.append(row(line));
      const hidden = run.slice(head, run.length - tail);
      const fold = el('button', {
        className: 'm-diff__fold',
        text: `${hidden.length} unchanged lines`,
        attrs: { type: 'button' },
      });
      const startOld = oldLine;
      const startNew = newLine;
      // Keep numbering right for the rows after the fold.
      oldLine += hidden.length;
      newLine += hidden.length;
      fold.addEventListener('click', () => {
        const savedOld = oldLine;
        const savedNew = newLine;
        oldLine = startOld;
        newLine = startNew;
        fold.replaceWith(...hidden.map(row));
        oldLine = savedOld;
        newLine = savedNew;
      });
      table.append(fold);
      for (const line of run.slice(run.length - tail)) table.append(row(line));
    }
    i = end;
  }
  if (!lines.length) table.append(el('p', { className: 'm-muted', text: 'No changes.' }));
  return table;
}
