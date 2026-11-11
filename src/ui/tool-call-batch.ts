import { createIcon } from './icon';
import { getToolAction } from './tool-call-presentation';
import { setActivityShimmerText } from './activity-shimmer';

export interface ToolCallBatchItem {
  name: string;
  wrap: HTMLElement;
}

/** Build one disclosure for the tool calls emitted by a single model round. */
export function createToolCallBatch(items: readonly ToolCallBatchItem[], summaryTitle = ''): HTMLDetailsElement {
  const batch = document.createElement('details');
  batch.className = 'tool-call-batch';
  if (summaryTitle) batch.dataset.reasoningSummaryTitle = summaryTitle;

  const summary = document.createElement('summary');
  summary.className = 'tool-call-batch__summary';

  const status = document.createElement('span');
  status.className = 'tool-call-batch__status';
  status.setAttribute('aria-hidden', 'true');

  const label = document.createElement('span');
  label.className = 'tool-call-batch__label';

  const counts = document.createElement('span');
  counts.className = 'tool-call-batch__counts';

  // Collapsed, the round shows what it touched as chips; open, the rows replace them.
  const chips = document.createElement('span');
  chips.className = 'tool-call-batch__chips';

  summary.append(
    status,
    label,
    counts,
    createIcon('chevronRight', { className: 'tool-call-batch__chevron', size: 14 }),
    chips,
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
  summaryTitle = '',
): HTMLDetailsElement {
  const first = items[0]?.wrap;
  const parent = first?.parentNode;
  const next = first?.nextSibling ?? null;
  const batch = createToolCallBatch(items, summaryTitle);
  if (parent) parent.insertBefore(batch, next);
  return batch;
}

/** Refresh the disclosure when a call settles or is hidden. */
export function syncToolCallBatchForRow(row: HTMLElement): void {
  const batch = row.closest<HTMLDetailsElement>('.tool-call-batch');
  if (batch) syncToolCallBatch(batch);
}

export function syncToolCallBatch(batch: HTMLDetailsElement): void {
  const rows = Array.from(
    batch.querySelectorAll<HTMLElement>(':scope > .tool-call-batch__body > .tool-call-msg:not([hidden])'),
  );
  const running = rows.filter((row) => row.hasAttribute('aria-busy')).length;
  const total = rows.length;
  batch.hidden = total === 0;

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
  const summaryTitle = batch.dataset.reasoningSummaryTitle;
  batch.classList.toggle('tool-call-batch--reasoning-summary', Boolean(summaryTitle));
  if (label) {
    const explored = exploredLabel(rows);
    const text = summaryTitle || (running
      ? explored ? 'Exploring' : `Running ${total} tools`
      : explored || `${total} tool ${total === 1 ? 'call' : 'calls'}`);
    if (summaryTitle && running) setActivityShimmerText(label, text);
    else {
      label.classList.remove('activity-shimmer');
      label.textContent = text;
    }
  }
  batch.querySelector('.tool-call-batch__counts')?.replaceChildren(...countParts);
  paintChips(batch, rows);

  const status = batch.querySelector<HTMLElement>('.tool-call-batch__status');
  if (status) {
    status.replaceChildren(running ? spinner() : createIcon('tools', {
      className: 'tool-call-batch__icon', size: 15,
    }));
  }

  batch.classList.toggle('tool-call-batch--running', running > 0);
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

/** Use the latest summary heading as the round title, without rendering Markdown in a control. */
export function toolCallSummaryTitle(segments: readonly string[], format?: 'summary'): string {
  if (format !== 'summary') return '';
  const lines = segments.join('\n\n').split('\n').map(line => line.trim()).filter(Boolean);
  const headings = lines.filter(line => /^(?:#{1,6}\s|\*\*.+\*\*$)/.test(line));
  const title = headings.at(-1) ?? lines[0] ?? '';
  return title.replace(/^#{1,6}\s+|\s+#+$/g, '').replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim();
}

const FILE_TOOLS = new Set([
  'read_file', 'read_file_range', 'read_document', 'get_file_metadata', 'list_directory', 'read_symbol',
]);
const SEARCH_TOOLS = new Set([
  'grep', 'find_files', 'search_in_file', 'find_symbol', 'who_calls', 'repo_map', 'web_search',
]);

/** "Explored 5 files, 1 search" when every call in the round only looked around; otherwise empty. */
export function exploredLabel(rows: readonly HTMLElement[]): string {
  let files = 0;
  let searches = 0;
  for (const row of rows) {
    const name = row.dataset.toolName?.trim() ?? '';
    if (FILE_TOOLS.has(name)) files++;
    else if (SEARCH_TOOLS.has(name)) searches++;
    else return '';
  }
  if (!files && !searches) return '';
  const parts = [
    files ? `${files} file${files === 1 ? '' : 's'}` : '',
    searches ? `${searches} search${searches === 1 ? '' : 'es'}` : '',
  ].filter(Boolean);
  return `Explored ${parts.join(', ')}`;
}

const MAX_CHIPS = 10;

function paintChips(batch: HTMLDetailsElement, rows: readonly HTMLElement[]): void {
  const host = batch.querySelector<HTMLElement>('.tool-call-batch__chips');
  if (!host) return;
  const chips: HTMLElement[] = [];
  for (const row of rows.slice(0, MAX_CHIPS)) {
    const target = row.querySelector('.tool-call-target__base') ?? row.querySelector('.tool-call-target');
    const text = target?.textContent?.trim();
    if (!text) continue;
    const chip = document.createElement('span');
    chip.className = 'tool-call-batch__chip';
    chip.textContent = text;
    chip.title = row.querySelector('.tool-call-target')?.textContent?.trim() || text;
    chips.push(chip);
  }
  if (rows.length > MAX_CHIPS) {
    const more = document.createElement('span');
    more.className = 'tool-call-batch__chip tool-call-batch__chip--more';
    more.textContent = `+${rows.length - MAX_CHIPS}`;
    chips.push(more);
  }
  const key = chips.map((chip) => `${chip.className}:${chip.textContent}`).join('|');
  if (host.dataset.key === key) return;
  host.dataset.key = key;
  host.replaceChildren(...chips);
}

function spinner(): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = 'tool-call-spinner';
  return el;
}
