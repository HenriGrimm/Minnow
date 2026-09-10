
import { CONTEXT_DOCUMENT_PRESETS } from '../chat/context-documents/catalog';
import {
  dedupeCustomPathsAgainstPresets,
  isValidContextDocumentPath,
  loadContextDocumentsSettings,
  saveContextDocumentsConfig,
  saveContextDocumentsInjectionDefault,
  type ContextDocumentsConfig,
} from '../chat/context-documents/config';
import { detectConfigServer } from '../config/storage-mode';
import { appendSettingsGroup } from './settings-layout';
import { appendSettingsOfflineHint } from './settings-controls';
import { createSettingsToggleRow } from './settings-switch';
import { syncComposerContextDocumentsFromActiveChat } from './composer-context-documents';

type StatusFn = (kind: 'ok' | 'err' | 'spin', message: string) => void;

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

async function persistDocuments(
  documents: ContextDocumentsConfig,
  setStatus: StatusFn,
): Promise<boolean> {
  try {
    const ok = await saveContextDocumentsConfig(documents);
    if (!ok) {
      setStatus('err', 'Could not save context documents settings');
      return false;
    }
    const mode = await detectConfigServer();
    setStatus(
      'ok',
      mode === 'server'
        ? 'Context documents saved'
        : 'Saved locally — open Minnow to persist to disk',
    );
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Save failed';
    setStatus('err', message);
    return false;
  }
}

function renderPresetList(
  host: HTMLElement,
  documents: ContextDocumentsConfig,
  onChange: (next: ContextDocumentsConfig) => void,
): void {
  const stack = el('div', 'settings-field-stack');
  stack.dataset.settingsSearchKey = 'agents.injection.contextDocuments.presets';

  const labelId = 'settingsContextDocumentsPresetsLabel';
  const label = el('span', 'settings-field-stack__label', 'Included files');
  label.id = labelId;
  stack.appendChild(label);

  const list = el('div', 'settings-checklist settings-context-documents-checklist');
  list.setAttribute('role', 'group');
  list.setAttribute('aria-labelledby', labelId);

  for (const preset of CONTEXT_DOCUMENT_PRESETS) {
    const row = el('label', 'settings-checklist__option settings-checklist__option--stacked');

    const input = el('input') as HTMLInputElement;
    input.type = 'checkbox';
    input.checked = documents.enabledPresets.includes(preset.id);
    input.addEventListener('change', () => {
      const enabled = new Set(documents.enabledPresets);
      if (input.checked) {
        enabled.add(preset.id);
      } else {
        enabled.delete(preset.id);
      }
      onChange({ ...documents, enabledPresets: [...enabled] });
    });

    const text = el('span', 'settings-context-documents-checklist__text');
    text.appendChild(el('span', 'settings-checklist__label-text', preset.label));
    text.appendChild(el('span', 'settings-context-documents-checklist__desc', preset.description));

    row.append(input, text);
    list.appendChild(row);
  }

  stack.appendChild(list);
  host.appendChild(stack);
}

