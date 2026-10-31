/**
 * Form controls and the labelled field that wraps them. Selects stay native so
 * `dropdowns.css` and `installThemedSelects()` keep styling their popups.
 */

import '../../styles/components/field.css';
import { addAttributeToken, addClassNames, nextComponentId, removeAttributeToken } from './internal';

export type FieldSize = 'sm' | 'md' | 'lg';

interface ControlBaseOptions {
  id?: string;
  name?: string;
  /** Default `md` (32px). */
  size?: FieldSize;
  disabled?: boolean;
  invalid?: boolean;
  required?: boolean;
  /** Use when no visible label (or `createField`) names the control. */
  ariaLabel?: string;
  className?: string;
}

export interface TextInputOptions extends ControlBaseOptions {
  value?: string;
  placeholder?: string;
  type?: 'text' | 'search' | 'email' | 'url' | 'password' | 'number' | 'tel';
  autocomplete?: string;
  spellcheck?: boolean;
  onInput?: (value: string, event: Event) => void;
  onChange?: (value: string, event: Event) => void;
}

export interface TextareaOptions extends Omit<ControlBaseOptions, 'size'> {
  value?: string;
  placeholder?: string;
  /** Default 3. */
  rows?: number;
  /** Default `vertical`. */
  resize?: 'none' | 'vertical';
  spellcheck?: boolean;
  onInput?: (value: string, event: Event) => void;
  onChange?: (value: string, event: Event) => void;
}

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectOptions extends ControlBaseOptions {
  options: SelectOption[];
  value?: string;
  onChange?: (value: string, event: Event) => void;
}

export interface CheckboxOptions {
  label: string;
  id?: string;
  name?: string;
  checked?: boolean;
  disabled?: boolean;
  /** Muted helper line under the label. */
  description?: string;
  className?: string;
  onChange?: (checked: boolean) => void;
}

export interface FieldOptions {
  label: string;
  /** The input, select or textarea; or a wrapper that contains one. */
  control: HTMLElement;
  hint?: string;
  error?: string;
  required?: boolean;
  className?: string;
}

export interface FieldHandle {
  root: HTMLDivElement;
  label: HTMLLabelElement;
  hint: HTMLParagraphElement;
  error: HTMLParagraphElement;
  /** Show an error (sets `aria-invalid`) or clear it with `null`. */
  setError(message: string | null): void;
  setHint(message: string | null): void;
}

type FormControl = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

function applyBase(el: FormControl, options: ControlBaseOptions): void {
  if (options.id) el.id = options.id;
  if (options.name) el.name = options.name;
  if (options.disabled) el.disabled = true;
  if (options.required) el.required = true;
  if (options.invalid) el.setAttribute('aria-invalid', 'true');
  if (options.ariaLabel) el.setAttribute('aria-label', options.ariaLabel);
  addClassNames(el, options.className);
}

function bindValueEvents(
  el: HTMLInputElement | HTMLTextAreaElement,
  options: Pick<TextInputOptions, 'onInput' | 'onChange'>,
): void {
  const { onInput, onChange } = options;
  if (onInput) el.addEventListener('input', (event) => onInput(el.value, event));
  if (onChange) el.addEventListener('change', (event) => onChange(el.value, event));
}

export function createTextInput(options: TextInputOptions = {}): HTMLInputElement {
  const input = document.createElement('input');
  input.type = options.type ?? 'text';
  input.className = `mn-input mn-input--${options.size ?? 'md'}`;
  applyBase(input, options);
  if (options.value != null) input.value = options.value;
  if (options.placeholder) input.placeholder = options.placeholder;
  if (options.autocomplete) input.setAttribute('autocomplete', options.autocomplete);
  if (options.spellcheck != null) input.spellcheck = options.spellcheck;
  bindValueEvents(input, options);
  return input;
}

export function createTextarea(options: TextareaOptions = {}): HTMLTextAreaElement {
  const textarea = document.createElement('textarea');
  textarea.className = 'mn-input mn-input--multiline';
  if (options.resize === 'none') textarea.classList.add('mn-input--no-resize');
  applyBase(textarea, options);
  textarea.rows = options.rows ?? 3;
  if (options.value != null) textarea.value = options.value;
  if (options.placeholder) textarea.placeholder = options.placeholder;
  if (options.spellcheck != null) textarea.spellcheck = options.spellcheck;
  bindValueEvents(textarea, options);
  return textarea;
}

