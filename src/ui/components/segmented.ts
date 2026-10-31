/**
 * Segmented control: a small set of mutually exclusive options shown inline.
 * Behaves as a radio group (one Tab stop; arrow keys move and select).
 */

import '../../styles/components/segmented.css';
import { createIcon, type IconName } from '../icon';
import { addClassNames } from './internal';

export interface SegmentedOption {
  value: string;
  label: string;
  icon?: IconName;
  /** Hide the label visually (it stays the accessible name). */
  iconOnly?: boolean;
  disabled?: boolean;
}

export interface SegmentedControlOptions {
  options: SegmentedOption[];
  value?: string;
  ariaLabel: string;
  /** Default `md`. */
  size?: 'sm' | 'md';
  className?: string;
  onChange?: (value: string) => void;
}

export interface SegmentedControlHandle {
  root: HTMLDivElement;
  getValue(): string | null;
  setValue(value: string, options?: { silent?: boolean }): void;
  setDisabled(value: string, disabled: boolean): void;
}

export function createSegmentedControl(options: SegmentedControlOptions): SegmentedControlHandle {
  const root = document.createElement('div');
  root.className = `mn-segmented mn-segmented--${options.size ?? 'md'}`;
  root.setAttribute('role', 'radiogroup');
  root.setAttribute('aria-label', options.ariaLabel);
  addClassNames(root, options.className);

  const buttons = new Map<string, HTMLButtonElement>();
  let current: string | null = null;

  for (const spec of options.options) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'mn-segmented__option';
    button.setAttribute('role', 'radio');
    button.dataset.value = spec.value;
    if (spec.icon) button.appendChild(createIcon(spec.icon, { className: 'mn-segmented__icon' }));
    const label = document.createElement('span');
    label.className = spec.iconOnly ? 'mn-segmented__label visually-hidden' : 'mn-segmented__label';
    label.textContent = spec.label;
    button.appendChild(label);
    if (spec.disabled) button.disabled = true;
    button.addEventListener('click', () => select(spec.value, false));
    buttons.set(spec.value, button);
    root.appendChild(button);
  }

  const enabled = () => [...buttons.values()].filter((button) => !button.disabled);

  function sync(): void {
    const tabStop = (current != null && !buttons.get(current)?.disabled ? buttons.get(current) : null) ?? enabled()[0];
    for (const [value, button] of buttons) {
      const selected = value === current;
      button.setAttribute('aria-checked', selected ? 'true' : 'false');
      button.classList.toggle('is-selected', selected);
      button.tabIndex = button === tabStop ? 0 : -1;
    }
  }

  function select(value: string, silent: boolean): void {
    const button = buttons.get(value);
    if (!button || button.disabled || value === current) return;
    current = value;
    sync();
    if (!silent) options.onChange?.(value);
  }

  root.addEventListener('keydown', (event) => {
    const list = enabled();
    if (list.length === 0) return;
    const index = list.indexOf(document.activeElement as HTMLButtonElement);
    let next: HTMLButtonElement | undefined;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = list[(index + 1) % list.length];
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        next = list[(index - 1 + list.length) % list.length];
        break;
      case 'Home':
        next = list[0];
        break;
      case 'End':
        next = list[list.length - 1];
        break;
      default:
        return;
    }
    event.preventDefault();
    next.focus();
    select(next.dataset.value!, false);
  });

  if (options.value != null && buttons.has(options.value)) current = options.value;
  sync();

  return {
    root,
    getValue: () => current,
    setValue: (value, opts) => select(value, opts?.silent === true),
    setDisabled: (value, disabled) => {
      const button = buttons.get(value);
      if (!button) return;
      button.disabled = disabled;
      sync();
    },
  };
}
