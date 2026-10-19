import { isServerStorageMode } from '../config/storage-mode';
import { formatModelLabel } from '../lib/format-model-label';
import { encodeModelSelectKey } from '../lib/model-select-key';
import { isKnownLocalProviderId, isLocalProviderBaseUrl } from '../providers/provider-host';
import { modelCache } from '../app-state';
import {
  omitLocalRuntimeCatalogModels,
  fetchLibraryModelSelectMerge,
  isLocalRuntimeCatalogProviderId,
  LIBRARY_MODEL_OPTGROUP_LABEL,
  LIBRARY_MODEL_PROVIDER_ID,
  libraryModelLoadState,
} from '../models/model-select-library';
import { fetchModelsForAllProviders } from '../providers/fetch-all-models';
import { fetchModelsForProvider } from '../providers/fetch-models';
import { listProviders } from '../providers/store';
import type { ProviderPublic } from '../providers/types';

/** Label for empty model option (inherits active chat model at runtime). */
export const MODEL_SELECT_EMPTY_LABEL = '(use chat default)';

export type FillProviderSelectOptions = {
  includeEmptyOption?: boolean;
  /** Include synthetic My Models (`minnow-library`) for Minnow-hosted weights. */
  includeLibraryProvider?: boolean;
  /** Hide llama-cpp-local / mlx-lm-local when My Models is the picker surface. */
  omitLocalRuntimeProviders?: boolean;
  /** Put My Models first so Add-model and default picks prefer the library. */
  libraryProviderFirst?: boolean;
};

/** Visible provider rows for a select (My Models is synthetic, not a registry id). */
export interface FillProviderOption {
  id: string;
  label: string;
}

/**
 * Registry providers plus optional My Models, with local-runtime catalogs omitted
 * when the library option is the user-facing surface.
 */
export function listFillProviderOptions(
  providers: ProviderPublic[],
  options?: Pick<
    FillProviderSelectOptions,
    'includeLibraryProvider' | 'omitLocalRuntimeProviders' | 'libraryProviderFirst'
  >,
): FillProviderOption[] {
  const omitLocal = options?.omitLocalRuntimeProviders === true;
  const out: FillProviderOption[] = [];
  for (const provider of providers) {
    if (provider.enabled === false) continue;
    if (omitLocal && isLocalRuntimeCatalogProviderId(provider.id)) continue;
    out.push({ id: provider.id, label: provider.label || provider.id });
  }
  if (options?.includeLibraryProvider && isServerStorageMode()) {
    const library = { id: LIBRARY_MODEL_PROVIDER_ID, label: LIBRARY_MODEL_OPTGROUP_LABEL };
    if (options.libraryProviderFirst) out.unshift(library);
    else out.push(library);
  }
  return out;
}

export type FillModelSelectOptions = {
  includeEmptyOption?: boolean;
};

/** Provider + model id pair for roster bulk-add and catalog exports. */
export interface CatalogRosterTarget {
  providerId: string;
  modelId: string;
}

// ── Catalog ──────────────────────────────────────────────────────────────────

/** Load every catalog model (registry providers + My Models library rows). */
export async function fetchAllCatalogRosterTargets(): Promise<CatalogRosterTarget[]> {
  const { providers } = await listProviders();
  const enabled = providers.filter((p) => p.enabled !== false);
  const controller = new AbortController();
  let results = await fetchModelsForAllProviders(enabled, controller.signal);
  // Roster export matches the picker: no llama.cpp / mlx-lm catalog duplicates.
  results = omitLocalRuntimeCatalogModels(results);

  const merge = await fetchLibraryModelSelectMerge().catch(() => null);

  const out: CatalogRosterTarget[] = [];
  for (const result of results) {
    for (const model of result.models) {
      if (model.type !== 'llm' && model.type !== 'vlm') continue;
      out.push({ providerId: result.provider.id, modelId: model.id });
    }
  }
  if (merge?.library.length) {
    for (const model of merge.library) {
      out.push({ providerId: LIBRARY_MODEL_PROVIDER_ID, modelId: model.id });
    }
  }
  return out;
}

