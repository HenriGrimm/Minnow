import {
  loadEditorIntentModeConfig,
  saveEditorIntentModeConfig,
  type EditorIntentModeConfig,
} from '../config/editor-intent-mode';
import { appendSettingsGroup } from './settings-layout';
import {
  appendProviderModelFields,
  fillModelSelect,
  fillProviderSelect,
} from './settings-model-binding';
import { createSettingsToggleRow } from './settings-switch';
import { setStatus } from './status';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function kbdKey(label: string): HTMLElement {
  return el('kbd', 'settings-editor-kbd', label);
}

function appendShortcutRow(list: HTMLElement, term: string, keys: string[]): void {
  list.append(el('dt', 'settings-kv__term', term));
  const dd = el('dd', 'settings-kv__value');
  keys.forEach((key, index) => {
    if (index > 0) dd.append(document.createTextNode('+'));
    dd.append(kbdKey(key));
  });
  list.append(dd);
}

function appendNumberSetting(
  mount: HTMLElement,
  label: string,
  id: string,
  value: number,
  min: number,
  max: number,
  step: number,
  suffix: string,
  onSave: (n: number) => void,
): void {
  const kv = el('dl', 'settings-kv settings-editor-debounce');
  kv.append(el('dt', 'settings-kv__term', label));
  const dd = el('dd', 'settings-kv__value');
  const wrap = el('span', 'settings-kv-input-wrap settings-editor-debounce__control');
  const input = document.createElement('input');
  input.type = 'number';
  input.id = id;
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.className = 'settings-select settings-kv-input';
  input.setAttribute('aria-label', label);
  wrap.append(input, el('span', 'settings-kv-suffix', suffix));
  dd.append(wrap);
  kv.append(dd);
  input.addEventListener('change', () => {
    const raw = Number(input.value);
    const n = Number.isFinite(raw)
      ? Math.min(max, Math.max(min, Math.round(raw)))
      : value;
    input.value = String(n);
    onSave(n);
  });
  mount.append(kv);
}

function appendSigilSetting(
  mount: HTMLElement,
  config: EditorIntentModeConfig,
  refresh: () => void,
): void {
  const kv = el('dl', 'settings-kv settings-editor-debounce');
  kv.append(el('dt', 'settings-kv__term', 'Trigger prefix'));
  const dd = el('dd', 'settings-kv__value');
  const wrap = el('span', 'settings-kv-input-wrap settings-editor-debounce__control');
  const input = document.createElement('input');
  input.type = 'text';
  input.id = 'settingsIntentSigil';
  input.value = config.sigil;
  input.placeholder = 'none — detect prose';
  input.className = 'settings-select settings-kv-input';
  input.setAttribute('aria-label', 'Intent trigger prefix');
  wrap.append(input);
  dd.append(wrap);
  kv.append(dd);
  input.addEventListener('change', () => {
    const sigil = input.value.trim();
    input.value = sigil;
    void saveEditorIntentModeConfig({ sigil }).then(() => {
      refresh();
    });
  });
  mount.append(kv);
}