export function createSelect(options: SelectOptions): HTMLSelectElement {
  const select = document.createElement('select');
  select.className = `mn-select mn-select--${options.size ?? 'md'}`;
  applyBase(select, options);
  for (const spec of options.options) {
    const option = document.createElement('option');
    option.value = spec.value;
    option.textContent = spec.label;
    if (spec.disabled) option.disabled = true;
    select.appendChild(option);
  }
  if (options.value != null) select.value = options.value;
  const onChange = options.onChange;
  if (onChange) select.addEventListener('change', (event) => onChange(select.value, event));
  return select;
}

export function createCheckbox(
  options: CheckboxOptions,
): { root: HTMLLabelElement; input: HTMLInputElement } {
  const root = document.createElement('label');
  root.className = 'mn-checkbox';
  addClassNames(root, options.className);

  const input = document.createElement('input');
  input.type = 'checkbox';
  input.className = 'mn-checkbox__input';
  input.id = options.id ?? nextComponentId('checkbox');
  if (options.name) input.name = options.name;
  if (options.checked) input.checked = true;
  if (options.disabled) input.disabled = true;

  const text = document.createElement('span');
  text.className = 'mn-checkbox__text';
  const label = document.createElement('span');
  label.className = 'mn-checkbox__label';
  label.textContent = options.label;
  text.appendChild(label);
  if (options.description) {
    const description = document.createElement('span');
    description.className = 'mn-checkbox__description';
    description.id = `${input.id}-description`;
    description.textContent = options.description;
    input.setAttribute('aria-describedby', description.id);
    text.appendChild(description);
  }

  root.append(input, text);
  const onChange = options.onChange;
  if (onChange) input.addEventListener('change', () => onChange(input.checked));
  return { root, input };
}

function findControl(el: HTMLElement): FormControl | null {
  if (el.matches('input, select, textarea')) return el as FormControl;
  return el.querySelector<FormControl>('input, select, textarea');
}

/** Label, control, hint and error, wired for assistive technology. */
export function createField(options: FieldOptions): FieldHandle {
  const root = document.createElement('div');
  root.className = 'mn-field';
  addClassNames(root, options.className);

  const control = findControl(options.control);
  const controlId = control ? (control.id ||= nextComponentId('field')) : nextComponentId('field');

  const label = document.createElement('label');
  label.className = 'mn-field__label';
  label.htmlFor = controlId;
  label.textContent = options.label;
  if (options.required) {
    if (control) control.required = true;
    const marker = document.createElement('span');
    marker.className = 'mn-field__required';
    marker.setAttribute('aria-hidden', 'true');
    marker.textContent = '*';
    label.appendChild(marker);
  }

  const hint = document.createElement('p');
  hint.className = 'mn-field__hint';
  hint.id = `${controlId}-hint`;

  const error = document.createElement('p');
  error.className = 'mn-field__error';
  error.id = `${controlId}-error`;

  const setHint = (message: string | null) => {
    hint.textContent = message ?? '';
    hint.hidden = !message;
    if (!control) return;
    if (message) addAttributeToken(control, 'aria-describedby', hint.id);
    else removeAttributeToken(control, 'aria-describedby', hint.id);
  };

  const setError = (message: string | null) => {
    error.textContent = message ?? '';
    error.hidden = !message;
    root.classList.toggle('mn-field--invalid', Boolean(message));
    if (!control) return;
    if (message) {
      control.setAttribute('aria-invalid', 'true');
      addAttributeToken(control, 'aria-describedby', error.id);
    } else {
      control.removeAttribute('aria-invalid');
      removeAttributeToken(control, 'aria-describedby', error.id);
    }
  };

  root.append(label, options.control, hint, error);
  setHint(options.hint ?? null);
  setError(options.error ?? null);

  return { root, label, hint, error, setError, setHint };
}