function renderCustomPaths(
  host: HTMLElement,
  documents: ContextDocumentsConfig,
  onChange: (next: ContextDocumentsConfig) => void,
): void {
  const stack = el('div', 'settings-field-stack settings-context-documents-custom');
  stack.dataset.settingsSearchKey = 'agents.injection.contextDocuments.custom';

  const labelId = 'settingsContextDocumentsCustomLabel';
  const label = el('span', 'settings-field-stack__label', 'Custom paths');
  label.id = labelId;
  stack.appendChild(label);

  const hint = el(
    'p',
    'field-hint settings-context-documents-custom__hint',
    'Workspace-relative paths only. Missing files are skipped when you send.',
  );
  stack.appendChild(hint);

  const list = el('div', 'settings-context-documents-custom__list');
  list.setAttribute('role', 'group');
  list.setAttribute('aria-labelledby', labelId);

  const paths = dedupeCustomPathsAgainstPresets(documents.customPaths);

  const renderRows = (): void => {
    list.replaceChildren();
    if (paths.length === 0) {
      list.appendChild(
        el('p', 'settings-context-documents-custom__empty', 'No custom paths yet.'),
      );
    }
    for (let i = 0; i < paths.length; i += 1) {
      const row = el('div', 'settings-context-documents-custom__row');

      const input = el('input') as HTMLInputElement;
      input.type = 'text';
      input.className = 'settings-input';
      input.value = paths[i];
      input.placeholder = 'docs/CONTRIBUTING.md';
      input.setAttribute('aria-label', `Custom path ${i + 1}`);
      input.addEventListener('change', () => {
        paths[i] = input.value.trim();
        onChange({ ...documents, customPaths: [...paths] });
      });

      const removeBtn = el('button', 'settings-inline-btn settings-inline-btn--danger', 'Remove');
      removeBtn.type = 'button';
      removeBtn.addEventListener('click', () => {
        paths.splice(i, 1);
        onChange({ ...documents, customPaths: [...paths] });
        renderRows();
      });

      row.append(input, removeBtn);
      list.appendChild(row);
    }
  };

  renderRows();
  stack.appendChild(list);

  const addBtn = el('button', 'settings-inline-btn settings-context-documents-custom__add', 'Add path');
  addBtn.type = 'button';
  addBtn.dataset.settingsSearchKey = 'agents.injection.contextDocuments.addPath';
  addBtn.addEventListener('click', () => {
    paths.push('');
    onChange({ ...documents, customPaths: [...paths] });
    renderRows();
    const lastInput = list.querySelector<HTMLInputElement>('.settings-context-documents-custom__row .settings-input');
    lastInput?.focus();
  });
  stack.appendChild(addBtn);

  host.appendChild(stack);
}

/** Workspace context documents block for Settings → Agents → Injection. */
export async function renderContextDocumentsInjectionSection(
  mount: HTMLElement,
  setStatus: StatusFn,
): Promise<void> {
  const serverUp = await detectConfigServer();
  if (!serverUp) {
    appendSettingsOfflineHint(
      mount,
      'Open Minnow to persist context document settings to <code>~/.minnow/config.json</code>.',
      { searchKey: 'agents.injection.contextDocuments.offline' },
    );
  }

  const { injectionDefault, documents: initial } = await loadContextDocumentsSettings();
  let documents = initial;

  const groupBody = appendSettingsGroup(
    mount,
    'Workspace context documents',
    'Attach selected project files to the first message of each chat so the model starts with your repo context.',
    'agents.injection.contextDocuments',
    { emphasis: true },
  );

  const { row: defaultRow, input: defaultInput } = createSettingsToggleRow(
    'Inject context documents by default',
    {
      id: 'settingsContextDocumentsInjectionDefault',
      checked: injectionDefault,
      searchKey: 'agents.injection.contextDocuments.default',
      description: 'Override per chat from the composer control.',
      onChange: (checked) => {
        void (async () => {
          const ok = await saveContextDocumentsInjectionDefault(checked);
          if (!ok) {
            defaultInput.checked = injectionDefault;
            setStatus('err', 'Could not save default');
            return;
          }
          setStatus('ok', 'Default saved');
          void syncComposerContextDocumentsFromActiveChat();
        })();
      },
    },
  );
  groupBody.appendChild(defaultRow);

  const onDocumentsChange = (next: ContextDocumentsConfig): void => {
    const sanitized: ContextDocumentsConfig = {
      ...next,
      customPaths: dedupeCustomPathsAgainstPresets(
        next.customPaths.filter((p) => isValidContextDocumentPath(p)),
      ),
    };
    documents = sanitized;
    void persistDocuments(sanitized, setStatus).then((saved) => {
      if (saved) void syncComposerContextDocumentsFromActiveChat();
    });
  };

  const panel = el('div', 'settings-context-documents-panel');
  renderPresetList(panel, documents, onDocumentsChange);
  renderCustomPaths(panel, documents, onDocumentsChange);
  groupBody.appendChild(panel);
}