// ── Fill ─────────────────────────────────────────────────────────────────────

async function fillLibraryModelSelect(
  select: HTMLSelectElement,
  selectedModelId: string,
  includeEmpty: boolean,
): Promise<void> {
  const empty = document.createElement('option');
  empty.value = '';
  empty.textContent = MODEL_SELECT_EMPTY_LABEL;

  select.disabled = true;
  select.innerHTML = '<option value="">Loading models…</option>';
  try {
    const merge = await fetchLibraryModelSelectMerge();
    for (const { key, row } of merge?.cacheEntries ?? []) modelCache.set(key,
      { ...row, capabilities: modelCache.get(key)?.capabilities ?? row.capabilities });
    select.replaceChildren();
    if (includeEmpty) {
      select.appendChild(empty);
    }
    let added = 0;
    for (const model of merge?.library ?? []) {
      const opt = document.createElement('option');
      opt.value = model.id;
      const state = libraryModelLoadState(model, merge?.serves ?? []);
      const { optionText, title } = formatModelLabel({
        id: model.name,
        quantization: model.quant || undefined,
        state,
      });
      opt.textContent = optionText;
      opt.title = title;
      select.appendChild(opt);
      added += 1;
    }
    if (!includeEmpty && added === 0) {
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = 'No models found';
      select.appendChild(placeholder);
      select.disabled = true;
      return;
    }
    select.value = selectedModelId || '';
    if (!select.value && !includeEmpty && select.options.length > 0) {
      select.selectedIndex = 0;
    }
    select.disabled = false;
  } catch {
    select.replaceChildren();
    if (includeEmpty) {
      select.appendChild(empty);
    } else {
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = 'Could not load models';
      select.appendChild(placeholder);
    }
    select.disabled = !includeEmpty;
  }
}

/** Populate model &lt;select&gt; for a provider (empty option = chat default when enabled). */
export async function fillModelSelect(
  select: HTMLSelectElement,
  providerId: string,
  selectedModelId: string,
  options?: FillModelSelectOptions,
): Promise<void> {
  let resolvedProvider: ProviderPublic | undefined;
  try {
    const includeEmpty = options?.includeEmptyOption !== false;
    select.replaceChildren();

    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = MODEL_SELECT_EMPTY_LABEL;

    if (!providerId) {
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = 'Select a provider';
      select.appendChild(includeEmpty ? empty : placeholder);
      select.disabled = true;
      return;
    }

    if (providerId === LIBRARY_MODEL_PROVIDER_ID) {
      await fillLibraryModelSelect(select, selectedModelId, includeEmpty);
      return;
    }

    const { providers } = await listProviders();
    const provider = providers.find((p) => p.id === providerId);
    resolvedProvider = provider;
    if (!provider) {
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = 'Unknown provider';
      select.appendChild(includeEmpty ? empty : placeholder);
      select.disabled = true;
      return;
    }

    select.disabled = true;
    select.innerHTML = '<option value="">Loading models…</option>';
    try {
      const controller = new AbortController();
      const models = await fetchModelsForProvider(provider, controller.signal);
      const { catalogCapabilitiesFromRow, mergeModelCapabilities } = await import('../providers/model-capabilities');
      select.replaceChildren();
      if (includeEmpty) {
        select.appendChild(empty);
      }
      let added = 0;
      for (const m of models) {
        if (m.type !== 'llm' && m.type !== 'vlm') continue;
        const key = encodeModelSelectKey(providerId, m.id);
        modelCache.set(key, { ...m, capabilities: mergeModelCapabilities(m,
          modelCache.get(key)?.capabilities ?? catalogCapabilitiesFromRow(m, provider.apiKind)) });
        const opt = document.createElement('option');
        opt.value = m.id;
        const { optionText, title } = formatModelLabel({
          id: m.id,
          quantization: m.quantization,
          state: m.state,
        });
        opt.textContent = optionText;
        opt.title = title;
        select.appendChild(opt);
        added += 1;
      }
      if (!includeEmpty && added === 0) {
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = 'No models found';
        select.appendChild(placeholder);
        select.disabled = true;
        return;
      }
      select.value = selectedModelId || '';
      if (!select.value && !includeEmpty && select.options.length > 0) {
        select.selectedIndex = 0;
      }
      select.disabled = false;
    } catch {
      select.replaceChildren();
      if (includeEmpty) {
        select.appendChild(empty);
      } else {
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = 'Could not load models';
        select.appendChild(placeholder);
      }
      select.disabled = !includeEmpty;
    }
  } finally {
    const provider = resolvedProvider;
    for (const option of select.options) {
      option.dataset.providerId = providerId;
      option.dataset.providerLabel = providerId === LIBRARY_MODEL_PROVIDER_ID ? LIBRARY_MODEL_OPTGROUP_LABEL : provider?.label || providerId;
      option.dataset.providerHost = isKnownLocalProviderId(providerId) || (provider?.baseUrl && isLocalProviderBaseUrl(provider.baseUrl)) ? 'local' : 'cloud';
      if (!option.value && options?.includeEmptyOption !== false) option.dataset.modelSelectReset = 'true';
    }
    const { mountAuxiliaryModelSelectCombobox, syncAuxiliaryModelSelectCombobox } = await import('./model-select-picker');
    mountAuxiliaryModelSelectCombobox(select);
    syncAuxiliaryModelSelectCombobox(select);
  }
}

