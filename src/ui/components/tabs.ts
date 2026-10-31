/**
 * Tabs (WAI-ARIA tab pattern). Pass `panel` elements to have the component
 * show and hide them, or omit them and swap content in `onChange`.
 */

import '../../styles/components/tabs.css';
import { createIcon, type IconName } from '../icon';
import { addClassNames, nextComponentId } from './internal';

export interface TabSpec {
  id: string;
  label: string;
  icon?: IconName;
  /** Small count after the label (e.g. changed files). */
  count?: number;
  disabled?: boolean;
  panel?: HTMLElement;
}

export interface TabsOptions {
  tabs: TabSpec[];
  /** Defaults to the first enabled tab. */
  selected?: string;
  ariaLabel: string;
  /** `auto` selects as arrow keys move (default); `manual` waits for Enter or Space. */
  activation?: 'auto' | 'manual';
  /** `underline` for panes and pages (default); `contained` for tabs inside a card or toolbar. */
  variant?: 'underline' | 'contained';
  className?: string;
  onChange?: (id: string) => void;
}

export interface TabsHandle {
  root: HTMLDivElement;
  list: HTMLDivElement;
  select(id: string, options?: { silent?: boolean; focus?: boolean }): void;
  getSelected(): string | null;
  setCount(id: string, count: number | null): void;
  setDisabled(id: string, disabled: boolean): void;
}

interface TabRecord {
  spec: TabSpec;
  tab: HTMLButtonElement;
  count: HTMLSpanElement;
}

export function createTabs(options: TabsOptions): TabsHandle {
  const root = document.createElement('div');
  root.className = `mn-tabs mn-tabs--${options.variant ?? 'underline'}`;
  addClassNames(root, options.className);

  const list = document.createElement('div');
  list.className = 'mn-tabs__list';
  list.setAttribute('role', 'tablist');
  list.setAttribute('aria-label', options.ariaLabel);
  root.appendChild(list);

  const baseId = nextComponentId('tabs');
  const records = new Map<string, TabRecord>();
  let current: string | null = null;
  const manual = options.activation === 'manual';

  for (const spec of options.tabs) {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'mn-tabs__tab';
    tab.id = `${baseId}-tab-${spec.id}`;
    tab.setAttribute('role', 'tab');
    tab.dataset.tabId = spec.id;
    if (spec.icon) tab.appendChild(createIcon(spec.icon, { className: 'mn-tabs__icon' }));
    const label = document.createElement('span');
    label.className = 'mn-tabs__label';
    label.textContent = spec.label;
    tab.appendChild(label);
    const count = document.createElement('span');
    count.className = 'mn-tabs__count';
    tab.appendChild(count);
    if (spec.disabled) tab.disabled = true;
    tab.addEventListener('click', () => select(spec.id, false));
    list.appendChild(tab);

    if (spec.panel) {
      const panel = spec.panel;
      panel.classList.add('mn-tabs__panel');
      panel.id ||= `${baseId}-panel-${spec.id}`;
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', tab.id);
      if (!panel.hasAttribute('tabindex')) panel.tabIndex = 0;
      tab.setAttribute('aria-controls', panel.id);
      root.appendChild(panel);
    }

    const record = { spec, tab, count };
    records.set(spec.id, record);
    writeCount(record, spec.count ?? null);
  }

  function writeCount(record: TabRecord, value: number | null): void {
    record.count.textContent = value == null ? '' : String(value);
    record.count.hidden = value == null;
  }

  const enabledTabs = () => [...records.values()].map((r) => r.tab).filter((tab) => !tab.disabled);

  function sync(): void {
    for (const [id, record] of records) {
      const selected = id === current;
      record.tab.setAttribute('aria-selected', selected ? 'true' : 'false');
      record.tab.classList.toggle('is-selected', selected);
      record.tab.tabIndex = selected ? 0 : -1;
      if (record.spec.panel) record.spec.panel.hidden = !selected;
    }
    if (current == null) {
      const first = enabledTabs()[0];
      if (first) first.tabIndex = 0;
    }
  }

  function select(id: string, silent: boolean, focus = false): void {
    const record = records.get(id);
    if (!record || record.tab.disabled) return;
    if (focus) record.tab.focus();
    if (id === current) return;
    current = id;
    sync();
    if (!silent) options.onChange?.(id);
  }

  list.addEventListener('keydown', (event) => {
    const tabs = enabledTabs();
    if (tabs.length === 0) return;
    const index = tabs.indexOf(document.activeElement as HTMLButtonElement);
    let next: HTMLButtonElement | undefined;
    switch (event.key) {
      case 'ArrowRight':
        next = tabs[(index + 1) % tabs.length];
        break;
      case 'ArrowLeft':
        next = tabs[(index - 1 + tabs.length) % tabs.length];
        break;
      case 'Home':
        next = tabs[0];
        break;
      case 'End':
        next = tabs[tabs.length - 1];
        break;
      case 'Enter':
      case ' ':
        if (index < 0) return;
        event.preventDefault();
        select(tabs[index].dataset.tabId!, false);
        return;
      default:
        return;
    }
    event.preventDefault();
    next.focus();
    if (!manual) select(next.dataset.tabId!, false);
  });

  const initial = options.selected ?? options.tabs.find((tab) => !tab.disabled)?.id;
  if (initial != null && records.has(initial) && !records.get(initial)!.tab.disabled) current = initial;
  sync();

  return {
    root,
    list,
    select: (id, opts) => select(id, opts?.silent === true, opts?.focus === true),
    getSelected: () => current,
    setCount: (id, value) => {
      const record = records.get(id);
      if (record) writeCount(record, value);
    },
    setDisabled: (id, disabled) => {
      const record = records.get(id);
      if (!record) return;
      record.tab.disabled = disabled;
      sync();
    },
  };
}
