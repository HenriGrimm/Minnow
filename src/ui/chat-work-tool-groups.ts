import { createToolCallBatch, syncToolCallBatch } from './tool-call-batch';

/** Restore compact tool groups across adjacent saved rounds without changing history. */
export function groupWorkedToolRows(rows: HTMLElement[]): HTMLElement[] {
  const grouped: HTMLElement[] = [];
  let pending: HTMLElement[] = [];
  const flush = () => {
    if (pending.length < 2) {
      grouped.push(...pending);
      pending = [];
      return;
    }
    const first = pending[0];
    const batch = pending.find(row => row.matches('.tool-call-batch')) ?? createToolCallBatch([]);
    const tools = pending.flatMap(row => row.matches('.tool-call-batch')
      ? [...row.querySelectorAll<HTMLElement>(':scope > .tool-call-batch__body > .tool-call-msg')]
      : [row]);
    if (batch !== first) first.before(batch);
    if (first.dataset.historyIndex != null) batch.dataset.historyIndex = first.dataset.historyIndex;
    batch.dataset.turnKind = 'assistant-tools';
    for (const tool of tools) tool.classList.remove('chat-work-hidden', 'chat-step', 'chat-step--joined', 'chat-step--continued');
    batch.querySelector('.tool-call-batch__body')!.append(...tools);
    for (const row of pending) if (row !== batch && row.matches('.tool-call-batch')) row.remove();
    syncToolCallBatch(batch as HTMLDetailsElement);
    grouped.push(batch);
    pending = [];
  };
  for (const row of rows) {
    if (!isGroupable(row)) {
      flush();
      grouped.push(row);
      continue;
    }
    if (pending.length && nextActivity(pending.at(-1)!) !== row) flush();
    pending.push(row);
  }
  flush();
  return grouped;
}

function nextActivity(row: HTMLElement): Element | null {
  let next = row.nextElementSibling;
  while (next?.matches('.chat-work, .chat-turn-todos, .tool-call-msg[hidden], .tool-call-batch[hidden]')) next = next.nextElementSibling;
  return next;
}

function isGroupable(row: HTMLElement): boolean {
  if (row.matches('.tool-call-msg')) return !row.matches('.tool-call-msg--delegated, [data-tool-name="spawn_sub_agent"]');
  return row.matches('.tool-call-batch:not([data-reasoning-summary-title]):not(.tool-call-batch--delegated)')
    && !row.querySelector('.tool-call-msg--delegated:not([hidden]), .sub-agent-card, .sub-agent-group, [data-tool-name="spawn_sub_agent"]:not([hidden])');
}
