import { populateMultiProviderModelSelect } from '../api/models';
import { registerChromePopover, unregisterChromePopover } from './preview-electron-visibility';
import type { ForkOverrides } from '../chat/fork-from-run';
import { readGlobalSamplerForSend } from '../config/sampler-meta';
import { decodeModelSelectKey } from '../lib/model-select-key';
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
): Promise<ForkModelDialogResult | null> {
  return new Promise((resolve) => {
    closeModelSelectMenu();

    const backdrop = document.createElement('div');
    backdrop.className = 'fork-model-dialog__backdrop';
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

    const actions = document.createElement('div');
    actions.className = 'fork-model-dialog__actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'fork-model-dialog__btn fork-model-dialog__btn--ghost';
    cancelBtn.textContent = 'Cancel';
    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'fork-model-dialog__btn fork-model-dialog__btn--primary';
    okBtn.textContent = 'Fork';
    okBtn.disabled = true;

    const syncForkButton = (): void => {
      okBtn.disabled = decodeForkSelection(modelSelect.value) === null;
    };

    let closed = false;
    const close = (result: ForkModelDialogResult | null): void => {
      if (closed) return;
      closed = true;
      unregisterChromePopover();
      closeModelSelectMenu();
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
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
      });
    });

    backdrop.addEventListener('click', (ev) => {
      if (ev.target === backdrop) close(null);
    });

    modelSelect.addEventListener('change', syncForkButton);

    mountAuxiliaryModelSelectCombobox(modelSelect);

    actions.append(cancelBtn, okBtn);
    panel.append(title, modelField, actions);
    backdrop.appendChild(panel);
    document.body.appendChild(backdrop);
    registerChromePopover();
    document.addEventListener('keydown', onKey);

    void (async () => {
      await populateMultiProviderModelSelect(modelSelect, {
        selectedProviderId: initial.providerId,
        selectedModelId: initial.modelId,
        includeEmptyOption: false,
      });
      syncAuxiliaryModelSelectCombobox(modelSelect);
      syncForkButton();

      const picker = modelField.querySelector('.model-select-trigger') as HTMLButtonElement | null;
      if (picker && !picker.disabled) {
        picker.focus();
      } else {
        cancelBtn.focus();
      }
    })();
  });
}
