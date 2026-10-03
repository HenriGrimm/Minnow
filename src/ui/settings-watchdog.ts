import { appendSettingsGroup, linkToSettingsSection } from './settings-layout';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Note under generation timeouts: sub-agents are recovered by reconcile, not by the deleted heartbeat/stall supervisor. */
export async function renderAgentSupervisionSection(
  mount: HTMLElement,
  options?: { emphasis?: boolean },
): Promise<void> {
  const body = appendSettingsGroup(
    mount,
    'Sub-agent recovery',
    'Minnow retries sub-agents that crash or run out of time, using their saved progress.',
    'agents.watchdog.supervision',
    options?.emphasis ? { emphasis: true } : undefined,
  );

  const notes = el('div', 'settings-watchdog-supervision__notes');
  const explain = el('div', 'settings-field-hint');
  explain.appendChild(
    el(
      'p',
      undefined,
      'Set how long each sub-agent can run in Sub-agents. When an attempt times out, Minnow can retry it with the work already completed.',
    ),
  );
  explain.appendChild(
    el(
      'p',
      undefined,
      'The generation timeouts above limit how long a model can respond and how long it can pause between updates.',
    ),
  );
  notes.appendChild(explain);

  const recovery = el('p', 'settings-field-hint');
  recovery.append(
    'Change sub-agent concurrency and timeouts under ',
    linkToSettingsSection('Sub-agents', 'sub-agents'),
    '.',
  );
  notes.appendChild(recovery);
  body.appendChild(notes);
}
