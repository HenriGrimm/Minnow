import { createIcon, type IconName } from './icon';
import { el, stateDot, type RunState } from './scc-shared';

/** List row for workflows, commands and local runs: same anatomy as every other list. */
export function actionRow(
  title: string,
  meta: string,
  onClick: () => void,
  lead?: { icon?: IconName; state?: RunState },
): HTMLButtonElement {
  const row = el('button', 'scc-row scc-action-row');
  row.type = 'button';
  row.addEventListener('click', onClick);
  const leadEl = el('span', 'scc-row__lead');
  if (lead?.state) leadEl.appendChild(stateDot(lead.state));
  else leadEl.appendChild(createIcon(lead?.icon ?? 'workflow', { size: 14 }));
  const metaEl = el('span', 'scc-row__meta');
  metaEl.appendChild(el('span', 'scc-action-row__meta', meta));
  row.append(leadEl, el('span', 'scc-row__title scc-action-row__title', title), metaEl);
  row.title = `${title}\n${meta}`;
  return row;
}

export function selectActionRow(list: HTMLElement, row: HTMLElement): void {
  for (const item of list.querySelectorAll('.scc-action-row')) {
    const selected = item === row;
    item.classList.toggle('is-selected', selected);
    item.setAttribute('aria-pressed', String(selected));
  }
}