function appendModelPin(
  mount: HTMLElement,
  config: EditorIntentModeConfig,
  refresh: () => void,
): void {
  const pinned = Boolean(config.providerId && config.modelId);

  const sharedRadio = document.createElement('input');
  sharedRadio.type = 'radio';
  sharedRadio.name = 'editorIntentModelSource';
  sharedRadio.id = 'editorIntentModelSourceShared';
  sharedRadio.checked = !pinned;

  const pinRadio = document.createElement('input');
  pinRadio.type = 'radio';
  pinRadio.name = 'editorIntentModelSource';
  pinRadio.id = 'editorIntentModelSourcePin';
  pinRadio.checked = pinned;

  const sourceRow = el('div', 'settings-editor-source-radios');
  const sharedLabel = el('label', 'settings-inline-radio');
  sharedLabel.htmlFor = sharedRadio.id;
  sharedLabel.append(sharedRadio, document.createTextNode(' Use inline completion model'));
  const pinLabel = el('label', 'settings-inline-radio');
  pinLabel.htmlFor = pinRadio.id;
  pinLabel.append(pinRadio, document.createTextNode(' Pin provider and model'));
  sourceRow.append(sharedLabel, pinLabel);
  mount.append(sourceRow);

  const panel = el('div', 'settings-editor-model-panel');
  panel.hidden = !pinned;
  const grid = el('div', 'settings-editor-model-grid settings-routing-row__selects');
  const { providerSelect, modelSelect } = appendProviderModelFields(
    grid,
    { provider: 'settingsIntentProvider', model: 'settingsIntentModel' },
    { provider: 'Provider', model: 'Model' },
    'inline',
  );
  panel.append(grid);
  mount.append(panel);

  void (async () => {
    await fillProviderSelect(providerSelect, config.providerId);
    await fillModelSelect(
      modelSelect,
      config.providerId || providerSelect.value,
      config.modelId,
      { includeEmptyOption: false },
    );
  })();

  const persistPin = (): void => {
    const providerId = providerSelect.value.trim();
    const modelId = modelSelect.value.trim();
    if (!providerId || !modelId) return;
    void saveEditorIntentModeConfig({ providerId, modelId }).then(() => {
      refresh();
    });
  };

  sharedRadio.addEventListener('change', () => {
    if (!sharedRadio.checked) return;
    panel.hidden = true;
    void saveEditorIntentModeConfig({ providerId: '', modelId: '' }).then(() => {
      refresh();
    });
  });

  pinRadio.addEventListener('change', () => {
    if (!pinRadio.checked) return;
    panel.hidden = false;
    persistPin();
  });

  providerSelect.addEventListener('change', () => {
    void fillModelSelect(modelSelect, providerSelect.value, '', {
      includeEmptyOption: false,
    }).then(persistPin);
  });

  modelSelect.addEventListener('change', persistPin);
}

/** Append Intent mode settings group into an existing Editor settings mount. */
export async function appendEditorIntentSettings(
  mount: HTMLElement,
  refresh: () => void,
): Promise<void> {
  const config = await loadEditorIntentModeConfig();
  renderIntentSettingsGroup(mount, config, refresh);
}

function renderIntentSettingsGroup(
  mount: HTMLElement,
  config: EditorIntentModeConfig,
  refresh: () => void,
): void {
  const group = appendSettingsGroup(
    mount,
    'Intent mode',
    'Write plain intent on a line and idle — a proposal appears below it. Tab accepts, Esc dismisses, and Ctrl+Z undoes an accepted proposal.',
  );

  const { row: defaultRow } = createSettingsToggleRow('Enable by default in new files', {
    checked: config.enabledByDefault,
    ariaLabel: 'Enable Intent mode by default when opening files',
    onChange: async (enabled) => {
      await saveEditorIntentModeConfig({ enabledByDefault: enabled });
      refresh();
    },
  });
  group.append(defaultRow);

  const shortcuts = el('dl', 'settings-kv settings-editor-shortcuts');
  appendShortcutRow(shortcuts, 'Accept proposal', ['Tab']);
  appendShortcutRow(shortcuts, 'Dismiss proposal', ['Esc']);
  appendShortcutRow(shortcuts, 'Force resolve on this line', ['Ctrl', 'Enter']);
  appendShortcutRow(shortcuts, 'Toggle Intent mode', ['Ctrl', 'I']);
  group.append(shortcuts);

  appendNumberSetting(
    group,
    'Idle pause before proposing',
    'settingsIntentDebounceMs',
    config.debounceMs,
    100,
    2000,
    50,
    'ms',
    (ms) => {
      void saveEditorIntentModeConfig({ debounceMs: ms }).then(() => {
        refresh();
      });
    },
  );

  appendSigilSetting(group, config, refresh);
  group.append(
    el(
      'p',
      'settings-group__lead',
      'With no prefix, lines that read as plain English are detected automatically. Set a prefix (e.g. “??”) to trigger only on lines that start with it.',
    ),
  );

  appendNumberSetting(
    group,
    'Max tokens',
    'settingsIntentMaxTokens',
    config.maxTokens,
    128,
    4096,
    64,
    'tokens',
    (n) => {
      void saveEditorIntentModeConfig({ maxTokens: n }).then(() => {
        refresh();
      });
    },
  );

  appendModelPin(group, config, refresh);
}
