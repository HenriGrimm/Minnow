/**
 * The Issues peek property list.
 *
 * Everything under the description is a row in one list: glyph, name, the
 * state it holds, and its control — clustered on the left so the value never
 * drifts away from the label it belongs to. A filled row says what it holds
 * without being opened; an empty one is its own add control. The row itself
 * is the affordance (open what is there, or add the first thing); the
 * trailing button is the menu. Rows sit flush so the block reads as one
 * object, which is why there are no per-row rules and no card.
 */

import { createIcon, type IconName } from './icon';

/** localStorage map: row key → expanded. */
export const ISSUES_PEEK_SECTIONS_STORAGE_KEY = 'minnow.issues.peekSections';

let expandedCache: Record<string, boolean> | null = null;

function readExpanded(): Record<string, boolean> {
  if (expandedCache) return expandedCache;
  const out: Record<string, boolean> = {};
  try {
    const raw = localStorage.getItem(ISSUES_PEEK_SECTIONS_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === 'boolean') out[key] = value;
      }
    }
  } catch {
    /* private mode — this session still toggles in memory */
  }
  expandedCache = out;
  return out;
}

function writeExpanded(map: Record<string, boolean>): void {
  expandedCache = map;
  try {
    localStorage.setItem(ISSUES_PEEK_SECTIONS_STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* quota — in-memory state still applies */
  }
}

/** Whether this row's detail is open. Rows start closed; the summary carries the state. */
export function isDetailRowExpanded(key: string): boolean {
  return readExpanded()[key] === true;
}

function setDetailRowExpanded(key: string, expanded: boolean): void {
  const map = { ...readExpanded() };
  map[key] = expanded;
  writeExpanded(map);
}

/** Test helper — drop persisted row state. */
export function resetDetailSectionsForTests(): void {
  expandedCache = null;
  try {
    localStorage.removeItem(ISSUES_PEEK_SECTIONS_STORAGE_KEY);
  } catch {
    /* nothing stored */
  }
}

export interface DetailIconButtonOptions {
  label: string;
  icon: IconName;
  onClick: (anchor: HTMLButtonElement) => void;
  disabled?: boolean;
  /** Tooltip; defaults to `label`. */
  title?: string;
  danger?: boolean;
  className?: string;
}

/** Square icon-only control: a row's trailing menu, and row removes. */
export function createDetailIconButton(options: DetailIconButtonOptions): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = options.className
    ? `issues-detail__sec-btn ${options.className}`
    : 'issues-detail__sec-btn';
  if (options.danger) btn.classList.add('issues-detail__sec-btn--danger');
  btn.setAttribute('aria-label', options.label);
  btn.title = options.title ?? options.label;
  btn.disabled = Boolean(options.disabled);
  btn.appendChild(createIcon(options.icon, { size: 14 }));
  btn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (btn.disabled) return;
    options.onClick(btn);
  });
  return btn;
}

export interface DetailTextButtonOptions {
  label: string;
  icon: IconName;
  onClick: (anchor: HTMLButtonElement) => void;
  disabled?: boolean;
  title?: string;
  primary?: boolean;
  className?: string;
}

/** Labelled action with a leading glyph. Lives inside expanded row detail. */
export function createDetailTextButton(options: DetailTextButtonOptions): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  const classes = ['issues-btn', 'issues-detail__act'];
  if (options.primary) classes.push('issues-btn--primary');
  if (options.className) classes.push(options.className);
  btn.className = classes.join(' ');
  btn.disabled = Boolean(options.disabled);
  if (options.title) btn.title = options.title;
  btn.appendChild(createIcon(options.icon, { size: 13, className: 'issues-detail__act-icon' }));
  const text = document.createElement('span');
  text.textContent = options.label;
  btn.appendChild(text);
  btn.addEventListener('click', (event) => {
    event.preventDefault();
    if (btn.disabled) return;
    options.onClick(btn);
  });
  return btn;
}

/** One piece of a row's summary. `mono` is for ids, refs, and paths. */
export interface DetailRowSummaryPart {
  text: string;
  mono?: boolean;
  /** Tint for a state word ("Running", "Needs push"). */
  tone?: 'accent' | 'success' | 'warning' | 'danger';
}

