let rowLabelCounter = 0;

export type SettingsRowOptions = {
  searchKey?: string;
  description?: string;
  id?: string;
};

type SettingsRowLabelParts = {
  label: HTMLDivElement;
  titleId: string;
};

// ── Shell ────────────────────────────────────────────────────────────────────

function buildSettingsRowLabel(
  labelText: string,
  options: SettingsRowOptions = {},
): SettingsRowLabelParts {
  const label = document.createElement('div');
  label.className = 'settings-row__label';

  const title = document.createElement('span');
  title.className = 'settings-row__title';
  title.textContent = labelText;
  const titleId = options.id
    ? `${options.id}-label`
    : `settings-row-label-${++rowLabelCounter}`;
  title.id = titleId;
  label.appendChild(title);

  if (options.description) {
    const desc = document.createElement('span');
    desc.className = 'settings-row__desc';
    desc.textContent = options.description;
    desc.id = `${titleId}-description`;
    label.appendChild(desc);
  }

  return { label, titleId };
}

/** Connect visible labels and helper text to each native form control. */
function connectSettingsRowControl(
  row: HTMLElement,
  control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
  titleId: string,
  description?: string,
): void {
  control.id ||= `${titleId}-control`;
  const title = row.querySelector<HTMLElement>('.settings-row__title');
  if (title) {
    const label = document.createElement('label');
    label.className = title.className;
    label.id = titleId;
    label.htmlFor = control.id;
    label.textContent = title.textContent;
    title.replaceWith(label);
  }
  control.setAttribute('aria-labelledby', titleId);
  if (description) control.setAttribute('aria-describedby', `${titleId}-description`);
}

function createSettingsRowShell(options: SettingsRowOptions = {}): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'settings-row';
  if (options.searchKey) {
    row.dataset.settingsSearchKey = options.searchKey;
  }
  return row;
}

export type SettingsSelectOption = {
  value: string;
  label: string;
};

export type SettingsSelectRowOptions = SettingsRowOptions & {
  select?: HTMLSelectElement;
  options?: SettingsSelectOption[];
  value?: string;
  name?: string;
  selectClassName?: string;
  disabled?: boolean;
  onChange?: (value: string) => void;
};

// ── Inputs ───────────────────────────────────────────────────────────────────

/** Label left, select right (`.settings-row` + `.settings-select`). */
export function createSettingsSelectRow(
  labelText: string,
  options: SettingsSelectRowOptions = {},
): { row: HTMLDivElement; select: HTMLSelectElement } {
  const row = createSettingsRowShell(options);
  const { label, titleId } = buildSettingsRowLabel(labelText, options);

  const control = document.createElement('div');
  control.className = 'settings-row__control';

  let select = options.select;
  if (!select) {
    select = document.createElement('select');
    select.className = options.selectClassName ?? 'settings-select';
    if (options.name) select.name = options.name;
    if (options.id) select.id = options.id;
    if (options.disabled) select.disabled = true;
    for (const opt of options.options ?? []) {
      const option = document.createElement('option');
      option.value = opt.value;
      option.textContent = opt.label;
      select.appendChild(option);
    }
  }

  select.classList.add('settings-select');
  if (options.value != null) select.value = options.value;
  select.setAttribute('aria-labelledby', titleId);

  if (options.onChange) {
    select.addEventListener('change', () => options.onChange!(select.value));
  }

  control.appendChild(select);
  row.append(label, control);
  connectSettingsRowControl(row, select, titleId, options.description);
  return { row, select };
}

export type SettingsInputRowOptions = SettingsRowOptions & {
  type?: string;
  input?: HTMLInputElement;
  value?: string;
  name?: string;
  placeholder?: string;
  min?: string;
  max?: string;
  step?: string;
  inputClassName?: string;
  disabled?: boolean;
  autocomplete?: AutoFill;
  spellcheck?: boolean;
  required?: boolean;
  onChange?: (value: string) => void;
};

/** Label left, input right; numeric types use mono via `.settings-input`. */
export function createSettingsInputRow(
  labelText: string,
  options: SettingsInputRowOptions = {},
): { row: HTMLDivElement; input: HTMLInputElement } {
  const row = createSettingsRowShell(options);
  const { label, titleId } = buildSettingsRowLabel(labelText, options);

  const control = document.createElement('div');
  control.className = 'settings-row__control';

  const input =
    options.input ??
    (() => {
      const el = document.createElement('input');
      el.type = options.type ?? 'text';
      el.className = options.inputClassName ?? 'settings-input';
      return el;
    })();

  if (!options.input) {
    input.type = options.type ?? 'text';
    input.className = options.inputClassName ?? 'settings-input';
  }
  input.classList.add('settings-input');
  if (options.name) input.name = options.name;
  if (options.id) input.id = options.id;
  if (options.value != null) input.value = options.value;
  if (options.placeholder) input.placeholder = options.placeholder;
  if (options.min != null) input.min = options.min;
  if (options.max != null) input.max = options.max;
  if (options.step != null) input.step = options.step;
  if (options.disabled) input.disabled = true;
  if (options.autocomplete != null) input.autocomplete = options.autocomplete;
  if (options.spellcheck != null) input.spellcheck = options.spellcheck;
  if (options.required) input.required = true;

  input.setAttribute('aria-labelledby', titleId);

  if (options.onChange) {
    input.addEventListener('input', () => options.onChange!(input.value));
    input.addEventListener('change', () => options.onChange!(input.value));
  }

  control.appendChild(input);
  row.append(label, control);
  connectSettingsRowControl(row, input, titleId, options.description);
  return { row, input };
}

