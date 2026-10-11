/**

 * S2b — Managed models: hardware-aware install, download, and serve.

 */

import { fetchHardware } from '../../models/hardware-client';
import { modelProducerLogoSvg } from '../../providers/model-producer';

import { el, createStatusPill, renderStepHeader } from '../ui-helpers';

import {

  listModelsForHardware,

  pickRecommendedModel,

  runManagedModelSetup,
  runExistingModelSetup,

  type ManagedSetupProgress,

} from '../managed-setup';

import type { ModelFitResult } from '../../models/types';

import type { HardwareSnapshot } from '../../models/types';

import type { OnboardingContext, OnboardingStep } from '../types';

import { recordStepProgress } from '../state-core';
import { mountManagedStorage } from '../managed-storage';
import { encodeModelSelectKey } from '../../lib/model-select-key';
import { persistDefaultModelValue } from '../../ui/default-model';

const FIT_BADGE_CLASS: Record<string, string> = {

  perfect: 'mn-onboarding-fit-badge--perfect',

  good: 'mn-onboarding-fit-badge--good',

  marginal: 'mn-onboarding-fit-badge--marginal',

  too_tight: 'mn-onboarding-fit-badge--tight',

};

let recommended: ModelFitResult | null = null;

let selectedModel: ModelFitResult | null = null;

let availableModels: ModelFitResult[] = [];

let hardware: HardwareSnapshot | null = null;

let setupDone = false;

let setupError = '';

let activeProgress: ManagedSetupProgress | null = null;

let installing = false;

function formatHardware(hw: HardwareSnapshot): string {

  const gpu = hw.gpuName ? `${hw.gpuName} · ${hw.gpuVramGb ?? '?'} GB VRAM` : 'CPU only';

  return `${hw.cpuName} · ${hw.totalRamGb} GB RAM · ${gpu}`;

}

function shortModelName(name: string): string {

  return name.includes('/') ? (name.split('/').pop() ?? name) : name;

}

function formatModelMeta(row: ModelFitResult): string {

  return `${row.params_b}B · ${row.quant} · ${row.size_gb} GB · ~${row.speed_tps} tok/s`;

}

function renderProgressBar(host: HTMLElement, percent: number): void {

  host.replaceChildren();

  const track = el('div', 'mn-onboarding-progress-track');

  const fill = el('div', 'mn-onboarding-progress-fill');

  fill.style.width = `${Math.min(100, Math.max(0, percent))}%`;

  track.appendChild(fill);

  host.appendChild(track);

}

function modelRowKey(row: ModelFitResult): string {

  return `${row.name}\0${row.quant}`;

}

/** Toggle selection styling without rebuilding rows (keeps list scroll position). */

function syncModelRowSelection(list: HTMLElement): void {

  const key = selectedModel ? modelRowKey(selectedModel) : '';

  list.querySelectorAll<HTMLButtonElement>('.mn-onboarding-model-row').forEach((button) => {

    button.classList.toggle('is-selected', button.dataset.modelKey === key);

  });

}

function renderModelRows(

  list: HTMLElement,

  models: ModelFitResult[],

  onSelect: (row: ModelFitResult) => void,

): void {

  list.replaceChildren();

  if (!models.length) {

    list.appendChild(el('p', 'mn-onboarding-muted', 'No models matched this filter.'));

    return;

  }

  for (const row of models) {

    const button = el('button', 'mn-onboarding-model-row');

    button.type = 'button';

    button.dataset.modelKey = modelRowKey(row);

    if (selectedModel?.name === row.name && selectedModel?.quant === row.quant) {

      button.classList.add('is-selected');

    }

    const main = el('div', 'mn-onboarding-managed-model-row__main');

    const nameLine = el('div', 'mn-onboarding-model-row__name-line');
    const logoSvg = modelProducerLogoSvg(row.name);
    if (logoSvg) {
      const logo = document.createElement('span');
      logo.className = 'model-producer-logo';
      logo.setAttribute('aria-hidden', 'true');
      logo.innerHTML = logoSvg;
      nameLine.appendChild(logo);
    }
    nameLine.appendChild(el('span', 'mn-onboarding-model-row__name', shortModelName(row.name)));
    main.appendChild(nameLine);

    main.appendChild(el('span', 'mn-onboarding-managed-model-row__meta', formatModelMeta(row)));

    button.appendChild(main);

    const badges = el('span', 'mn-onboarding-model-row__badges');

    const fitClass = FIT_BADGE_CLASS[row.fit_level] ?? '';

    badges.appendChild(

      el('span', `mn-onboarding-fit-badge ${fitClass}`, row.fit_level.replace('_', ' ')),

    );

    if (recommended?.name === row.name && recommended?.quant === row.quant) {

      badges.appendChild(el('span', 'mn-onboarding-chip', 'recommended'));

    }

    button.appendChild(badges);

    button.addEventListener('click', () => onSelect(row));

    list.appendChild(button);

  }

}

