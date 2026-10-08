import { createIcon, iconHtml, type IconName } from './icon';
import type { CheckState } from '../state/forge-api';

/** Everything a section needs from the shell. */
export interface SccContext {
  /** Effective git cwd (undefined → workspace root). */
  getCwd: () => string | undefined;
  /** Current checked-out branch, '' when detached or unknown. */
  getBranch: () => string;
  /** Re-read git state and repaint the shell chrome plus the active section. */
  refreshAll: () => Promise<void>;
  /** Repaint only the active section. */
  refreshSection: () => Promise<void>;
  /** Jump to another section (rail click, cross-links, palette). */
  goTo: (section: SccSectionId) => void;
  /** Publish a count or state marker onto the rail. */
  setBadge: (section: SccSectionId, badge: SccBadge | null) => void;
}

export type SccSectionId =
  | 'changes'
  | 'history'
  | 'branches'
  | 'stashes'
  | 'worktrees'
  | 'pulls'
  | 'releases'
  | 'checks';

/** Rail badge: a count, or a state dot for things that are green/red. */
export type SccBadge =
  | { kind: 'count'; value: number }
  | { kind: 'state'; value: RunState };

/** Every section implements this; the shell owns mounting and teardown. */
export interface SccView {
  root: HTMLElement;
  refresh: () => Promise<void>;
  destroy: () => void;
  /** Section-local keys. Return true when the key was handled. */
  onKey?: (event: KeyboardEvent) => boolean;
  /** Called when the section becomes visible. */
  activate?: () => void;
}

// ── DOM ──────────────────────────────────────────────────────────────────────

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export type ButtonVariant = 'default' | 'primary' | 'ghost' | 'danger';

export function button(options: {
  label?: string;
  icon?: IconName;
  title?: string;
  variant?: ButtonVariant;
  onClick?: (event: MouseEvent) => void;
  className?: string;
}): HTMLButtonElement {
  const btn = el('button', 'scc-btn');
  btn.type = 'button';
  if (options.variant && options.variant !== 'default') {
    btn.classList.add(`scc-btn--${options.variant}`);
  }
  if (options.className) btn.classList.add(...options.className.split(' '));
  if (options.icon) {
    btn.appendChild(createIcon(options.icon, { className: 'scc-btn__icon', size: 15 }));
  }
  if (options.label) btn.appendChild(el('span', 'scc-btn__label', options.label));
  if (!options.label) {
    btn.classList.add('scc-btn--icon-only');
    btn.setAttribute('aria-label', options.title ?? '');
  }
  if (options.title) btn.title = options.title;
  if (options.onClick) btn.addEventListener('click', options.onClick);
  return btn;
}

/** Section header inside a pane: uppercase label, count, trailing actions. */
export function paneHeader(
  title: string,
  options?: { count?: number | string; actions?: HTMLElement[] },
): HTMLElement {
  const head = el('div', 'scc-pane-head');
  const titleEl = el('h2', 'scc-pane-head__title', title);
  head.appendChild(titleEl);
  if (options?.count !== undefined && options.count !== '') {
    head.appendChild(el('span', 'scc-pane-head__count', String(options.count)));
  }
  if (options?.actions?.length) {
    const actions = el('div', 'scc-pane-head__actions');
    actions.append(...options.actions);
    head.appendChild(actions);
  }
  return head;
}

// ── Empty states ─────────────────────────────────────────────────────────────

export function emptyState(options: {
  icon?: IconName;
  title: string;
  body?: string;
  action?: HTMLElement;
}): HTMLElement {
  const wrap = el('div', 'scc-empty');
  if (options.icon) {
    wrap.appendChild(createIcon(options.icon, { className: 'scc-empty__icon', size: 26 }));
  }
  wrap.appendChild(el('p', 'scc-empty__title', options.title));
  if (options.body) wrap.appendChild(el('p', 'scc-empty__body', options.body));
  if (options.action) {
    const actions = el('div', 'scc-empty__actions');
    actions.appendChild(options.action);
    wrap.appendChild(actions);
  }
  return wrap;
}

/** Blocking explanation: why a whole section cannot work right now. */
export function unavailableState(options: {
  title: string;
  body: string;
  hint?: string;
  action?: HTMLElement;
}): HTMLElement {
  const wrap = el('div', 'scc-empty scc-empty--unavailable');
  wrap.appendChild(el('p', 'scc-empty__title', options.title));
  wrap.appendChild(el('p', 'scc-empty__body', options.body));
  if (options.hint) wrap.appendChild(el('code', 'scc-empty__hint', options.hint));
  if (options.action) {
    const actions = el('div', 'scc-empty__actions');
    actions.appendChild(options.action);
    wrap.appendChild(actions);
  }
  return wrap;
}

/** Skeleton rows — loading a list should not swap the layout for a spinner. */
export function skeletonRows(count = 6): HTMLElement {
  const wrap = el('div', 'scc-skeleton');
  wrap.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < count; i++) {
    const row = el('div', 'scc-skeleton__row');
    row.style.setProperty('--scc-skeleton-w', `${88 - (i % 4) * 13}%`);
    wrap.appendChild(row);
  }
  return wrap;
}

