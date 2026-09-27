import { modelCache } from '../api/models';
import { isModelLoaded } from '../api/model-loaded-state';
import type { ModelScoreIndexRow } from '../benchmark/campaign-types';
import { buildTargetKey } from '../benchmark/model-key';
import { decodeModelSelectKey } from '../lib/model-select-key';
import {
  getModelFitProfile,
  MODEL_FIT_PROFILES,
  recommendModelFits,
  type ModelFitCandidate,
  type ModelFitProfileId,
  type ModelFitResult,
} from '../models/model-fit';
import { isLocalProvider } from '../providers/provider-host';
import type { ProviderPublic } from '../providers/types';
import { resolveModelPricing } from '../usage/pricing';

const PROFILE_STORAGE_KEY = 'minnow.models.fitProfile';

function configuredPricing(
  provider: ProviderPublic | undefined,
  modelId: string,
): ModelFitCandidate['pricing'] | undefined {
  if (!provider?.pricing) return undefined;
  const rates = resolveModelPricing(provider.pricing, modelId);
  return {
    currency: provider.pricing.currency?.trim().toUpperCase() || 'USD',
    inputPerMillion: rates.inputPer1M,
    outputPerMillion: rates.outputPer1M,
  };
}

/** Adapt the live picker cache and benchmark index into scorer inputs. */
export function buildModelFitCandidates(
  providers: readonly ProviderPublic[],
  benchmarks: readonly ModelScoreIndexRow[],
): ModelFitCandidate[] {
  const providersById = new Map(providers.map((provider) => [provider.id, provider]));
  const benchmarksByKey = new Map(
    benchmarks.map((row) => [buildTargetKey(row.providerId, row.modelId), row]),
  );
  const candidates: ModelFitCandidate[] = [];

  for (const [key, row] of modelCache) {
    const binding = decodeModelSelectKey(key);
    if (!binding) continue;
    const provider = providersById.get(binding.providerId);
    const benchmark = benchmarksByKey.get(buildTargetKey(binding.providerId, binding.modelId));
    const capabilities = row.capabilities;
    const local = binding.providerId === 'minnow-library' || (provider ? isLocalProvider(provider) : false);

    const pricing = configuredPricing(provider, binding.modelId);
    candidates.push({
      key,
      providerId: binding.providerId,
      modelId: binding.modelId,
      label: row.id || binding.modelId,
      local,
      loaded: isModelLoaded(capabilities?.loadState ?? row.state),
      capabilities: {
        vision: capabilities?.vision ?? null,
        tools: capabilities?.tools ?? null,
        reasoning: capabilities?.reasoning ?? null,
        contextLength: capabilities?.contextLength ?? null,
        sources: capabilities?.sources,
      },
      ...(benchmark
        ? {
            benchmark: {
              totalScore: benchmark.totalScore,
              tokensPerSecond: benchmark.headlineTokPerSec,
              timeToFirstTokenMs: benchmark.headlineTtftMs,
            },
          }
        : {}),
      ...(pricing ? { pricing } : {}),
    });
  }

  return candidates;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function readInitialProfile(): ModelFitProfileId {
  try {
    const stored = localStorage.getItem(PROFILE_STORAGE_KEY) as ModelFitProfileId | null;
    if (MODEL_FIT_PROFILES.some((profile) => profile.id === stored)) return stored!;
  } catch {}
  return 'general-coding';
}

function statusLabel(result: ModelFitResult, first: boolean): string {
  if (result.status === 'incompatible') return 'Incompatible';
  if (result.status === 'unverified') return first ? 'Best unverified fit' : 'Needs verification';
  return first ? 'Best fit' : 'Compatible';
}

function resultDetails(result: ModelFitResult): string[] {
  return [
    ...result.incompatibilities,
    ...result.unknowns,
    ...result.reasons,
  ].slice(0, 5);
}

export interface ModelFitPanelController {
  setSelectedKey(key: string): void;
}

/** Render recommendations without changing a routing choice until Use is pressed. */
export function renderModelFitPanel(
  mount: HTMLElement,
  candidates: readonly ModelFitCandidate[],
  options: {
    selectedKey: string;
    onApply: (candidate: ModelFitCandidate) => void;
  },
): ModelFitPanelController {
  let selectedKey = options.selectedKey;
  let profileId = readInitialProfile();

  const profileRow = element('div', 'settings-model-fit__profile');
  const label = element('label', 'settings-field-label', 'Task profile');
  label.htmlFor = 'modelFitProfile';
  const select = element('select', 'settings-select');
  select.id = 'modelFitProfile';
  for (const profile of MODEL_FIT_PROFILES) {
    const option = document.createElement('option');
    option.value = profile.id;
    option.textContent = profile.label;
    select.appendChild(option);
  }
  select.value = profileId;
  profileRow.append(label, select);

  const description = element('p', 'settings-model-fit__description');
  const selectedStatus = element('div', 'settings-model-fit__selected');
  selectedStatus.setAttribute('aria-live', 'polite');
  const list = element('div', 'settings-model-fit__list');
  mount.append(profileRow, description, selectedStatus, list);

  const render = (): void => {
    const profile = getModelFitProfile(profileId);
    const results = recommendModelFits(candidates, profileId);
    description.textContent = profile.description;
    selectedStatus.className = 'settings-model-fit__selected';

    const selected = results.find((result) => result.candidate.key === selectedKey);
    if (!selectedKey || !selected) {
      selectedStatus.textContent = 'Choose a main chat model to check it against this profile.';
    } else if (selected.status === 'incompatible') {
      selectedStatus.classList.add('settings-model-fit__selected--danger');
      selectedStatus.setAttribute('role', 'alert');
      selectedStatus.textContent = `Current main chat choice is incompatible: ${selected.incompatibilities.join('. ')}. Minnow will keep your choice.`;
    } else if (selected.status === 'unverified') {
      selectedStatus.classList.add('settings-model-fit__selected--warning');
      selectedStatus.removeAttribute('role');
      selectedStatus.textContent = `Current main chat choice needs verification: ${selected.unknowns.join('. ')}. Minnow will keep your choice.`;
    } else {
      selectedStatus.removeAttribute('role');
      selectedStatus.textContent = `Current main chat choice is compatible with ${profile.label.toLowerCase()}.`;
    }

    list.replaceChildren();
    if (!results.length) {
      list.appendChild(
        element(
          'p',
          'settings-model-fit__empty',
          'No configured models are available to compare. Refresh Providers after a model service starts.',
        ),
      );
      return;
    }

    for (const [index, result] of results.slice(0, 3).entries()) {
      const card = element('article', `settings-model-fit-card settings-model-fit-card--${result.status}`);
      const head = element('div', 'settings-model-fit-card__head');
      const titleWrap = element('div', 'settings-model-fit-card__title-wrap');
      titleWrap.append(
        element('h4', 'settings-model-fit-card__title', result.candidate.label),
        element('span', 'settings-model-fit-card__provider', result.candidate.providerId),
      );
      head.append(
        titleWrap,
        element('span', 'settings-model-fit-card__status', statusLabel(result, index === 0)),
      );
      card.appendChild(head);

      const details = element('ul', 'settings-model-fit-card__details');
      for (const detail of resultDetails(result)) {
        details.appendChild(element('li', '', detail));
      }
      card.appendChild(details);

      const use = element('button', 'settings-action-btn', selectedKey === result.candidate.key ? 'In use' : 'Use for main chat');
      use.type = 'button';
      use.disabled = selectedKey === result.candidate.key;
      use.addEventListener('click', () => {
        selectedKey = result.candidate.key;
        options.onApply(result.candidate);
        render();
      });
      card.appendChild(use);
      list.appendChild(card);
    }
  };

  select.addEventListener('change', () => {
    profileId = select.value as ModelFitProfileId;
    try {
      localStorage.setItem(PROFILE_STORAGE_KEY, profileId);
    } catch {}
    render();
  });
  render();

  return {
    setSelectedKey(key: string): void {
      selectedKey = key;
      render();
    },
  };
}
