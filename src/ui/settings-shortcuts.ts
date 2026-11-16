import '../styles/settings-shortcuts.css';
import { appConfirm } from './app-dialog';
import { createButton } from './components/button';
import { getInputBindingStore, inputId, inputLabel, recordShortcut, withInputBindingsPaused, type KeyInput, type ShortcutInput } from './input-bindings';
import { shortcutCatalog, type ShortcutEntry } from './shortcut-catalog';
import { disposeShortcutSettings, setShortcutSettingsCleanup } from './settings-shortcuts-lifecycle';
export { disposeShortcutSettings } from './settings-shortcuts-lifecycle';

export function renderShortcutSettings(mount: HTMLElement): void {
  disposeShortcutSettings();
  const store = getInputBindingStore();
  mount.replaceChildren();
  mount.classList.add('shortcut-settings');
  mount.dataset.settingsSearchKey = 'keyboard.shortcuts';
  const intro = document.createElement('p');
  intro.className = 'settings-help';
  intro.textContent = 'Remap a shortcut wherever it is used in Minnow. Focus still determines the action: for example, Ctrl+K opens Quick Edit on an editor selection and the palette elsewhere. Changes save automatically on this device.';
  const limits = document.createElement('p');
  limits.className = 'settings-help';
  limits.textContent = 'Record a keyboard key or chord, mouse button, wheel direction, gamepad button or stick direction. Gamepads must be connected and activated. Operating-system shortcuts, native text editing, terminal input and embedded web pages are not remapped. A shared key changes in all app contexts.';
  const search = document.createElement('input');
  search.type = 'search'; search.placeholder = 'Search shortcuts'; search.setAttribute('aria-label', 'Search shortcuts');
  const status = document.createElement('p');
  status.setAttribute('role', 'status'); status.className = 'settings-help'; status.textContent = store.error;
  const toolbar = document.createElement('div'); toolbar.className = 'shortcut-settings__toolbar';
  const list = document.createElement('div');
  let captureTarget: HTMLElement | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let acceptCapture: ((input: ShortcutInput) => void) | undefined;
  const button = (label: string, action: () => void) => {
    return createButton({ label, onClick: action });
  };
  const stop = () => { recordShortcut(); clearTimeout(timer); captureTarget?.removeAttribute('aria-pressed'); captureTarget = undefined; acceptCapture = undefined; };
  const capture = (control: HTMLButtonElement, accept: (input: ShortcutInput) => void) => {
    stop(); captureTarget = control; control.setAttribute('aria-pressed', 'true');
    acceptCapture = accept;
    status.textContent = 'Listening for input. Escape cancels. Recording stops after 15 seconds.';
    recordShortcut((input) => {
      stop(); control.focus();
      if (input.kind === 'key' && input.key === 'Escape' && !input.ctrl && !input.meta && !input.alt && !input.shift) { status.textContent = 'Recording canceled.'; return; }
      accept(input);
    });
    timer = setTimeout(() => { stop(); status.textContent = 'Recording timed out. Try again.'; }, 15000);
  };
  const save = (action: () => void) => {
    try { action(); status.textContent = 'Shortcuts saved.'; renderRows(); }
    catch (error) { status.textContent = `Not saved: ${String(error)}`; }
  };
  const configure = async (entry: ShortcutEntry, input: ShortcutInput | null, inText: boolean) => {
    const id = inputId(entry.target);
    const duplicate = input && store.bindings.find((r) => inputId(r.target) !== id && r.input && inputId(r.input) === inputId(input));
    const changesDefault = input?.kind === 'key' && inputId(input) !== id;
    const replacesPointer = input?.kind === 'mouse' || input?.kind === 'wheel';
    if (duplicate || changesDefault || replacesPointer) {
      const message = duplicate ? `${inputLabel(input)} already maps to ${inputLabel(duplicate.target)}. Replace that binding?`
        : `${inputLabel(input)} will run ${inputLabel(entry.target)} instead of its normal action throughout Minnow. Continue?`;
      if (!await withInputBindingsPaused(() => appConfirm(message))) return;
      if (disposed) return;
    }
    save(() => {
      const next = store.bindings.filter((r) => inputId(r.target) !== id && (!duplicate || inputId(r.target) !== inputId(duplicate.target)));
      // Replaced mappings stay disabled, rather than unexpectedly restoring a conflicting default.
      if (duplicate) next.push({ ...duplicate, input: null });
      next.push({ target: entry.target, input, inText }); store.save(next);
    });
  };
  const extra: ShortcutEntry[] = [];
  const entries = () => {
    const rows = [...shortcutCatalog(), ...extra];
    for (const r of store.bindings) if (!rows.some((e) => inputId(e.target) === inputId(r.target))) rows.push({ target: r.target, group: 'Other shortcuts', title: 'Custom target shortcut' });
    return rows;
  };
  const renderRows = () => {
    stop(); list.replaceChildren();
    let group = '';
    let count = 0;
    for (const entry of entries()) {
      const binding = store.bindings.find((r) => inputId(r.target) === inputId(entry.target));
      const allowInText = binding?.inText ?? (entry.target.ctrl || entry.target.meta || entry.target.alt || entry.target.key.length > 1);
      const current = binding ? binding.input : entry.target;
      if (!`${entry.title} ${entry.group} ${inputLabel(entry.target)} ${inputLabel(current)}`.toLowerCase().includes(search.value.toLowerCase())) continue;
      if (group !== entry.group) { group = entry.group; const h = document.createElement('h3'); h.textContent = group; list.append(h); }
      count++;
      const row = document.createElement('div'); row.className = 'shortcut-settings__row';
      const label = document.createElement('div'); label.className = 'shortcut-settings__label';
      const title = document.createElement('span'); title.textContent = entry.title;
      const hint = document.createElement('small'); hint.textContent = `Default: ${inputLabel(entry.target)}`;
      label.append(title, hint);
      const actions = document.createElement('div'); actions.className = 'shortcut-settings__actions';
      const record = button(inputLabel(current), () => capture(record, (input) => { void configure(entry, input, allowInText); }));
      record.setAttribute('aria-label', `Change ${entry.title}, ${inputLabel(entry.target)}; current ${inputLabel(current)}`);
      const disable = button('Disable', () => { void configure(entry, null, allowInText); }); disable.disabled = current === null;
      const reset = button('Reset', () => save(() => store.save(store.bindings.filter((r) => inputId(r.target) !== inputId(entry.target))))); reset.disabled = !binding;
      actions.append(record, disable, reset);
      if (binding?.input) {
        const textLabel = document.createElement('label'); textLabel.className = 'shortcut-settings__text';
        const check = document.createElement('input'); check.type = 'checkbox'; check.checked = binding.inText;
        check.onchange = () => save(() => store.save(store.bindings.map((r) => r === binding ? { ...r, inText: check.checked } : r)));
        textLabel.append(check, 'Allow unmodified input while typing'); actions.append(textLabel);
      }
      row.append(label, actions); list.append(row);
    }
    if (!count) { const empty = document.createElement('p'); empty.textContent = 'No matching shortcuts.'; list.append(empty); }
  };
  const add = button('Record another shortcut', () => capture(add, (input) => {
    if (input.kind !== 'key') { status.textContent = 'Record the original keyboard shortcut first, then choose its replacement input.'; return; }
    const existing = entries().find((r) => inputId(r.target) === inputId(input));
    if (!existing) extra.push({ target: input as KeyInput, group: 'Other shortcuts', title: 'Custom target shortcut' });
    search.value = inputLabel(input); renderRows(); status.textContent = 'Choose the shortcut button to record a replacement.';
  }));
  const resetAll = button('Reset all shortcuts', () => { void withInputBindingsPaused(() => appConfirm('Reset all custom shortcuts to their defaults?')).then((confirmed) => { if (confirmed && !disposed) save(() => store.save([])); }); });
  const cancel = button('Cancel recording', () => { stop(); status.textContent = 'Recording canceled.'; });
  cancel.dataset.shortcutRecordingControl = 'true';
  const escape = button('Use Escape', () => {
    const accept = acceptCapture;
    if (!accept) { status.textContent = 'Start recording a shortcut first.'; return; }
    stop(); accept({ kind: 'key', key: 'Escape', ctrl: false, meta: false, alt: false, shift: false });
  });
  escape.dataset.shortcutRecordingControl = 'true';
  toolbar.append(search, add, resetAll, cancel, escape);
  search.oninput = renderRows;
  const cancelOnNavigation = () => { stop(); };
  window.addEventListener('hashchange', cancelOnNavigation);
  window.addEventListener('blur', cancelOnNavigation);
  setShortcutSettingsCleanup(() => { disposed = true; stop(); window.removeEventListener('hashchange', cancelOnNavigation); window.removeEventListener('blur', cancelOnNavigation); });
  mount.append(intro, limits, toolbar, status, list); renderRows();
}