export type SettingsTextareaRowOptions = SettingsRowOptions & {
  textarea?: HTMLTextAreaElement;
  value?: string;
  name?: string;
  placeholder?: string;
  rows?: number;
  textareaClassName?: string;
  disabled?: boolean;
  spellcheck?: boolean;
  onChange?: (value: string) => void;
};

/** Label left, textarea right (`.settings-textarea`). */
export function createSettingsTextareaRow(
  labelText: string,
  options: SettingsTextareaRowOptions = {},
): { row: HTMLDivElement; textarea: HTMLTextAreaElement } {
  const row = createSettingsRowShell(options);
  row.classList.add('settings-row--textarea');
  const { label, titleId } = buildSettingsRowLabel(labelText, options);

  const control = document.createElement('div');
  control.className = 'settings-row__control';

  const textarea =
    options.textarea ??
    (() => {
      const el = document.createElement('textarea');
      el.className = options.textareaClassName ?? 'settings-textarea';
      return el;
    })();

  if (!options.textarea) {
    textarea.className = options.textareaClassName ?? 'settings-textarea';
  }
  textarea.classList.add('settings-textarea');
  if (options.name) textarea.name = options.name;
  if (options.id) textarea.id = options.id;
  if (options.value != null) textarea.value = options.value;
  if (options.placeholder) textarea.placeholder = options.placeholder;
  if (options.rows != null) textarea.rows = options.rows;
  if (options.disabled) textarea.disabled = true;
  if (options.spellcheck != null) textarea.spellcheck = options.spellcheck;

  textarea.setAttribute('aria-labelledby', titleId);

  if (options.onChange) {
    textarea.addEventListener('input', () => options.onChange!(textarea.value));
    textarea.addEventListener('change', () => options.onChange!(textarea.value));
  }

  control.appendChild(textarea);
  row.append(label, control);
  connectSettingsRowControl(row, textarea, titleId, options.description);
  return { row, textarea };
}

export type SettingsRadioOption = {
  value: string;
  label: string;
  id?: string;
};

export type SettingsRadioRowOptions = SettingsRowOptions & {
  name: string;
  options: SettingsRadioOption[];
  value?: string;
  onChange?: (value: string) => void;
};

/** Segmented radio control (`.settings-segments` / `.settings-segment`). */
export function createSettingsRadioRow(
  labelText: string,
  options: SettingsRadioRowOptions,
): {
  row: HTMLDivElement;
  inputs: HTMLInputElement[];
  getValue: () => string;
  setValue: (value: string) => void;
} {
  const row = createSettingsRowShell(options);
  if (labelText) {
    row.appendChild(buildSettingsRowLabel(labelText, options).label);
  } else {
    row.classList.add('settings-row--control-only');
  }

  const control = document.createElement('div');
  control.className = 'settings-row__control';

  const segments = document.createElement('div');
  segments.className = 'settings-segments';
  segments.setAttribute('role', 'radiogroup');
  if (labelText) {
    const titleId = options.id
      ? `${options.id}-label`
      : row.querySelector('.settings-row__title')?.id;
    if (titleId) segments.setAttribute('aria-labelledby', titleId);
  }

  const inputs: HTMLInputElement[] = [];

  const syncActive = (): void => {
    for (const input of inputs) {
      input.closest('label')?.classList.toggle('is-active', input.checked);
    }
  };

  for (const opt of options.options) {
    const segment = document.createElement('label');
    segment.className = 'settings-segment';

    const input = document.createElement('input');
    input.type = 'radio';
    input.className = 'settings-segment__input';
    input.name = options.name;
    input.value = opt.value;
    if (opt.id) input.id = opt.id;
    if (options.value === opt.value) input.checked = true;

    const text = document.createElement('span');
    text.className = 'settings-segment__text';
    text.textContent = opt.label;

    segment.append(input, text);
    segments.appendChild(segment);
    inputs.push(input);

    input.addEventListener('change', () => {
      if (!input.checked) return;
      syncActive();
      options.onChange?.(input.value);
    });
  }

  control.appendChild(segments);
  row.appendChild(control);

  if (!inputs.some((input) => input.checked) && inputs[0]) {
    inputs[0].checked = true;
  }
  syncActive();

  const getValue = (): string => {
    const checked = inputs.find((input) => input.checked);
    return checked?.value ?? options.options[0]?.value ?? '';
  };

  const setValue = (value: string): void => {
    for (const input of inputs) {
      input.checked = input.value === value;
    }
    syncActive();
  };

  return { row, inputs, getValue, setValue };
}

