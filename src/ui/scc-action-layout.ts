import { button, el } from './scc-shared';

export function actionHeader(title: string, description: string, actions: HTMLElement[] = []): HTMLElement {
  const head = el('header', 'scc-actions__header');
  const copy = el('div');
  copy.append(el('h1', undefined, title), el('p', undefined, description));
  const controls = el('div', 'scc-actions__controls');
  controls.append(...actions);
  head.append(copy, controls);
  return head;
}

export function actionRow(title: string, meta: string, onClick: () => void): HTMLButtonElement {
  const row = button({ onClick, className: 'scc-action-row' });
  row.classList.remove('scc-btn--icon-only');
  row.removeAttribute('aria-label');
  row.append(el('span', 'scc-action-row__title', title), el('span', 'scc-action-row__meta', meta));
  return row;
}

export function selectActionRow(list: HTMLElement, row: HTMLElement): void {
  for (const item of list.querySelectorAll('.scc-action-row')) {
    const selected = item === row;
    item.classList.toggle('is-selected', selected);
    item.setAttribute('aria-pressed', String(selected));
  }
}