export const providerManagedStep: OnboardingStep = {

  id: 'provider-managed',

  title: 'Managed models',

  canSkip: true,

  isApplicable(ctx) {

    return ctx.providerPath === 'managed';

  },

  render(container, ctx, actions) {
    let active = true;
    if (!installing) {
      setupDone = Boolean(ctx.state.steps['provider-managed']?.done && ctx.providerId && ctx.modelId);
      setupError = '';
      activeProgress = setupDone ? { phase: 'done', percent: 100, message: 'Your model is ready.' } : null;
    }

    container.innerHTML = '';

    container.className = 'mn-onboarding-step';

    renderStepHeader(container, providerManagedStep, actions.stepIndex, actions.totalSteps);

    if (!ctx.serverAvailable) {

      container.appendChild(

        el(

          'p',

          'mn-onboarding-notice',

          'Local installs need Minnow running locally. You can finish theme and permissions now, then run setup again later.',

        ),

      );

      actions.setPrimaryEnabled(true);

      actions.setPrimaryLabel('Continue');

      return;

    }

    container.appendChild(

      el(

        'p',

        'mn-onboarding-step-desc',

        'Use a model you already have, or download one that fits your hardware. Minnow handles the local runtime.',

      ),

    );

    const storage = mountManagedStorage(container, async (model) => {
      if (installing) return;
      installing = true;
      setupDone = false;
      setupError = '';
      refreshUi();
      const result = await runExistingModelSetup(model, (progress) => {
        activeProgress = progress;
        refreshUi();
      });
      installing = false;
      setupDone = result.ok;
      setupError = result.error || '';
      if (active && result.ok) {
        ctx.providerId = result.providerId ?? null;
        ctx.modelId = result.modelId ?? null;
        actions.patchContext({ providerId: ctx.providerId, modelId: ctx.modelId });
      }
      refreshUi();
    });

    const hwCard = el('div', 'mn-onboarding-info-card');

    const hwLine = el('p', 'mn-onboarding-hardware-line', 'Scanning hardware…');

    hwCard.appendChild(hwLine);

    container.appendChild(hwCard);

    const pickerHost = el('div', 'mn-onboarding-managed-picker hidden');

    pickerHost.appendChild(el('h3', 'mn-onboarding-subtitle', 'Choose a model'));

    pickerHost.appendChild(

      el(

        'p',

        'mn-onboarding-muted',

        'Ranked for your hardware. Tighter fits may run slower.',

      ),

    );

    const search = el('input', 'mn-onboarding-field') as HTMLInputElement;

    search.type = 'search';

    search.placeholder = 'Filter models';

    search.hidden = true;

    pickerHost.appendChild(search);

    const modelList = el('div', 'mn-onboarding-model-list');

    pickerHost.appendChild(modelList);

    container.appendChild(pickerHost);

    const statusRow = el('div', 'mn-onboarding-status-row');

    const statusPill = createStatusPill('pending', 'Ready');

    statusRow.appendChild(statusPill);

    container.appendChild(statusRow);

    const progressHost = el('div', 'mn-onboarding-managed-progress hidden');

    const progressLabel = el('p', 'mn-onboarding-muted', '');

    const progressBarHost = el('div', 'mn-onboarding-managed-progress__bar');

    progressHost.append(progressLabel, progressBarHost);

    container.appendChild(progressHost);

    const installBtn = el('button', 'mn-onboarding-secondary-btn', 'Install and start');

    installBtn.type = 'button';

    installBtn.disabled = true;

    container.appendChild(installBtn);

    const selectModel = (row: ModelFitResult) => {

      if (installing || setupDone) return;

      selectedModel = row;

      syncModelRowSelection(modelList);

      installBtn.disabled = false;

    };

    const refreshPicker = async (filter = '') => {

      if (!hardware || !active) return;

      availableModels = await listModelsForHardware(hardware, {

        limit: 50,

        fitOnly: false,

        search: filter.trim() || undefined,

      });

      if (!active) return;
      renderModelRows(modelList, availableModels, selectModel);

    };

    const refreshUi = () => {
      if (!active) return;
      storage.setBusy(installing || setupDone);

      if (hardware) {

        hwLine.textContent = formatHardware(hardware);

        pickerHost.classList.remove('hidden');

      }

      if (selectedModel) {

        installBtn.disabled = installing || setupDone;

      }

      if (activeProgress) {

        progressHost.classList.remove('hidden');

        progressLabel.textContent = activeProgress.message;

        renderProgressBar(progressBarHost, activeProgress.percent);

        if (activeProgress.phase === 'error') {

          statusPill.className = 'mn-onboarding-status mn-onboarding-status--err';

          statusPill.textContent = activeProgress.error || 'Failed';

        } else if (activeProgress.phase === 'done' || setupDone) {

          statusPill.className = 'mn-onboarding-status mn-onboarding-status--ok';

          statusPill.textContent = 'Running';

        } else if (installing) {

          statusPill.className = 'mn-onboarding-status mn-onboarding-status--pending';

          statusPill.textContent = 'Working…';

        }

      }

      installBtn.hidden = setupDone || installing;

      search.disabled = installing || setupDone;

      modelList.querySelectorAll('button').forEach((btn) => {

        (btn as HTMLButtonElement).disabled = installing || setupDone;

      });

      actions.setPrimaryEnabled(true);

      actions.setPrimaryLabel(setupDone ? 'Continue' : 'Skip for now');

    };

    search.addEventListener('input', () => void refreshPicker(search.value));

    void (async () => {

      try {

        hardware = await fetchHardware({ fresh: true });
        if (!active) return;

        recommended = await pickRecommendedModel(hardware);
        if (!active) return;

        selectedModel = recommended;

        availableModels = await listModelsForHardware(hardware, { limit: 50, fitOnly: false });
        if (!active) return;

        if (!recommended && availableModels.length === 0) {

          setupError = 'No models found in the catalog.';

          statusPill.className = 'mn-onboarding-status mn-onboarding-status--err';

          statusPill.textContent = setupError;

        } else if (!selectedModel && availableModels.length > 0) {

          selectedModel = availableModels[0];

        }

        if (availableModels.length > 8) search.hidden = false;

        renderModelRows(modelList, availableModels, selectModel);

      } catch (err) {

        setupError = err instanceof Error ? err.message : 'Hardware scan failed';

        hwLine.textContent = setupError;

      }

      refreshUi();

    })();

    installBtn.addEventListener('click', () => {

      if (installing || setupDone || !selectedModel) return;

      installing = true;

      setupError = '';

      refreshUi();

      void runManagedModelSetup(

        (progress) => {

          activeProgress = progress;

          if (progress.phase === 'done') {

            setupDone = true;

            installing = false;

          }

          if (progress.phase === 'error') {

            setupError = progress.error || progress.message;

            installing = false;

          }

          refreshUi();

        },

        { model: selectedModel },

      ).then((result) => {

        if (active && result.ok && result.providerId) {

          setupDone = true;

          ctx.providerId = result.providerId;

          ctx.modelId = result.modelId ?? null;

          actions.patchContext({

            providerId: result.providerId,

            modelId: result.modelId ?? null,

          });

        } else if (!result.ok) {

          setupError = result.error || 'Setup failed';

        }

        installing = false;

        refreshUi();

      });

    });

    actions.setPrimaryLabel('Continue');

    actions.setPrimaryEnabled(setupDone);

    refreshUi();

    return () => { active = false; storage.destroy(); };
  },

  async commit(ctx) {
    if (setupDone && ctx.providerId && ctx.modelId) {
      await persistDefaultModelValue(encodeModelSelectKey(ctx.providerId, ctx.modelId));
    }

    ctx.state = recordStepProgress(ctx.state, 'provider-managed', {

      done: setupDone,

      skipped: !setupDone,

      data: {

        path: 'managed',

        providerId: ctx.providerId,

        modelId: ctx.modelId,

        recommended: recommended?.name ?? null,

        selected: selectedModel?.name ?? null,

      },

    });

  },

};

/** Reset module state when wizard reopens. */

export function resetManagedStepState(): void {

  recommended = null;

  selectedModel = null;

  availableModels = [];

  hardware = null;

  setupDone = false;

  setupError = '';

  activeProgress = null;

  installing = false;

}
