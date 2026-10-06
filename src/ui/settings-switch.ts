let switchLabelCounter = 0;

export type SettingsSwitchOptions = {
  id?: string;
  name?: string;
  checked?: boolean;
  disabled?: boolean;
  ariaLabel?: string;
  /** Scroll target for the settings global finder. */
  searchKey?: string;
  /** Optional muted helper under the row title. */
  description?: string;
  onChange?: (checked: boolean) => void;
};

// ── Create ───────────────────────────────────────────────────────────────────

/** Visual switch; underlying control remains a checkbox for forms and bindings. */
export function createSettingsSwitch(
  options: SettingsSwitchOptions = {},
): { root: HTMLLabelElement; input: HTMLInputElement } {
  const root = document.createElement('label');
  root.className = 'settings-switch';

  const input = document.createElement('input');
  input.type = 'checkbox';
  input.className = 'settings-switch__input';
  input.setAttribute('role', 'switch');
  if (options.id) input.id = options.id;
  if (options.name) input.name = options.name;
  if (options.checked) input.checked = true;
  if (options.disabled) input.disabled = true;
  if (options.ariaLabel) {
    input.setAttribute('aria-label', options.ariaLabel);
  }

  const track = document.createElement('span');
  track.className = 'settings-switch__track';
  const thumb = document.createElement('span');
  thumb.className = 'settings-switch__thumb';
  track.appendChild(thumb);

  root.appendChild(input);
  root.appendChild(track);

  if (options.onChange) {
    input.addEventListener('change', () => options.onChange!(input.checked));
  }

  return { root, input };
}

/** Label on the left, switch on the right (standard settings row). */
export function createSettingsToggleRow(
  labelText: string,
  options: SettingsSwitchOptions = {},
): { row: HTMLDivElement; input: HTMLInputElement } {
  const row = document.createElement('div');
  row.className = 'settings-toggle-row';
  if (options.searchKey) {
    row.dataset.settingsSearchKey = options.searchKey;
  }

  const label = document.createElement('span');
  label.className = 'settings-toggle-row__label';
  const title = document.createElement('label');
  title.className = 'settings-toggle-row__title';
  title.textContent = labelText;
  label.appendChild(title);
  if (options.description) {
    const desc = document.createElement('span');
    desc.className = 'settings-toggle-row__desc';
    desc.textContent = options.description;
    label.appendChild(desc);
  }

  const titleId = options.id
    ? `${options.id}-label`
    : `settings-switch-label-${++switchLabelCounter}`;
  title.id = titleId;

  const { root, input } = createSettingsSwitch(options);
  input.id ||= `${titleId}-control`;
  title.htmlFor = input.id;
  const description = label.querySelector<HTMLElement>('.settings-toggle-row__desc');
  if (description) {
    description.id = `${titleId}-description`;
    input.setAttribute('aria-describedby', description.id);
  }
  if (!options.ariaLabel) {
    input.setAttribute('aria-labelledby', titleId);
  }
  row.append(label, root);
  return { row, input };
}

// ── Legacy ───────────────────────────────────────────────────────────────────

/** Label text from a legacy `<label class="settings-toggle-row">` (span child or bare text). */
function readLegacyToggleRowLabel(parent: HTMLElement, input: HTMLInputElement): string {
  const bodyLabel = parent.querySelector(
    ':scope > .settings-toggle-row__body .settings-toggle-row__label',
  );
  if (bodyLabel?.textContent?.trim()) {
    return bodyLabel.textContent.trim();
  }
  const titleSpan = parent.querySelector(':scope > .settings-toggle-row__title');
  if (titleSpan?.textContent?.trim()) {
    return titleSpan.textContent.trim();
  }
  const spanLabel = parent.querySelector(':scope > span:not(.settings-switch__track)');
  if (spanLabel?.textContent?.trim()) {
    return spanLabel.textContent.trim();
  }
  const textParts: string[] = [];
  for (const node of parent.childNodes) {
    if (node.nodeType !== Node.TEXT_NODE) continue;
    const trimmed = node.textContent?.trim();
    if (trimmed) textParts.push(trimmed);
  }
  if (textParts.length > 0) return textParts.join(' ');
  return input.getAttribute('aria-label')?.trim() ?? '';
}

function readLegacyToggleRowDescription(parent: HTMLElement): string | undefined {
  const hint = parent.querySelector(
    ':scope > .settings-toggle-row__body .settings-field-hint',
  );
  const text = hint?.textContent?.trim();
  return text || undefined;
}

function copyInputState(from: HTMLInputElement, to: HTMLInputElement): void {
  for (const attr of ['id', 'name', 'checked', 'disabled'] as const) {
    if (attr === 'checked' || attr === 'disabled') {
      to[attr] = from[attr];
      continue;
    }
    const value = from.getAttribute(attr);
    if (value != null) to.setAttribute(attr, value);
  }
  const aria = from.getAttribute('aria-label');
  if (aria) to.setAttribute('aria-label', aria);
  for (const [key, value] of Object.entries(from.dataset)) {
    to.dataset[key] = value;
  }
}

// ── Upgrade ──────────────────────────────────────────────────────────────────

/** Replace a plain checkbox with switch chrome (keeps id and listeners if upgraded before bind). */
export function wrapCheckboxAsSwitch(input: HTMLInputElement): HTMLInputElement {
  if (input.classList.contains('settings-switch__input')) return input;

  const parent = input.parentElement;
  if (!parent) return input;

  const { root, input: switchInput } = createSettingsSwitch();
  copyInputState(input, switchInput);
  switchInput.setAttribute('role', 'switch');

  if (parent.tagName === 'LABEL' && parent.classList.contains('settings-toggle-row')) {
    const text = readLegacyToggleRowLabel(parent, switchInput);
    const row = createSettingsToggleRow(text, {
      id: input.id || undefined,
      searchKey: parent.dataset.settingsSearchKey,
      description: readLegacyToggleRowDescription(parent),
    });
    copyInputState(input, row.input);
    if (switchInput.getAttribute('aria-label')) {
      row.input.setAttribute('aria-label', switchInput.getAttribute('aria-label')!);
      row.input.removeAttribute('aria-labelledby');
    }
    parent.replaceWith(row.row);
    input.remove();
    return row.input;
  }

  if (parent.classList.contains('settings-mcp-toggle')) {
    parent.insertBefore(root, input);
    input.remove();
    return switchInput;
  }

  if (parent.classList.contains('settings-checkbox-option')) {
    parent.insertBefore(root, input);
    input.remove();
    return switchInput;
  }

  if (parent.tagName === 'LABEL' && parent.classList.contains('settings-theme-follow')) {
    const text = parent.textContent?.trim() || 'Follow system appearance';
    const row = createSettingsToggleRow(text, {});
    copyInputState(input, row.input);
    parent.replaceWith(row.row);
    input.remove();
    return row.input;
  }

  input.replaceWith(root);
  return switchInput;
}

/** Upgrade static checkboxes under the settings page (call once on init). */
export function upgradeSettingsCheckboxes(root: ParentNode = document): void {
  const scope =
    root instanceof Document
      ? root.getElementById('settingsView') ?? root.body
      : root;

  scope
    .querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]:not(.settings-switch__input)',
    )
    .forEach((input) => {
      if (input.closest('#benchmarkView')) return;
      wrapCheckboxAsSwitch(input);
    });
}