export interface DetailRowOptions {
  /** Stable id for the persisted open state. */
  key: string;
  icon: IconName;
  label: string;
  /** What the row holds right now, shown beside the name. */
  summary?: DetailRowSummaryPart[];
  /** Detail under the row; only set when there is something to show. */
  expandable?: boolean;
  defaultExpanded?: boolean;
  /** Primary action for an empty row, and for the trailing control. */
  onAdd?: (anchor: HTMLElement) => void;
  /** Accessible name for the trailing control. */
  addLabel?: string;
  /** Glyph for the trailing control. Defaults to `plus`. */
  addIcon?: IconName;
}

export interface DetailRowHandle {
  section: HTMLElement;
  /** Detail content under the row. */
  body: HTMLElement;
  row: HTMLElement;
  /** Replace the trailing control. */
  setTrailing: (control: HTMLElement) => void;
  /** Open the detail (an add control must not act on hidden content). */
  expand: () => void;
}

function buildSummary(parts: readonly DetailRowSummaryPart[]): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'issues-detail__row-value';
  for (const part of parts) {
    const el = document.createElement('span');
    el.className = 'issues-detail__row-value-part';
    if (part.mono) el.classList.add('is-mono');
    if (part.tone) el.classList.add(`is-${part.tone}`);
    el.textContent = part.text;
    wrap.appendChild(el);
  }
  return wrap;
}

/**
 * Build one property row and its detail host.
 *
 * The row is a button whenever it can do something: open the detail when it
 * has content, run the add action when it does not.
 */
export function createDetailRow(options: DetailRowOptions): DetailRowHandle {
  const section = document.createElement('section');
  section.className = 'issues-detail__section issues-detail__section--rail';
  section.dataset.section = options.key;

  const body = document.createElement('div');
  body.className = 'issues-detail__section-body';
  body.id = `issues-sec-${options.key}`;

  const summary = options.summary ?? [];
  const filled = summary.length > 0;
  const expandable = Boolean(options.expandable);
  const interactive = expandable || Boolean(options.onAdd);

  const row = interactive ? document.createElement('button') : document.createElement('div');
  row.className = 'issues-detail__row';
  if (filled) row.classList.add('is-filled');
  const rowButton = interactive ? (row as HTMLButtonElement) : null;
  if (rowButton) rowButton.type = 'button';

  row.appendChild(createIcon(options.icon, { size: 14, className: 'issues-detail__row-icon' }));

  const name = document.createElement('h3');
  name.className = 'issues-detail__section-title';
  name.textContent = options.label;
  row.appendChild(name);

  // Value sits beside its name, not pinned to the far edge: at peek widths a
  // right-aligned value ends up hundreds of pixels from the label it belongs to.
  if (filled) row.appendChild(buildSummary(summary));

  const trailing = document.createElement('span');
  trailing.className = 'issues-detail__row-trailing';
  row.appendChild(trailing);

  section.append(row, body);

  const setTrailing = (control: HTMLElement): void => {
    trailing.replaceChildren(control);
  };

  if (options.onAdd) {
    const add = options.onAdd;
    setTrailing(
      createDetailIconButton({
        label: options.addLabel ?? `Add to ${options.label}`,
        icon: options.addIcon ?? 'plus',
        onClick: (anchor) => add(anchor),
      }),
    );
  }

  let expand = (): void => {};

  if (expandable) {
    const isOpen = (): boolean => readExpanded()[options.key] ?? options.defaultExpanded ?? false;
    const paint = (): void => {
      const open = isOpen();
      section.classList.toggle('is-open', open);
      body.hidden = !open;
      rowButton?.setAttribute('aria-expanded', open ? 'true' : 'false');
      rowButton?.setAttribute('aria-controls', body.id);
      if (rowButton) rowButton.title = open ? `Hide ${options.label}` : `Show ${options.label}`;
    };
    rowButton?.addEventListener('click', () => {
      setDetailRowExpanded(options.key, !isOpen());
      paint();
    });
    paint();
    expand = (): void => {
      if (isOpen()) return;
      setDetailRowExpanded(options.key, true);
      paint();
    };
  } else {
    body.hidden = true;
    if (rowButton && options.onAdd) {
      const add = options.onAdd;
      rowButton.title = options.addLabel ?? `Add to ${options.label}`;
      rowButton.addEventListener('click', () => add(rowButton));
    }
  }

  return { section, body, row, setTrailing, expand };
}
