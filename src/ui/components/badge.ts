/**
 * Badges (read-only status and counts) and chips (selectable or removable
 * tokens such as filters and labels).
 *
 * Success, warning and danger tones are for status and measurement only
 * (DESIGN.md, Metric Color Rule). Use neutral or accent for everything else.
 */

import '../../styles/components/badge.css';
import { createIcon, type IconName } from '../icon';
import { createIconButton } from './button';
import { addClassNames, applyAppearance, type ComponentAppearance } from './internal';

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

export interface BadgeOptions {
  appearance?: ComponentAppearance;
  label: string;
  /** Default `neutral`. */
  tone?: BadgeTone;
  /** Default `md`. */
  size?: 'sm' | 'md';
  /** Leading status dot. */
  dot?: boolean;
  icon?: IconName;
  /** Monospace, tabular numbers: metrics and counts. */
  mono?: boolean;
  className?: string;
}

export interface ChipOptions {
  label: string;
  /** Default `neutral`. */
  tone?: BadgeTone;
  icon?: IconName;
  /** Makes the chip a toggle button. */
  onClick?: (event: MouseEvent) => void;
  selected?: boolean;
  /** Adds a remove button. */
  onRemove?: () => void;
  removeLabel?: string;
  disabled?: boolean;
  className?: string;
}

function appendContent(
  parent: HTMLElement,
  prefix: 'mn-badge' | 'mn-chip',
  label: string,
  icon: IconName | undefined,
): void {
  if (icon) parent.appendChild(createIcon(icon, { className: `${prefix}__icon` }));
  const text = document.createElement('span');
  text.className = `${prefix}__label`;
  text.textContent = label;
  parent.appendChild(text);
}

export function createBadge(options: BadgeOptions): HTMLSpanElement {
  const badge = document.createElement('span');
  badge.className = `mn-badge mn-badge--${options.tone ?? 'neutral'} mn-badge--${options.size ?? 'md'}`;
  applyAppearance(badge, options.appearance);
  if (options.mono) badge.classList.add('mn-badge--mono');
  addClassNames(badge, options.className);
  if (options.dot) {
    const dot = document.createElement('span');
    dot.className = 'mn-badge__dot';
    dot.setAttribute('aria-hidden', 'true');
    badge.appendChild(dot);
  }
  appendContent(badge, 'mn-badge', options.label, options.icon);
  return badge;
}

/**
 * A chip. When clickable, the main part is a toggle button; the remove button
 * sits beside it (never nested inside another button).
 */
export function createChip(options: ChipOptions): HTMLSpanElement {
  const chip = document.createElement('span');
  chip.className = `mn-chip mn-chip--${options.tone ?? 'neutral'}`;
  addClassNames(chip, options.className);

  const onClick = options.onClick;
  let main: HTMLElement;
  if (onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('aria-pressed', options.selected ? 'true' : 'false');
    if (options.disabled) button.disabled = true;
    button.addEventListener('click', (event) => {
      if (!button.disabled) onClick(event);
    });
    main = button;
  } else {
    main = document.createElement('span');
  }
  main.classList.add('mn-chip__main');
  appendContent(main, 'mn-chip', options.label, options.icon);
  chip.appendChild(main);
  chip.classList.toggle('is-selected', options.selected === true);

  const onRemove = options.onRemove;
  if (onRemove) {
    const remove = createIconButton({
      icon: 'close',
      label: options.removeLabel ?? `Remove ${options.label}`,
      size: 'sm',
      tooltip: false,
      disabled: options.disabled,
      className: 'mn-chip__remove',
      onClick: (event) => {
        event.stopPropagation();
        onRemove();
      },
    });
    chip.appendChild(remove);
  }
  return chip;
}

/** Update a clickable chip's selected state. */
export function setChipSelected(chip: HTMLElement, selected: boolean): void {
  chip.classList.toggle('is-selected', selected);
  chip.querySelector(':scope > button.mn-chip__main')?.setAttribute('aria-pressed', selected ? 'true' : 'false');
}
