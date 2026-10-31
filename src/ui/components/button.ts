/**
 * Buttons. Every action control in the app should come from here instead of a
 * surface-specific `*-btn` class.
 */

import '../../styles/components/button.css';
import { createIcon, type IconName } from '../icon';
import { addClassNames } from './internal';
import { attachTooltip, getTooltipText, setTooltip } from './tooltip';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonOptions {
  label?: string;
  /** Icon before the label. */
  icon?: IconName;
  /** Icon after the label (chevrons, external links). */
  iconEnd?: IconName;
  /** Default `secondary`. */
  variant?: ButtonVariant;
  /** Default `md` (32px). */
  size?: ButtonSize;
  /** Default `button`, so a button inside a form never submits by accident. */
  type?: 'button' | 'submit' | 'reset';
  disabled?: boolean;
  /** Makes it a toggle button (`aria-pressed`). */
  pressed?: boolean;
  /** Full width of its container. */
  block?: boolean;
  ariaLabel?: string;
  tooltip?: string;
  className?: string;
  onClick?: (event: MouseEvent) => void;
}

export interface IconButtonOptions
  extends Omit<ButtonOptions, 'label' | 'icon' | 'iconEnd' | 'ariaLabel' | 'tooltip'> {
  icon: IconName;
  /** Accessible name; also shown as the tooltip. */
  label: string;
  /** `false` when a visible label nearby already says it; a string to show different text. */
  tooltip?: boolean | string;
  /** Default `ghost`. */
  variant?: ButtonVariant;
}

function buttonIcon(name: IconName, end: boolean): HTMLElement {
  return createIcon(name, { className: end ? 'mn-btn__icon mn-btn__icon--end' : 'mn-btn__icon' });
}

export function createButton(options: ButtonOptions = {}): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = options.type ?? 'button';
  button.className = `mn-btn mn-btn--${options.variant ?? 'secondary'} mn-btn--${options.size ?? 'md'}`;
  if (options.block) button.classList.add('mn-btn--block');
  addClassNames(button, options.className);

  if (options.icon) button.appendChild(buttonIcon(options.icon, false));
  if (options.label) {
    const label = document.createElement('span');
    label.className = 'mn-btn__label';
    label.textContent = options.label;
    button.appendChild(label);
  }
  if (options.iconEnd) button.appendChild(buttonIcon(options.iconEnd, true));
  if (!options.label && (options.icon || options.iconEnd)) button.classList.add('mn-btn--icon');

  if (options.ariaLabel) button.setAttribute('aria-label', options.ariaLabel);
  if (options.disabled) button.disabled = true;
  if (options.pressed !== undefined) setButtonPressed(button, options.pressed);
  if (options.tooltip) attachTooltip(button, options.tooltip);

  const onClick = options.onClick;
  if (onClick) {
    button.addEventListener('click', (event) => {
      if (button.disabled || button.getAttribute('aria-busy') === 'true') return;
      onClick(event);
    });
  }
  return button;
}

/** Square icon-only button. The label is required: it names the button and fills its tooltip. */
export function createIconButton(options: IconButtonOptions): HTMLButtonElement {
  const { tooltip = true, label, ...rest } = options;
  const button = createButton({
    ...rest,
    variant: options.variant ?? 'ghost',
    ariaLabel: label,
  });
  if (tooltip !== false) attachTooltip(button, typeof tooltip === 'string' ? tooltip : label);
  return button;
}

/** Disable a button and show a spinner while work runs; restores the prior disabled state. */
export function setButtonBusy(button: HTMLButtonElement, busy: boolean): void {
  const isBusy = button.getAttribute('aria-busy') === 'true';
  if (busy === isBusy) return;
  if (busy) {
    button.dataset.mnBusyWasDisabled = String(button.disabled);
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.classList.add('mn-btn--busy');
    return;
  }
  button.disabled = button.dataset.mnBusyWasDisabled === 'true';
  delete button.dataset.mnBusyWasDisabled;
  button.removeAttribute('aria-busy');
  button.classList.remove('mn-btn--busy');
}

export function setButtonPressed(button: HTMLButtonElement, pressed: boolean): void {
  button.setAttribute('aria-pressed', pressed ? 'true' : 'false');
}

/** Change the visible label, or for icon buttons the accessible name and tooltip. */
export function setButtonLabel(button: HTMLButtonElement, label: string): void {
  const labelEl = button.querySelector<HTMLElement>(':scope > .mn-btn__label');
  if (labelEl) {
    labelEl.textContent = label;
    return;
  }
  button.setAttribute('aria-label', label);
  if (getTooltipText(button) !== null) setTooltip(button, label);
}