export type RunState = CheckState | 'cancelled' | 'skipped';

// ── Run state ────────────────────────────────────────────────────────────────

const STATE_LABEL: Record<RunState, string> = {
  success: 'Passing',
  failure: 'Failing',
  pending: 'Running',
  cancelled: 'Cancelled',
  skipped: 'Skipped',
  none: 'No checks',
};

/** Status dot. */
export function stateDot(state: RunState, label?: string): HTMLElement {
  const dot = el('span', `scc-dot scc-dot--${state}`);
  dot.setAttribute('role', 'img');
  dot.setAttribute('aria-label', label ?? STATE_LABEL[state]);
  dot.title = label ?? STATE_LABEL[state];
  return dot;
}

export function stateLabel(state: RunState): string {
  return STATE_LABEL[state];
}

// ── Stats ────────────────────────────────────────────────────────────────────

/** Small mono chip: refs, shas, counts, labels. */
export function chip(text: string, variant?: string): HTMLElement {
  const node = el('span', 'scc-chip', text);
  if (variant) node.classList.add(`scc-chip--${variant}`);
  return node;
}

/** +12 −4 diff stat pair. Zero sides are omitted so the eye lands on the change. */
export function diffStat(additions: number, deletions: number): HTMLElement {
  const wrap = el('span', 'scc-diffstat');
  if (additions > 0) wrap.appendChild(el('span', 'scc-diffstat__add', `+${additions}`));
  if (deletions > 0) wrap.appendChild(el('span', 'scc-diffstat__del', `−${deletions}`));
  if (additions === 0 && deletions === 0) wrap.appendChild(el('span', 'scc-diffstat__none', '—'));
  return wrap;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// ── Time ─────────────────────────────────────────────────────────────────────

/** Compact relative time: 4m, 3h, 6d, 12w. Empty string for unparseable input. */
export function relativeTime(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const delta = Date.now() - ms;
  if (delta < MINUTE) return 'now';
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h`;
  if (delta < 7 * DAY) return `${Math.floor(delta / DAY)}d`;
  if (delta < 365 * DAY) return `${Math.floor(delta / (7 * DAY))}w`;
  return `${Math.floor(delta / (365 * DAY))}y`;
}

/** Duration between two ISO stamps, as 1m 04s. */
export function duration(startIso: string, endIso: string): string {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso) || Date.now();
  if (!Number.isFinite(start)) return '';
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

// ── Paths ────────────────────────────────────────────────────────────────────

/** Split `src/ui/thing.ts` into a dimmable directory and a bright filename. */
export function pathParts(filePath: string): { dir: string; name: string } {
  const normalized = filePath.replace(/\\/g, '/');
  const index = normalized.lastIndexOf('/');
  if (index < 0) return { dir: '', name: normalized };
  return { dir: normalized.slice(0, index + 1), name: normalized.slice(index + 1) };
}

/** Two-line path cell: directory dimmed, filename in full contrast. */
export function pathLabel(filePath: string): HTMLElement {
  const { dir, name } = pathParts(filePath);
  const wrap = el('span', 'scc-path');
  wrap.title = filePath;
  if (dir) wrap.appendChild(el('span', 'scc-path__dir', dir));
  wrap.appendChild(el('span', 'scc-path__name', name));
  return wrap;
}

// ── Navigation ───────────────────────────────────────────────────────────────

/** Arrow-key roving selection over a list of rows. */
export function listNavigator(options: {
  getRows: () => HTMLElement[];
  onActivate?: (row: HTMLElement, index: number) => void;
}): (event: KeyboardEvent) => boolean {
  return (event: KeyboardEvent): boolean => {
    const rows = options.getRows();
    if (rows.length === 0) return false;

    const active = document.activeElement;
    const current = rows.findIndex((row) => row === active || row.contains(active));

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      const next = current < 0 ? 0 : Math.min(rows.length - 1, Math.max(0, current + delta));
      rows[next]?.focus();
      rows[next]?.scrollIntoView({ block: 'nearest' });
      return true;
    }

    if ((event.key === 'Enter' || event.key === ' ') && current >= 0 && options.onActivate) {
      event.preventDefault();
      options.onActivate(rows[current]!, current);
      return true;
    }

    return false;
  };
}

/** Inline error strip for a failed operation inside a pane. */
export function errorStrip(message: string, retry?: () => void): HTMLElement {
  const wrap = el('div', 'scc-error');
  wrap.setAttribute('role', 'alert');
  wrap.innerHTML = iconHtml('statusFail', { className: 'scc-error__icon' });
  wrap.appendChild(el('p', 'scc-error__message', message));
  if (retry) {
    wrap.appendChild(
      button({ label: 'Retry', variant: 'ghost', onClick: () => retry() }),
    );
  }
  return wrap;
}
