import { appConfirm } from './app-dialog';
import { createIcon } from './icon';

/** One line in the prompt: what would restart, and why it is pending. */
export interface ResumePromptItem {
  label: string;
  detail: string;
}

export type ResumePromptChoice = ReadonlySet<number> | null;

let inFlight: Promise<ResumePromptChoice> | null = null;

function resumeLabel(count: number): string {
  return `Resume ${count} ${count === 1 ? 'item' : 'items'}`;
}

function buildItemList(items: readonly ResumePromptItem[], selected: Set<number>): HTMLElement {
  const list = document.createElement('ul');
  list.className = 'app-dialog-list graphite-resume-list';
  for (const [index, item] of items.entries()) {
    const row = document.createElement('li');
    row.className = 'app-dialog-list__item';
    const option = document.createElement('label');
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = true;
    toggle.addEventListener('change', () => {
      if (toggle.checked) selected.add(index);
      else selected.delete(index);
      const confirm = list.closest('[role="dialog"]')?.querySelector<HTMLButtonElement>('.app-dialog-panel__btn--primary');
      if (confirm) {
        confirm.textContent = resumeLabel(selected.size);
        confirm.disabled = selected.size === 0;
      }
    });
    const copy = document.createElement('span');
    copy.className = 'graphite-resume-list__copy';
    const label = document.createElement('span');
    label.className = 'app-dialog-list__label';
    label.textContent = item.label;
    const detail = document.createElement('span');
    detail.className = 'app-dialog-list__detail';
    detail.textContent = item.detail;
    copy.append(label, detail);
    option.append(toggle, copy);
    row.append(option);
    list.appendChild(row);
  }
  const body = document.createElement('div');
  body.className = 'graphite-resume-body';
  body.append(createIcon('restore', { size: 16 }), list);
  return body;
}

/** Ask whether to restart the listed work. */
export function showResumePromptModal(
  items: readonly ResumePromptItem[],
): Promise<ResumePromptChoice> {
  if (inFlight) return inFlight;
  if (!items.length) return Promise.resolve(null);

  const selected = new Set(items.map((_, index) => index));
  inFlight = appConfirm(
    'Minnow closed while work was in progress. Your finished steps are kept.',
    {
      title: 'Resume interrupted work?',
      confirmLabel: resumeLabel(items.length),
      cancelLabel: 'Not now',
      body: buildItemList(items, selected),
    },
  )
    .then((confirmed): ResumePromptChoice => (confirmed && selected.size ? selected : null))
    .catch((): ResumePromptChoice => null)
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}
