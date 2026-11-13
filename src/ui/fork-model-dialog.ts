import { populateMultiProviderModelSelect } from '../api/models';
import { markPreviewOccluder, unmarkPreviewOccluder } from './preview-occlusion';
import type { ForkOverrides } from '../chat/fork-from-run';
import { readGlobalSamplerForSend } from '../config/sampler-meta';
import { decodeModelSelectKey } from '../lib/model-select-key';
import { createIcon } from './icon';
import {
  closeModelSelectMenu,
  mountAuxiliaryModelSelectCombobox,
  syncAuxiliaryModelSelectCombobox,
} from './model-select-picker';

export interface ForkModelDialogResult {
  providerId: string;
  modelId: string;
  temperature: number;
  maxTokens: number;
  carry?: 'full' | 'summary';
}

function readSamplerFromDom(): { temperature: number; maxTokens: number } {
  const global = readGlobalSamplerForSend();
  return {
    temperature: global.preset.temperature ?? 0.7,
    maxTokens: global.maxTokens,
  };
}

function decodeForkSelection(value: string): { providerId: string; modelId: string } | null {
  return decodeModelSelectKey(value.trim());
}

/** Modal dialog; resolves null when cancelled. */
export function openForkModelDialog(
  initial: ForkOverrides & { providerId?: string; modelId?: string },
  thread?: { title: string; allowFull: boolean },
): Promise<ForkModelDialogResult | null> {
  return new Promise((resolve) => {
    closeModelSelectMenu();
    const opener = document.activeElement;

    const backdrop = document.createElement('div');
    backdrop.className = 'fork-model-dialog__backdrop';
    backdrop.classList.toggle('fork-model-dialog__backdrop--thread', Boolean(thread));
    backdrop.setAttribute('role', 'presentation');

    const panel = document.createElement('div');
    panel.className = 'fork-model-dialog';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', 'forkModelDialogTitle');

    const title = document.createElement('h2');
    title.id = 'forkModelDialogTitle';
    title.className = 'fork-model-dialog__title';
    title.textContent = 'Fork with different model';
    const subtitle = document.createElement('p');
    subtitle.className = 'fork-model-dialog__subtitle';
    if (thread) subtitle.textContent = `Start a new thread from “${thread.title}”. The original stays as it is.`;

    const modelField = document.createElement('div');
    modelField.className = 'settings-field fork-model-dialog__model-field';
    const modelLabel = document.createElement('label');
    modelLabel.className = 'settings-field-label';
    modelLabel.htmlFor = 'forkModelDialogModel';
    modelLabel.textContent = 'Model';
    const modelSelect = document.createElement('select');
    modelSelect.id = 'forkModelDialogModel';
    modelSelect.setAttribute('aria-label', 'Model');
    modelSelect.innerHTML = '<option value="">Loading models…</option>';

    modelField.append(modelLabel, modelSelect);
    const modelChoices = document.createElement('div');
    modelChoices.className = 'fork-model-dialog__choices';
    modelChoices.setAttribute('role', 'radiogroup');
    modelChoices.setAttribute('aria-label', 'Model');
    modelChoices.hidden = true;

    const actions = document.createElement('div');
    actions.className = 'fork-model-dialog__actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'fork-model-dialog__btn fork-model-dialog__btn--ghost';
    cancelBtn.textContent = 'Cancel';
    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'fork-model-dialog__btn fork-model-dialog__btn--primary';
    if (thread) okBtn.append(createIcon('gitBranch', { size: 14 }));
    okBtn.append('Fork');
    okBtn.disabled = true;

    const syncForkButton = (): void => {
      okBtn.disabled = decodeForkSelection(modelSelect.value) === null;
    };

    const carryRow = document.createElement('fieldset');
    carryRow.className = 'fork-model-dialog__carry';
    let carry: 'full' | 'summary' = thread?.allowFull ? 'full' : 'summary';
    if (thread) {
      const legend = document.createElement('legend');
      legend.textContent = 'Carry over';
      carryRow.append(legend);
      for (const [value, label] of [['full', 'Full history'], ['summary', 'Compacted summary']] as const) {
        const option = document.createElement('label');
        const input = document.createElement('input');
        input.type = 'radio';
        input.name = 'fork-context';
        input.value = value;
        input.checked = carry === value;
        input.disabled = value === 'full' && !thread.allowFull;
        input.addEventListener('change', () => { if (input.checked) carry = value; });
        option.append(input, label);
        carryRow.append(option);
      }
    }

    let closed = false;
    const request = new AbortController();
    const close = (result: ForkModelDialogResult | null): void => {
      if (closed) return;
      closed = true;
      request.abort();
      closeModelSelectMenu();
      unmarkPreviewOccluder(backdrop);
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
      resolve(result);
    };

    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key !== 'Escape') return;
      if (panel.querySelector('.model-select-inner.is-open')) {
        closeModelSelectMenu();
        return;
      }
      close(null);
    };

    cancelBtn.addEventListener('click', () => close(null));
    okBtn.addEventListener('click', () => {
      const decoded = decodeForkSelection(modelSelect.value);
      if (!decoded) return;
      const sampler = readSamplerFromDom();
      close({
        providerId: decoded.providerId,
        modelId: decoded.modelId,
        temperature: initial.temperature ?? sampler.temperature,
        maxTokens: initial.maxTokens ?? sampler.maxTokens,
        ...(thread ? { carry } : {}),
      });
    });

    backdrop.addEventListener('click', (ev) => {
      if (ev.target === backdrop) close(null);
    });

    modelSelect.addEventListener('change', syncForkButton);

    mountAuxiliaryModelSelectCombobox(modelSelect);

    actions.append(cancelBtn, okBtn);
    panel.append(title);
    if (thread) panel.append(subtitle);
    panel.append(modelField);
    if (thread) panel.append(modelChoices, carryRow);
    panel.append(actions);
    backdrop.appendChild(panel);
    document.body.appendChild(backdrop);
    markPreviewOccluder(backdrop, 'dialog');
    document.addEventListener('keydown', onKey);

    void (async () => {
      await populateMultiProviderModelSelect(modelSelect, {
        selectedProviderId: initial.providerId,
        selectedModelId: initial.modelId,
        includeEmptyOption: false,
        signal: request.signal,
      });
      if (closed) return;
      const models = [...modelSelect.options].filter(option => !option.disabled && decodeForkSelection(option.value));
      if (thread && models.length && models.length <= 8) {
        for (const model of models) {
          const row = document.createElement('label');
          const radio = document.createElement('input');
          radio.type = 'radio';
          radio.name = 'fork-model';
          radio.checked = model.selected;
          radio.addEventListener('change', () => {
            if (!radio.checked) return;
            modelSelect.value = model.value;
            syncForkButton();
          });
          const text = document.createElement('span');
          const name = document.createElement('span');
          name.textContent = model.dataset.displayName ?? model.label;
          const provider = document.createElement('small');
          provider.textContent = model.closest('optgroup')?.label ?? '';
          text.append(name, provider);
          row.append(radio, text);
          const value = decodeForkSelection(model.value);
          if (value?.modelId === initial.modelId && value?.providerId === initial.providerId) {
            const current = document.createElement('small');
            current.className = 'fork-model-dialog__current';
            current.textContent = 'Current';
            row.append(current);
          }
          modelChoices.append(row);
        }
        modelField.hidden = true;
        modelChoices.hidden = false;
        syncForkButton();
        modelChoices.querySelector<HTMLInputElement>('input:checked, input')?.focus();
        return;
      }
      syncAuxiliaryModelSelectCombobox(modelSelect);
      syncForkButton();

      const picker = modelField.querySelector('.model-select-trigger') as HTMLButtonElement | null;
      if (picker && !picker.disabled) {
        picker.focus();
      } else {
        cancelBtn.focus();
      }
    })().catch(() => {
      if (!closed) {
        modelSelect.replaceChildren(new Option('Could not load models', ''));
        syncAuxiliaryModelSelectCombobox(modelSelect);
        cancelBtn.focus();
      }
    });
  });
}
