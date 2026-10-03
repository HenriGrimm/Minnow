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

let selectedModelId = '';
let models: LmModelRecord[] = [];

export const modelPickStep: OnboardingStep = {
  id: 'model-pick',
  title: 'Pick your default model',
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
      el('p', 'mn-onboarding-step-desc', 'This model loads in the top bar for new chats.'),
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
    return () => abort.abort();
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

    if (models.length > 8) search.hidden = false;

    const renderRows = (filter: string) => {
      list.innerHTML = '';
      const q = filter.trim().toLowerCase();
      const rows = models.filter((m) => !q || m.id.toLowerCase().includes(q));
      rows.forEach((model) => {
        const row = el('button', 'mn-onboarding-model-row');
        row.type = 'button';
        row.dataset.modelId = model.id;
        if (model.id === selectedModelId) row.classList.add('is-selected');

        const name = el('span', 'mn-onboarding-model-row__name', model.id);
        row.appendChild(name);

        const badges = el('span', 'mn-onboarding-model-row__badges');
        if (model.type === 'vlm' || model.catalogVision) {
          badges.appendChild(el('span', 'mn-onboarding-chip', 'vision'));
        }
        row.appendChild(badges);

        row.addEventListener('click', () => {
          selectedModelId = model.id;
          actions.patchContext({ modelId: model.id, providerId: provider.id });
          actions.setPrimaryEnabled(true);
          list.querySelectorAll<HTMLButtonElement>('.mn-onboarding-model-row').forEach((btn) => {
            btn.classList.toggle('is-selected', btn.dataset.modelId === model.id);
          });
        });
        list.appendChild(row);
      });
    };

    search.addEventListener('input', () => renderRows(search.value));
    renderRows('');
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