export type SettingsActionSpec = {
  label: string;
  type?: 'button' | 'submit';
  variant?: 'default' | 'primary' | 'danger';
  id?: string;
  className?: string;
  disabled?: boolean;
  title?: string;
  dataset?: Record<string, string>;
  onClick?: () => void;
};

export type SettingsActionsRowOptions = {
  searchKey?: string;
  className?: string;
};

// ── Actions ──────────────────────────────────────────────────────────────────

/** Standard action button row (`.settings-actions`). */
export function createSettingsActionsRow(
  actions: SettingsActionSpec[],
  options: SettingsActionsRowOptions = {},
): HTMLDivElement {
  const row = document.createElement('div');
  row.className = ['settings-actions', options.className].filter(Boolean).join(' ');
  if (options.searchKey) {
    row.dataset.settingsSearchKey = options.searchKey;
  }

  for (const spec of actions) {
    const btn = document.createElement('button');
    btn.type = spec.type ?? 'button';
    btn.className = 'settings-action-btn';
    if (spec.variant === 'primary') btn.classList.add('settings-action-btn--primary');
    if (spec.variant === 'danger') btn.classList.add('settings-action-btn--mn-danger');
    if (spec.className) btn.classList.add(...spec.className.split(/\s+/).filter(Boolean));
    if (spec.id) btn.id = spec.id;
    if (spec.disabled) btn.disabled = true;
    if (spec.title) btn.title = spec.title;
    if (spec.dataset) {
      for (const [key, value] of Object.entries(spec.dataset)) {
        btn.dataset[key] = value;
      }
    }
    btn.textContent = spec.label;
    if (spec.onClick) {
      btn.addEventListener('click', spec.onClick);
    }
    row.appendChild(btn);
  }

  return row;
}

export type SettingsOfflineHintOptions = {
  id?: string;
  hidden?: boolean;
  searchKey?: string;
};

/** Unified offline / server-required banner (`.settings-server-banner`). */
export function appendSettingsOfflineHint(
  mount: HTMLElement,
  message: string,
  options: SettingsOfflineHintOptions = {},
): HTMLElement {
  const banner = document.createElement('p');
  banner.className = 'settings-server-banner';
  if (options.hidden) banner.classList.add('hidden');
  if (options.id) banner.id = options.id;
  if (options.searchKey) banner.dataset.settingsSearchKey = options.searchKey;
  banner.setAttribute('role', 'status');
  if (message.includes('<')) banner.innerHTML = message;
  else banner.textContent = message;
  mount.appendChild(banner);
  return banner;
}

export type SettingsDangerZoneOptions = {
  searchKey?: string;
};

/** Destructive or elevated-risk panel at the bottom of a section. */
export function appendSettingsDangerZone(
  mount: HTMLElement,
  title: string,
  body: HTMLElement | HTMLElement[],
  options: SettingsDangerZoneOptions = {},
): HTMLElement {
  const zone = document.createElement('section');
  zone.className = 'settings-danger-zone';
  if (options.searchKey) zone.dataset.settingsSearchKey = options.searchKey;

  const heading = document.createElement('h3');
  heading.className = 'settings-danger-zone__title';
  heading.textContent = title;
  zone.appendChild(heading);

  const content = document.createElement('div');
  content.className = 'settings-danger-zone__body';
  const nodes = Array.isArray(body) ? body : [body];
  for (const node of nodes) content.appendChild(node);
  zone.appendChild(content);

  mount.appendChild(zone);
  return zone;
}

export type SettingsKvEntry = {
  term: string;
  value: string | HTMLElement;
};

export type SettingsKvListOptions = {
  searchKey?: string;
  className?: string;
};

/** Definition list summary block (`.settings-kv`). */
export function createSettingsKvList(
  entries: SettingsKvEntry[],
  options: SettingsKvListOptions = {},
): HTMLDListElement {
  const list = document.createElement('dl');
  list.className = options.className ?? 'settings-kv';
  if (options.searchKey) list.dataset.settingsSearchKey = options.searchKey;

  for (const entry of entries) {
    const dt = document.createElement('dt');
    dt.className = 'settings-kv__term';
    dt.textContent = entry.term;
    const dd = document.createElement('dd');
    dd.className = 'settings-kv__value';
    if (typeof entry.value === 'string') {
      dd.textContent = entry.value;
    } else {
      dd.appendChild(entry.value);
    }
    list.append(dt, dd);
  }

  return list;
}
