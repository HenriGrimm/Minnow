import { el } from '../scc-shared';
import type { GitHistoryRef } from './model';

export function renderGitHistoryRefs(refs: readonly GitHistoryRef[]): HTMLElement {
  const root = el('span', 'git-history-map__refs');
  for (const ref of refs) {
    const chip = el('span', 'git-history-map__ref');
    chip.dataset.kind = ref.kind;
    chip.title = `${ref.kind}: ${ref.name}`;
    chip.append(el('span', 'git-history-map__ref-name', ref.kind === 'tag' ? `Tag: ${ref.name}` : ref.name));
    if (ref.kind === 'remote') chip.append(el('span', 'git-history-map__ref-kind', 'remote'));
    root.append(chip);
  }
  return root;
}
