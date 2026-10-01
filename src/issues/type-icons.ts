/**
 * Issue type and status icons — defaults, shared picker catalog, and chip rendering.
 * Uses Flaticon Uicons (solid-rounded fi-sr-* and regular-rounded fi-rr-*).
 */

import type { TaxonomyItem } from './taxonomy';

/** Uicons class token (without the base `fi` class). */
export type IssueTypeIconClass = `fi-sr-${string}` | `fi-rr-${string}`;

export const ISSUE_TYPE_ICON_RE = /^fi-(?:rr|sr)-[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Built-in type ids mapped to their default glyphs. */
export const DEFAULT_ISSUE_TYPE_ICONS = {
  bug: 'fi-sr-bug',
  task: 'fi-sr-list-check',
  idea: 'fi-sr-bulb',
  note: 'fi-sr-edit',
  feature: 'fi-sr-rocket',
  improvement: 'fi-sr-sparkles',
} as const satisfies Record<string, IssueTypeIconClass>;

/** Built-in type chip colors (Settings picker + list/peek chips). */
export const DEFAULT_ISSUE_TYPE_COLORS: Record<string, string> = {
  bug: 'var(--mn-danger)',
  task: 'var(--mn-accent)',
  idea: 'var(--mn-warning)',
  note: 'var(--mn-fg-muted)',
  feature: 'var(--mn-label-fig)',
  improvement: 'var(--mn-label-kelp)',
};

/** Built-in priority ids mapped to signal glyphs for menus and form pickers. */
export const DEFAULT_ISSUE_PRIORITY_ICONS = {
  urgent: 'fi-sr-signal-alt',
  high: 'fi-sr-signal-bars-good',
  medium: 'fi-sr-signal-bars-fair',
  low: 'fi-sr-signal-bars-weak',
  none: 'fi-rr-minus',
} as const satisfies Record<string, IssueTypeIconClass>;

/** Built-in status ids mapped to their default workflow glyphs. */
export const DEFAULT_ISSUE_STATUS_ICONS = {
  triage: 'fi-rr-inbox',
  backlog: 'fi-sr-box',
  todo: 'fi-sr-clipboard-list',
  planned: 'fi-sr-calendar',
  in_progress: 'fi-sr-bolt',
  review: 'fi-rr-search',
  done: 'fi-rr-check-circle',
  canceled: 'fi-rr-cross-circle',
} as const satisfies Record<string, IssueTypeIconClass>;

/**
 * Curated icons for Settings → Issues.
 * Types and statuses share this grid; workflow glyphs sit at the end.
 */
export const ISSUE_TYPE_ICON_PICKER: readonly IssueTypeIconClass[] = [
  'fi-sr-bug',
  'fi-sr-list-check',
  'fi-sr-bulb',
  'fi-sr-edit',
  'fi-sr-hammer',
  'fi-sr-wrench-simple',
  'fi-sr-band-aid',
  'fi-sr-flask',
  'fi-sr-code-branch',
  'fi-sr-terminal',
  'fi-sr-rocket',
  'fi-sr-sparkles',
  'fi-sr-star',
  'fi-sr-flag',
  'fi-sr-tags',
  'fi-sr-bookmark',
  'fi-sr-box',
  'fi-sr-layers',
  'fi-sr-puzzle-piece',
  'fi-sr-shield',
  'fi-sr-brain',
  'fi-sr-bolt',
  'fi-sr-clipboard-list',
  'fi-sr-note-sticky',
  'fi-sr-document',
  'fi-sr-folder',
  'fi-sr-calendar',
  'fi-sr-clock',
  'fi-sr-users',
  'fi-rr-inbox',
  'fi-rr-search',
  'fi-rr-check-circle',
  'fi-rr-cross-circle',
  'fi-rr-clock',
  'fi-rr-play',
] as const;

const PICKER_SET = new Set<string>(ISSUE_TYPE_ICON_PICKER);

/** True when the icon class is in the settings picker catalog. */
export function isIssueTypeIconClass(value: string): value is IssueTypeIconClass {
  return ISSUE_TYPE_ICON_RE.test(value) && PICKER_SET.has(value);
}

function resolveCatalogIcon(
  id: string,
  item: TaxonomyItem | undefined,
  defaults: Record<string, IssueTypeIconClass>,
  fallback: IssueTypeIconClass = 'fi-sr-box',
): IssueTypeIconClass {
  const stored = item?.icon?.trim();
  if (stored && isIssueTypeIconClass(stored)) return stored;
  return defaults[id] ?? fallback;
}

/** Resolve the glyph for a taxonomy type (stored icon, built-in default, or fallback). */
export function resolveIssueTypeIcon(typeId: string, item?: TaxonomyItem): IssueTypeIconClass {
  return resolveCatalogIcon(typeId, item, DEFAULT_ISSUE_TYPE_ICONS);
}

/** Resolve chip color: stored value, built-in default, or undefined (neutral grey). */
export function resolveIssueTypeColor(typeId: string, item?: TaxonomyItem): string | undefined {
  const stored = item?.color?.trim();
  if (stored) return stored;
  return DEFAULT_ISSUE_TYPE_COLORS[typeId];
}

/** Resolve the glyph for a taxonomy status (stored icon, built-in default, or fallback). */
export function resolveIssueStatusIcon(statusId: string, item?: TaxonomyItem): IssueTypeIconClass {
  return resolveCatalogIcon(statusId, item, DEFAULT_ISSUE_STATUS_ICONS);
}

/** Resolve the glyph for a taxonomy priority (built-in default or fallback). */
export function resolveIssuePriorityIcon(priorityId: string, item?: TaxonomyItem): IssueTypeIconClass {
  return resolveCatalogIcon(priorityId, item, DEFAULT_ISSUE_PRIORITY_ICONS, 'fi-rr-minus');
}

/** Create a Uicons `<i>` element for an issue type or status glyph. */
export function createIssueTypeIconElement(
  iconClass: IssueTypeIconClass,
  options: { className?: string; size?: number } = {},
): HTMLElement {
  const el = document.createElement('i');
  const parts = ['fi', iconClass, 'icon-svg'];
  if (options.className) parts.push(options.className);
  el.className = parts.join(' ');
  el.setAttribute('aria-hidden', 'true');
  if (options.size != null) el.style.setProperty('--mn-icon-size', `${options.size}px`);
  return el;
}

/** Build a type badge (icon inside a tinted chip). */
export function createIssueTypeChip(
  typeId: string,
  item?: TaxonomyItem,
  options: { labeled?: boolean; className?: string } = {},
): HTMLElement {
  const chip = document.createElement('span');
  const extra = options.className ? ` ${options.className}` : '';
  chip.className = `issues-type-chip issues-type-chip--${typeId}${options.labeled ? '' : ' issues-row__type'}${extra}`;
  const label = item?.label ?? `${typeId} (unknown)`;
  chip.title = label;
  const color = resolveIssueTypeColor(typeId, item);
  if (color) chip.style.setProperty('--issues-chip-color', color);
  chip.classList.toggle('is-unknown', !item);
  chip.appendChild(
    createIssueTypeIconElement(resolveIssueTypeIcon(typeId, item), {
      className: 'issues-type-chip__icon',
      size: 14,
    }),
  );
  if (options.labeled) {
    const text = document.createElement('span');
    text.className = 'issues-type-chip__label';
    text.textContent = label;
    chip.appendChild(text);
  }
  return chip;
}

/** Build a priority pill (glyph beside the label). */
export function createIssuePriorityChip(
  priorityId: string,
  item?: TaxonomyItem,
  options: { className?: string; withIcon?: boolean } = {},
): HTMLElement {
  const chip = document.createElement('span');
  const extra = options.className ? ` ${options.className}` : '';
  chip.className = `issues-priority-chip issues-priority-chip--${priorityId}${extra}`;
  const label = item?.label ?? (priorityId === 'none' ? 'None' : priorityId);
  chip.title = label;
  if (item?.color) chip.style.setProperty('--issues-chip-color', item.color);
  chip.classList.toggle('is-unknown', !item);
  if (options.withIcon !== false) {
    chip.appendChild(
      createIssueTypeIconElement(resolveIssuePriorityIcon(priorityId, item), {
        className: 'issues-priority-chip__icon',
        size: 12,
      }),
    );
  }
  const text = document.createElement('span');
  text.className = 'issues-priority-chip__label';
  text.textContent = label;
  chip.appendChild(text);
  return chip;
}

/** Build a status pill (glyph beside the label). */
export function createIssueStatusChip(
  statusId: string,
  item?: TaxonomyItem,
  options: { className?: string } = {},
): HTMLElement {
  const chip = document.createElement('span');
  const extra = options.className ? ` ${options.className}` : '';
  chip.className = `issues-status-chip issues-status-chip--${statusId}${extra}`;
  const label = item?.label ?? `${statusId.replace(/_/g, ' ')} (unknown)`;
  chip.title = label;
  if (item?.color) chip.style.setProperty('--issues-chip-color', item.color);
  chip.classList.toggle('is-unknown', !item);
  chip.appendChild(
    createIssueTypeIconElement(resolveIssueStatusIcon(statusId, item), {
      className: 'issues-status-chip__icon',
      size: 12,
    }),
  );
  const text = document.createElement('span');
  text.className = 'issues-status-chip__label';
  text.textContent = label;
  chip.appendChild(text);
  return chip;
}
