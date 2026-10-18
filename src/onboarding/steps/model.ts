/**
 * S3 — Default model pick with capability badges.
 */

import { listProviders } from '../../providers/store';
import { fetchModelsForProvider } from '../../providers/fetch-models';
import type { LmModelRecord } from '../../types';
import { el, renderStepHeader } from '../ui-helpers';
import type { OnboardingContext, OnboardingStep } from '../types';
import { recordStepProgress } from '../state-core';
import { encodeModelSelectKey } from '../../lib/model-select-key';
import { persistDefaultModelValue } from '../../ui/default-model';
import { mountAuxiliaryModelSelectCombobox, unmountAuxiliaryModelSelectCombobox } from '../../ui/model-select-picker';
import { formatModelLabel } from '../../lib/format-model-label';

let selectedModelId = '';
let models: LmModelRecord[] = [];

export const modelPickStep: OnboardingStep = {
  id: 'model-pick',
  title: 'Pick your chat model',
  canSkip: true,

  isApplicable(ctx) {
    return ctx.providerPath !== null && ctx.providerPath !== 'managed';
  },

  render(container, ctx, actions) {
    container.innerHTML = '';
    container.className = 'mn-onboarding-step';
    selectedModelId = '';
    const abort = new AbortController();

    renderStepHeader(container, modelPickStep, actions.stepIndex, actions.totalSteps);
    container.appendChild(
      el('p', 'mn-onboarding-step-desc', 'New chats start with this model. Change it any time in the composer.'),
    );

    const list = el('div', 'mn-onboarding-model-list');
    container.appendChild(list);

    const search = el('input', 'mn-onboarding-field') as HTMLInputElement;
    search.type = 'search';
    search.placeholder = 'Filter models';
    search.hidden = true;
    container.appendChild(search);

    actions.setPrimaryLabel('Continue');
    actions.setPrimaryEnabled(false);

    void loadModels(ctx, list, search, actions, abort.signal);
    return () => { abort.abort(); list.querySelectorAll<HTMLSelectElement>('select').forEach(unmountAuxiliaryModelSelectCombobox); };
  },

  async commit(ctx) {
    if (!selectedModelId || !ctx.providerId) return;
    await persistDefaultModelValue(encodeModelSelectKey(ctx.providerId, selectedModelId));
    ctx.state = recordStepProgress(ctx.state, 'model-pick', {
      done: true,
      data: { modelId: selectedModelId, providerId: ctx.providerId },
    });
    ctx.modelId = selectedModelId;
  },
};

async function loadModels(
  ctx: OnboardingContext,
  list: HTMLElement,
  search: HTMLInputElement,
  actions: { setPrimaryEnabled: (v: boolean) => void; patchContext: (p: Partial<OnboardingContext>) => void },
  signal: AbortSignal,
): Promise<void> {
  list.innerHTML = '';
  list.appendChild(el('p', 'mn-onboarding-muted', 'Loading models…'));

  try {
    const { providers } = await listProviders();
    if (signal.aborted) return;
    const provider = providers.find((p) => p.id === ctx.providerId);
    if (!provider) {
      list.innerHTML = '';
      list.appendChild(
        el('p', 'mn-onboarding-notice', 'No provider configured. Skip to continue, then add one in Settings.'),
      );
      actions.setPrimaryEnabled(true);
      return;
    }

    const loaded = await fetchModelsForProvider(provider, signal);
    if (signal.aborted) return;
    models = loaded;
    list.innerHTML = '';

    if (models.length === 0) {
      list.appendChild(el('p', 'mn-onboarding-notice', 'No models returned. Check your server, or skip for now.'));
      actions.setPrimaryEnabled(true);
      return;
    }

    selectedModelId = models.find(model => model.id === ctx.modelId)?.id ?? '';
    if (models.length === 1 || selectedModelId) {
      selectedModelId ||= models[0].id;
      actions.patchContext({ modelId: selectedModelId, providerId: provider.id });
      actions.setPrimaryEnabled(true);
    }

    search.hidden = true;
    const select = document.createElement('select');
    select.setAttribute('aria-label', 'Chat model');
    if (!selectedModelId) {
      const placeholder = document.createElement('option');
      placeholder.value = ''; placeholder.textContent = 'Choose a model'; placeholder.disabled = true;
      select.append(placeholder);
    }
    for (const model of models) {
      const option = document.createElement('option');
      option.value = model.id; option.textContent = formatModelLabel(model).optionText;
      option.dataset.providerId = provider.id; option.dataset.providerLabel = provider.label || provider.id;
      select.append(option);
    }
    select.value = selectedModelId;
    select.addEventListener('change', () => {
      selectedModelId = select.value;
      actions.patchContext({ modelId: select.value, providerId: provider.id });
      actions.setPrimaryEnabled(Boolean(select.value));
    });
    list.append(select);
    mountAuxiliaryModelSelectCombobox(select);

  } catch (err) {
    if (signal.aborted) return;
    list.innerHTML = '';
    list.appendChild(
      el(
        'p',
        'mn-onboarding-notice',
        err instanceof Error ? err.message : 'Could not load models',
      ),
    );
    actions.setPrimaryEnabled(true);
  }
}
