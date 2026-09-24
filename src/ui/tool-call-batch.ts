import { createIcon } from './icon';
import { getToolAction } from './tool-call-presentation';

export interface ToolCallBatchItem {
  name: string;
  wrap: HTMLElement;
}

/** Build one disclosure for the tool calls emitted by a single model round. */
export function createToolCallBatch(items: readonly ToolCallBatchItem[]): HTMLDetailsElement {
  const batch = document.createElement('details');
  batch.className = 'tool-call-batch';

  const summary = document.createElement('summary');
  summary.className = 'tool-call-batch__summary';

  const status = document.createElement('span');
  status.className = 'tool-call-batch__status';
  status.setAttribute('aria-hidden', 'true');

  const label = document.createElement('span');
  label.className = 'tool-call-batch__label';

  const counts = document.createElement('span');
  counts.className = 'tool-call-batch__counts';

  summary.append(
    status,
    label,
    counts,
    createIcon('chevronRight', { className: 'tool-call-batch__chevron', size: 14 }),
  );

  const body = document.createElement('div');
  body.className = 'tool-call-batch__body';
  batch.append(summary, body);
  batch.addEventListener('toggle', () => syncToolCallBatch(batch));

  for (const item of items) appendToolCallBatchItem(batch, item);
  syncToolCallBatch(batch);
  return batch;
}

/** Add a newly streamed call to an existing round disclosure. */
export function appendToolCallBatchItem(
  batch: HTMLDetailsElement,
  item: ToolCallBatchItem,
): void {
  item.wrap.dataset.toolName ||= item.name;
  batch.querySelector('.tool-call-batch__body')?.appendChild(item.wrap);
  syncToolCallBatch(batch);
}

/** Insert a batch where its first mounted row was, then move every row inside it. */
export function replaceToolCallRowsWithBatch(
  items: readonly ToolCallBatchItem[],
): HTMLDetailsElement {
  const first = items[0]?.wrap;
  const parent = first?.parentNode;
  const next = first?.nextSibling ?? null;
  const batch = createToolCallBatch(items);
  if (parent) parent.insertBefore(batch, next);
  return batch;
}

/** Refresh aggregate running/failure state after a child tool row changes. */
export function syncToolCallBatchForRow(row: HTMLElement): void {
  const batch = row.closest<HTMLDetailsElement>('.tool-call-batch');
  if (batch) syncToolCallBatch(batch);
}

export function syncToolCallBatch(batch: HTMLDetailsElement): void {
  const rows = Array.from(
    batch.querySelectorAll<HTMLElement>(':scope > .tool-call-batch__body > .tool-call-msg'),
  );
  const running = rows.filter((row) => row.hasAttribute('aria-busy')).length;
  const failed = rows.filter((row) => row.classList.contains('tool-call-msg--fail')).length;
  const total = rows.length;

  const countsByName = new Map<string, number>();
  for (const row of rows) {
    const name = row.dataset.toolName?.trim() || 'tool';
    countsByName.set(name, (countsByName.get(name) ?? 0) + 1);
  }

  const countParts = Array.from(countsByName, ([name, count]) => {
    const item = document.createElement('span');
    item.className = 'tool-call-batch__count';
    item.dataset.toolName = name;
    item.title = name;
    item.textContent = `${getToolAction(name)} ×${count}`;
    return item;
  });

  const label = batch.querySelector<HTMLElement>('.tool-call-batch__label');
  if (label) {
    label.textContent = running
      ? `Running ${total} tools`
      : `${total} tool ${total === 1 ? 'call' : 'calls'}${failed ? `, ${failed} failed` : ''}`;
  }
  batch.querySelector('.tool-call-batch__counts')?.replaceChildren(...countParts);

  const status = batch.querySelector<HTMLElement>('.tool-call-batch__status');
  if (status) {
    status.replaceChildren(
      running
        ? spinner()
        : createIcon(failed ? 'statusFail' : 'tools', {
            className: failed
              ? 'tool-call-batch__icon tool-call-batch__icon--fail'
              : 'tool-call-batch__icon',
            size: 15,
          }),
    );
  }

  batch.classList.toggle('tool-call-batch--running', running > 0);
  batch.classList.toggle('tool-call-batch--fail', failed > 0);
  batch.setAttribute('aria-busy', String(running > 0));
  const accessibleCounts = Array.from(
    countsByName,
    ([name, count]) => `${getToolAction(name)} ${count}`,
  );
  batch.querySelector('summary')?.setAttribute(
    'aria-label',
    [label?.textContent, ...accessibleCounts, batch.open ? 'Hide tool calls' : 'Show tool calls']
      .filter(Boolean)
      .join('. '),
  );
}

function spinner(): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = 'tool-call-spinner';
  return el;
}
