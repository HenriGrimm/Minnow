/**
 * On/off switch. The control is a real checkbox with `role="switch"`, so forms,
 * labels and existing `change` bindings keep working.
 */

import '../../styles/components/switch.css';
import { addClassNames } from './internal';

export type SwitchSize = 'sm' | 'md';

export interface SwitchOptions {
  id?: string;
  name?: string;
  checked?: boolean;
  disabled?: boolean;
  /** Use when no visible label names the switch. */
  ariaLabel?: string;
  /** Id of the visible label element. */
  labelledBy?: string;
  /** Id of helper text. */
  describedBy?: string;
  /** Default `md`. */
  size?: SwitchSize;
  className?: string;
  onChange?: (checked: boolean) => void;
}

export function createSwitch(
  options: SwitchOptions = {},
): { root: HTMLLabelElement; input: HTMLInputElement } {
  const root = document.createElement('label');
  root.className = `mn-switch mn-switch--${options.size ?? 'md'}`;
  addClassNames(root, options.className);

  const input = document.createElement('input');
  input.type = 'checkbox';
  input.className = 'mn-switch__input';
  input.setAttribute('role', 'switch');
  if (options.id) input.id = options.id;
  if (options.name) input.name = options.name;
  if (options.checked) input.checked = true;
  if (options.disabled) input.disabled = true;
  if (options.ariaLabel) input.setAttribute('aria-label', options.ariaLabel);
  if (options.labelledBy) input.setAttribute('aria-labelledby', options.labelledBy);
  if (options.describedBy) input.setAttribute('aria-describedby', options.describedBy);

  const track = document.createElement('span');
  track.className = 'mn-switch__track';
  track.setAttribute('aria-hidden', 'true');
  const thumb = document.createElement('span');
  thumb.className = 'mn-switch__thumb';
  track.appendChild(thumb);

  root.append(input, track);

  const onChange = options.onChange;
  if (onChange) input.addEventListener('change', () => onChange(input.checked));

  return { root, input };
}
