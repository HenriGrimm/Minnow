/** Default-aware controls opt in with their actual persisted default, never their initial value. */
export function addPreferenceReset(
  row: HTMLElement,
  control: HTMLInputElement | HTMLSelectElement,
  defaultValue: string | boolean,
  label: string,
): void {
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'settings-inline-link settings-preference-reset';
  reset.textContent = 'Reset';
  reset.setAttribute('aria-label', `Reset ${label} to default`);
  const sync = () => {
    const value = typeof defaultValue === 'boolean'
      ? (control as HTMLInputElement).checked : control.value;
    row.dataset.preferenceModified = String(value !== defaultValue);
    reset.hidden = value === defaultValue;
    reset.disabled = control.disabled;
  };
  reset.addEventListener('click', () => {
    if (typeof defaultValue === 'boolean') (control as HTMLInputElement).checked = defaultValue;
    else control.value = defaultValue;
    control.dispatchEvent(new Event('change', { bubbles: true }));
  });
  control.addEventListener('change', sync);
  row.appendChild(reset);
  sync();
}

/** Use only on pages whose preference controls all provide default metadata. */
export function addModifiedPreferencesFilter(mount: HTMLElement): void {
  const toolbar = document.createElement('div');
  toolbar.className = 'settings-preference-filter';
  const label = document.createElement('label');
  const input = document.createElement('input');
  input.type = 'checkbox';
  label.append(input, ' Show modified only');
  const scope = document.createElement('span');
  scope.textContent = 'Applies to this device';
  toolbar.append(label, scope);
  mount.prepend(toolbar);
  const empty = document.createElement('p');
  empty.className = 'settings-field-hint';
  empty.setAttribute('role', 'status');
  empty.hidden = true;
  mount.appendChild(empty);
  const sync = () => {
    const rows = mount.querySelectorAll<HTMLElement>('[data-preference-modified]');
    let modified = 0;
    rows.forEach((row) => {
      const changed = row.dataset.preferenceModified === 'true';
      if (changed) modified++;
      row.hidden = input.checked && !changed;
    });
    mount.querySelectorAll<HTMLElement>('.settings-group').forEach((group) => {
      group.hidden = input.checked && !group.querySelector('[data-preference-modified="true"]');
    });
    empty.hidden = !input.checked || modified > 0;
    empty.textContent = 'These preferences are using their defaults.';
  };
  mount.addEventListener('change', sync);
  input.addEventListener('change', sync);
}