/** Populate provider &lt;select&gt; with an optional empty “chat default” row. */
export async function fillProviderSelect(
  select: HTMLSelectElement,
  selectedId: string,
  options?: FillProviderSelectOptions,
): Promise<void> {
  select.replaceChildren();
  if (options?.includeEmptyOption) {
    const defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = MODEL_SELECT_EMPTY_LABEL;
    select.appendChild(defaultOpt);
  }

  const { providers } = await listProviders();
  const choices = listFillProviderOptions(providers, options);
  let added = 0;
  for (const choice of choices) {
    const opt = document.createElement('option');
    opt.value = choice.id;
    opt.textContent = choice.label;
    select.appendChild(opt);
    added += 1;
  }
  if (added === 0) {
    select.disabled = true;
    return;
  }
  select.value = selectedId || '';
  if (!select.value && select.options.length > 0) {
    select.selectedIndex = 0;
  }
  select.disabled = false;
}

// ── Fields ───────────────────────────────────────────────────────────────────

/** Append labeled provider + model selects; returns handles for wiring save handlers. */
export function appendProviderModelFields(
  container: HTMLElement,
  ids: { provider: string; model: string },
  labels?: { provider?: string; model?: string },
  layout?: 'stacked' | 'inline',
): { providerSelect: HTMLSelectElement; modelSelect: HTMLSelectElement } {
  const fieldClass =
    layout === 'inline' ? 'settings-field settings-field--inline' : 'settings-field';
  const providerField = document.createElement('div');
  providerField.className = fieldClass;
  const providerLabel = document.createElement('label');
  providerLabel.className = 'settings-field-label';
  providerLabel.htmlFor = ids.provider;
  providerLabel.textContent = labels?.provider ?? 'Provider';
  const providerSelect = document.createElement('select');
  providerSelect.id = ids.provider;
  providerSelect.className = 'settings-select';
  providerField.appendChild(providerLabel);
  providerField.appendChild(providerSelect);
  container.appendChild(providerField);

  const modelField = document.createElement('div');
  modelField.className = fieldClass;
  const modelLabel = document.createElement('label');
  modelLabel.className = 'settings-field-label';
  modelLabel.htmlFor = ids.model;
  modelLabel.textContent = labels?.model ?? 'Model';
  const modelSelect = document.createElement('select');
  modelSelect.id = ids.model;
  modelSelect.className = 'settings-select';
  modelField.appendChild(modelLabel);
  modelField.appendChild(modelSelect);
  container.appendChild(modelField);

  return { providerSelect, modelSelect };
}
