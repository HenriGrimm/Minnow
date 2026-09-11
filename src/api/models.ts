import { modelCache, modelsFetchAbort, setModelsFetchAbort } from '../app-state';
import { isServerStorageMode } from '../config/storage-mode';
import { buildTopBarModelOptionHtml, escapeHtml } from '../lib/format-model-label';
import {
  applyModelSelectValueToChat,
  decodeModelSelectKey,
  encodeModelSelectKey,
  findFirstSelectKeyForCanonicalModelId,
  resolveModelSelectValueForChat,
} from '../lib/model-select-key';
import { contextLengthFromModelRow } from '../lib/context-length';
import {
  fetchModelsForAllProviders,
  type ProviderModelsResult,
} from '../providers/fetch-all-models';
import { providerSupportsModelLoadUnload } from '../providers/capabilities';
import { resolveProviderEndpoints } from '../providers/resolve';
import { listProviders } from '../providers/store';
import {
  getActiveChat,
  scheduleSaveSessions,
  sessionState,
  touchChat,
} from '../state/sessions';
import { isModelLoaded } from './model-loaded-state';
import type { ModelInfo } from '../types';

export { contextLengthFromModelRow } from '../lib/context-length';
import {
  beginModelLoadUnload,
  endModelLoadUnload,
  getModelLoadUnloadPhase,
  getModelLoadUnloadTargetSelectValue,
  isModelLoadUnloadBusy,
  setModelLoadUnloadButtonBusy,
  setModelLoadUnloadButtonIdle,
} from '../ui/model-load-unload-button';
import { updateModelStateDot } from '../ui/model-state-dot';
import {
  catalogCapabilitiesFromRow,
  fetchProviderCapabilities,
  mergeCapabilitiesIntoModelCache,
} from '../providers/model-capabilities';
import {
  scheduleCapabilityProbeForSelectValue,
  scheduleFirstLoadCapabilityProbes,
} from '../providers/first-load-probe';
import { syncComposerReasoningEffortFromActiveChat } from '../ui/composer-reasoning-effort';
import { syncModelSelectPicker } from '../ui/model-select-picker';
import {
  loadDefaultModelValue,
  readPersistedDefaultModelValue,
  resolveDefaultModelSelectValue,
} from '../ui/default-model';
import {
  decodeLibraryModelSelectKey,
  omitLocalRuntimeCatalogModels,
  fetchLibraryModelSelectMerge,
  LIBRARY_MODEL_PROVIDER_ID,
  loadLibraryModelFromPicker,
  unloadLibraryModelFromPicker,
} from '../models/model-select-library';
import { renderSidebar } from '../ui/sidebar';
import { setReadyStatus, setStatus } from '../ui/status';
import { refreshMetricsStripForChat, updateStrip } from '../ui/stats';

export { modelCache };
export { isModelLoaded } from './model-loaded-state';

import type { LmModelRecord } from '../types';

// ── Resolve ──────────────────────────────────────────────────────────────────

/** Resolve a cached row for the top-bar value (composite key) or canonical id + chat provider. */
export function getModelRowForSelectOrCanonicalId(modelIdOrKey: string): LmModelRecord | undefined {
  const trimmed = modelIdOrKey.trim();
  if (!trimmed) return undefined;
  const direct = modelCache.get(trimmed);
  if (direct) return direct;
  const decoded = decodeModelSelectKey(trimmed);
  if (decoded) {
    return modelCache.get(encodeModelSelectKey(decoded.providerId, decoded.modelId));
  }
  try {
    const pid = getActiveChat().providerId?.trim();
    if (pid) {
      const byChat = modelCache.get(encodeModelSelectKey(pid, trimmed));
      if (byChat) return byChat;
    }
  } catch {}
  const k = findFirstSelectKeyForCanonicalModelId(modelCache.keys(), trimmed);
  return k ? modelCache.get(k) : undefined;
}

/** Merge cached model row with optional fields from a chat completion response. */
export function resolveModelInfo(modelIdOrKey: string, fromResponse?: ModelInfo | null): ModelInfo {
  const cached = getModelRowForSelectOrCanonicalId(modelIdOrKey);
  const fromCache: ModelInfo = cached
    ? {
        arch: cached.arch,
        quant: cached.quantization,
        context_length: contextLengthFromModelRow(cached),
      }
    : {};
  const merged = { ...fromCache, ...(fromResponse || {}) };
  if (fromCache.context_length != null) {
    merged.context_length = fromCache.context_length;
  }
  return merged;
}

/**
 * Refresh model-info cells on the metrics strip without wiping last-turn tokens/timing.
 * Catalog and capability probes used to call `updateStrip({}, {})`, which blanked the strip
 * whenever models refreshed even though the chat still had usage.
 */
export function showCachedModelInfo(): void {
  const modelIdOrKey = (document.getElementById('modelSelect') as HTMLSelectElement | null)?.value;
  if (!modelIdOrKey) return;
  try {
    refreshMetricsStripForChat(getActiveChat());
  } catch {
    updateStrip({}, {}, resolveModelInfo(modelIdOrKey));
  }
}

function optionForModelSelectValue(
  sel: HTMLSelectElement,
  selectValue: string,
): HTMLOptionElement | undefined {
  const key = selectValue.trim();
  if (!key) return undefined;
  return [...sel.options].find((o) => o.value === key);
}

/** True when load/unload is available for this catalog row (server mode + provider). */
export function supportsLoadUnloadForSelectValue(
  sel: HTMLSelectElement,
  selectValue: string,
): boolean {
  if (!isServerStorageMode()) return false;
  const libraryId = decodeLibraryModelSelectKey(selectValue);
  if (libraryId) return true;
  const opt = optionForModelSelectValue(sel, selectValue);
  return opt?.getAttribute('data-supports-load-unload') === '1';
}

/** Sync one inline Load/Unload control on a model menu row. */
export function syncModelOptionLoadUnloadButtonElement(btn: HTMLButtonElement): void {
  const raw = btn.dataset.selectValue?.trim() ?? '';
  const sel = document.getElementById('modelSelect') as HTMLSelectElement | null;
  if (!sel || !raw) {
    btn.hidden = true;
    return;
  }

  const busyTarget = getModelLoadUnloadTargetSelectValue();
  const isThisRowBusy = isModelLoadUnloadBusy() && busyTarget === raw;

  if (isThisRowBusy) {
    btn.hidden = false;
    setModelLoadUnloadButtonBusy(btn, getModelLoadUnloadPhase());
    return;
  }

  if (!supportsLoadUnloadForSelectValue(sel, raw)) {
    btn.hidden = true;
    return;
  }

  btn.hidden = false;
  const directRow = modelCache.get(raw);
  const decoded = decodeModelSelectKey(raw);
  const row =
    directRow ??
    (decoded
      ? modelCache.get(encodeModelSelectKey(decoded.providerId, decoded.modelId))
      : undefined);
  const loaded = row ? isModelLoaded(row.state) : false;
  setModelLoadUnloadButtonIdle(btn, loaded, true);
  btn.disabled = isModelLoadUnloadBusy();
}

// ── Buttons ──────────────────────────────────────────────────────────────────

/** Update every inline Load/Unload control in open model menus. */
export function updateModelLoadUnloadButtons(): void {
  // Deferred picker refreshes can finish after the UI has been torn down.
  if (typeof document === 'undefined') return;
  for (const btn of document.querySelectorAll<HTMLButtonElement>(
    '.model-select-option-load-unload',
  )) {
    syncModelOptionLoadUnloadButtonElement(btn);
  }
}

async function postModelAction(url: string, body: Record<string, string>): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  if (!res.ok) {
    const text = await res.text();
    let message = `HTTP ${res.status}`;
    try {
      const json = JSON.parse(text) as { error?: string };
      if (json.error) message = json.error;
    } catch {
      if (text.trim()) message = text.slice(0, 200);
    }
    throw new Error(message);
  }
}

// ── Load ─────────────────────────────────────────────────────────────────────

/** Load a model via the given provider (v1 REST, proxied or direct). */
export async function loadModel(modelId: string, providerId: string): Promise<void> {
  const { providers } = await listProviders();
  const provider = providers.find((p) => p.id === providerId && p.enabled !== false);
  if (!provider) {
    throw new Error('Unknown provider');
  }
  if (!providerSupportsModelLoadUnload(provider)) {
    throw new Error('Provider does not support model load/unload');
  }
  if (!modelId.trim()) {
    throw new Error('No model selected');
  }

  const endpoints = resolveProviderEndpoints(provider);
  if (!endpoints.modelsLoadUrl) {
    throw new Error('Provider does not support model load/unload');
  }

  await postModelAction(endpoints.modelsLoadUrl, { model: modelId.trim() });
  await fetchModels();
}

/** Unload a model instance via the given provider. */
export async function unloadModel(modelId: string, providerId: string): Promise<void> {
  const { providers } = await listProviders();
  const provider = providers.find((p) => p.id === providerId && p.enabled !== false);
  if (!provider) {
    throw new Error('Unknown provider');
  }
  if (!providerSupportsModelLoadUnload(provider)) {
    throw new Error('Provider does not support model load/unload');
  }
  if (!modelId.trim()) {
    throw new Error('No model selected');
  }

  const endpoints = resolveProviderEndpoints(provider);
  if (!endpoints.modelsUnloadUrl) {
    throw new Error('Provider does not support model load/unload');
  }

  await postModelAction(endpoints.modelsUnloadUrl, { instance_id: modelId.trim() });
  await fetchModels();
}

/** Load a model for a specific #modelSelect option value (composite key or canonical id). */
export async function loadModelForSelectValue(selectValue: string): Promise<void> {
  if (isModelLoadUnloadBusy()) return;
  const raw = selectValue.trim();
  if (!raw) return;

  const libraryId = decodeLibraryModelSelectKey(raw);
  if (libraryId) {
    beginModelLoadUnload('load', raw);
    updateModelLoadUnloadButtons();
    updateModelStateDot(raw);
    syncModelSelectPicker();
    setStatus('spin', 'Loading model…');
    try {
      await loadLibraryModelFromPicker(libraryId);
      await fetchModels();
      setStatus('ok', 'Model loaded');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatus('err', message);
    } finally {
      endModelLoadUnload();
      updateModelLoadUnloadButtons();
      updateModelStateDot(raw);
      syncModelSelectPicker();
    }
    return;
  }

  const decoded = decodeModelSelectKey(raw);
  const modelId = decoded?.modelId ?? raw;
  const chat = getActiveChat();
  const providerId = decoded?.providerId ?? chat.providerId;
  if (!providerId) return;

  beginModelLoadUnload('load', raw);
  updateModelLoadUnloadButtons();
  updateModelStateDot(raw);
  syncModelSelectPicker();
  setStatus('spin', 'Loading model…');
  try {
    await loadModel(modelId, providerId);
    setStatus('ok', 'Model loaded');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setStatus('err', message);
  } finally {
    endModelLoadUnload();
    updateModelLoadUnloadButtons();
    updateModelStateDot(raw);
    syncModelSelectPicker();
  }
}

/** Load the model currently selected in the topbar picker. */
export async function loadSelectedModel(): Promise<void> {
  const sel = document.getElementById('modelSelect') as HTMLSelectElement;
  await loadModelForSelectValue(sel.value);
}

/** Unload a model for a specific #modelSelect option value (composite key or canonical id). */
export async function unloadModelForSelectValue(selectValue: string): Promise<void> {
  if (isModelLoadUnloadBusy()) return;
  const raw = selectValue.trim();
  if (!raw) return;

  const libraryId = decodeLibraryModelSelectKey(raw);
  if (libraryId) {
    beginModelLoadUnload('unload', raw);
    updateModelLoadUnloadButtons();
    updateModelStateDot(raw);
    syncModelSelectPicker();
    setStatus('spin', 'Unloading model…');
    try {
      await unloadLibraryModelFromPicker(libraryId);
      await fetchModels();
      setStatus('ok', 'Model unloaded');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatus('err', message);
    } finally {
      endModelLoadUnload();
      updateModelLoadUnloadButtons();
      updateModelStateDot(raw);
      syncModelSelectPicker();
    }
    return;
  }

  const decoded = decodeModelSelectKey(raw);
  const modelId = decoded?.modelId ?? raw;
  const chat = getActiveChat();
  const providerId = decoded?.providerId ?? chat.providerId;
  if (!providerId) return;

  beginModelLoadUnload('unload', raw);
  updateModelLoadUnloadButtons();
  updateModelStateDot(raw);
  syncModelSelectPicker();
  setStatus('spin', 'Unloading model…');
  try {
    await unloadModel(modelId, providerId);
    setStatus('ok', 'Model unloaded');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setStatus('err', message);
  } finally {
    endModelLoadUnload();
    updateModelLoadUnloadButtons();
    updateModelStateDot(raw);
    syncModelSelectPicker();
  }
}

/** Unload the model currently selected in the topbar picker. */
export async function unloadSelectedModel(): Promise<void> {
  const sel = document.getElementById('modelSelect') as HTMLSelectElement;
  await unloadModelForSelectValue(sel.value);
}

/** Load or unload the model for a specific #modelSelect option value. */
export async function toggleModelLoadForSelectValue(selectValue: string): Promise<void> {
  const raw = selectValue.trim();
  if (!raw) return;
  const row = getModelRowForSelectOrCanonicalId(raw);
  const loaded = row ? isModelLoaded(row.state) : false;
  if (loaded) {
    await unloadModelForSelectValue(raw);
  } else {
    await loadModelForSelectValue(raw);
  }
}

/** Load or unload the model currently selected in the topbar picker. */
export async function toggleSelectedModelLoad(): Promise<void> {
  const sel = document.getElementById('modelSelect') as HTMLSelectElement;
  await toggleModelLoadForSelectValue(sel.value);
}

// ── Select ───────────────────────────────────────────────────────────────────

/** Build optgroup HTML for all providers that returned at least one model. */
function buildMultiProviderModelSelectInnerHtml(results: ProviderModelsResult[]): string {
  const chunks: string[] = [];
  for (const { provider, models } of results) {
    if (models.length === 0) continue;
    const opts = models
      .map((m) =>
        buildTopBarModelOptionHtml({
          value: encodeModelSelectKey(provider.id, m.id),
          providerId: provider.id,
          providerLabel: provider.label,
          providerBaseUrl: provider.baseUrl,
          supportsModelLoadUnload: providerSupportsModelLoadUnload(provider),
          model: { id: m.id, quantization: m.quantization, state: m.state },
        }),
      )
      .join('');
    chunks.push(`<optgroup label="${escapeHtml(provider.label)}">${opts}</optgroup>`);
  }
  return chunks.join('');
}

/** Options for {@link populateMultiProviderModelSelect}. */
export interface PopulateMultiProviderModelSelectOptions {
  selectedProviderId?: string;
  selectedModelId?: string;
  includeEmptyOption?: boolean;
  emptyLabel?: string;
  signal?: AbortSignal;
}

export async function populateMultiProviderModelSelect(
  select: HTMLSelectElement,
  options?: PopulateMultiProviderModelSelectOptions,
): Promise<ProviderModelsResult[] | null> {
  const signal = options?.signal;
  const emptyLabel = options?.emptyLabel ?? '(use menubar default)';

  select.innerHTML = '<option value="">Loading models…</option>';
  syncModelSelectPicker();

  try {
    const { providers } = await listProviders();
    const { loadRouterConfig, routerOptions } = await import('../models/routers');
    const routerConfig = await loadRouterConfig().catch(() => null);
    const enabled = providers.filter((p) => p.enabled !== false);

    if (enabled.length === 0) {
      select.innerHTML = '<option value="">No providers configured</option>';
      if (routerConfig) routerOptions(select, routerConfig);
      syncModelSelectPicker();
      return null;
    }

    let results = await fetchModelsForAllProviders(enabled, signal ?? new AbortController().signal);
    // Never list llama.cpp / mlx-lm catalogs — My Models is the only picker surface.
    results = omitLocalRuntimeCatalogModels(results);

    const libraryMerge = await fetchLibraryModelSelectMerge(signal).catch(() => null);

    const withModels = results.filter((r) => r.models.length > 0);
    const providerModelCount = withModels.reduce((n, r) => n + r.models.length, 0);
    const libraryCount = libraryMerge?.cacheEntries.length ?? 0;
    const totalModels = providerModelCount + libraryCount;

    if (totalModels === 0) {
      select.innerHTML = '<option value="">No models found</option>';
      if (routerConfig) routerOptions(select, routerConfig);
      syncModelSelectPicker();
      return results;
    }

    let innerHtml = buildMultiProviderModelSelectInnerHtml(results);
    if (libraryMerge?.optgroupHtml) {
      innerHtml = `${innerHtml}${libraryMerge.optgroupHtml}`;
    }
    if (options?.includeEmptyOption) {
      innerHtml = `<option value="">${escapeHtml(emptyLabel)}</option>${innerHtml}`;
    }
    select.innerHTML = innerHtml;
    syncModelSelectPicker();

    modelCache.clear();
    for (const { provider, models } of results) {
      for (const m of models) {
        const key = encodeModelSelectKey(provider.id, m.id);
        modelCache.set(key, { ...m, capabilities: catalogCapabilitiesFromRow(m, provider.apiKind) });
      }
    }
    if (libraryMerge) {
      for (const { key, row } of libraryMerge.cacheEntries) {
        modelCache.set(key, {
          ...row,
          capabilities: catalogCapabilitiesFromRow(row),
        });
      }
    }

    for (const { provider, error } of results) {
      if (error || provider.enabled === false) continue;
      try {
        const capsFile = await fetchProviderCapabilities(provider.id, signal);
        mergeCapabilitiesIntoModelCache(capsFile);
      } catch {}
    }

    scheduleFirstLoadCapabilityProbes(
      results,
      collectInUseModelBindings(
        options?.selectedProviderId && options?.selectedModelId
          ? [{ providerId: options.selectedProviderId, modelId: options.selectedModelId }]
          : undefined,
      ),
    );

    const pid = options?.selectedProviderId?.trim();
    const mid = options?.selectedModelId?.trim();
    if (pid && mid) {
      const want = encodeModelSelectKey(pid, mid);
      if ([...select.options].some((opt) => opt.value === want)) {
        select.value = want;
      } else if (options?.includeEmptyOption) {
        select.value = '';
      }
    } else if (options?.includeEmptyOption) {
      select.value = '';
    }

    if (routerConfig) {
      routerOptions(select, routerConfig);
      if (pid === 'minnow-router' && mid) select.value = encodeModelSelectKey(pid, mid);
    }
    syncModelSelectPicker();
    return results;
  } catch (err) {
    const e = err as { name?: string };
    if (e && e.name === 'AbortError') return null;
    select.innerHTML = '<option value="">Cannot reach providers</option>';
    syncModelSelectPicker();
    return null;
  }
}

function collectInUseModelBindings(
  extra?: Array<{ providerId?: string; modelId?: string }>,
): Array<{ providerId: string; modelId: string }> {
  const out: Array<{ providerId: string; modelId: string }> = [];
  const seen = new Set<string>();
  const add = (providerId?: string, modelId?: string) => {
    const pid = providerId?.trim();
    const mid = modelId?.trim();
    if (!pid || !mid) return;
    const key = `${pid}\0${mid}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ providerId: pid, modelId: mid });
  };
  const addSelectValue = (raw: string | undefined) => {
    const trimmed = raw?.trim();
    if (!trimmed) return;
    const decoded = decodeModelSelectKey(trimmed);
    if (decoded) add(decoded.providerId, decoded.modelId);
  };

  addSelectValue((document.getElementById('modelSelect') as HTMLSelectElement | null)?.value);
  addSelectValue(readPersistedDefaultModelValue());
  if (sessionState) {
    for (const chat of sessionState.chats) {
      add(chat.providerId, chat.modelId);
    }
  }
  for (const binding of extra ?? []) {
    add(binding.providerId, binding.modelId);
  }
  return out;
}

/** Pick initial <select> value: chat binding, else first loaded model, else first option. */
function pickInitialSelectValue(
  results: ProviderModelsResult[],
  chat: ReturnType<typeof getActiveChat>,
): string {
  const flat: { providerId: string; modelId: string; key: string; loaded: boolean }[] = [];
  for (const { provider, models } of results) {
    for (const m of models) {
      flat.push({
        providerId: provider.id,
        modelId: m.id,
        key: encodeModelSelectKey(provider.id, m.id),
        loaded: isModelLoaded(m.state),
      });
    }
  }
  for (const key of modelCache.keys()) {
    const libraryId = decodeLibraryModelSelectKey(key);
    if (!libraryId) continue;
    const row = modelCache.get(key);
    flat.push({
      providerId: LIBRARY_MODEL_PROVIDER_ID,
      modelId: libraryId,
      key,
      loaded: row ? isModelLoaded(row.state) : false,
    });
  }
  if (flat.length === 0) return '';

  const pid = chat.providerId?.trim();
  const mid = chat.modelId?.trim();
  if (pid && mid) {
    const want = encodeModelSelectKey(pid, mid);
    if (flat.some((x) => x.key === want)) return want;
    const sameModel = flat.filter((x) => x.modelId === mid);
    if (sameModel.length === 1) return sameModel[0].key;
    if (sameModel.length > 1) return sameModel[0].key;
  }

  const loaded = flat.find((x) => x.loaded);
  if (loaded) return loaded.key;
  return flat[0].key;
}

// ── Fetch ────────────────────────────────────────────────────────────────────

/** Keep the chosen default visible even while its provider is unavailable. */
function restoreDefaultModelOption(select: HTMLSelectElement): void {
  const value = readPersistedDefaultModelValue();
  if (!value) return;
  if (![...select.options].some((option) => option.value === value)) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = `${decodeModelSelectKey(value)?.modelId ?? value} (unavailable)`;
    select.append(option);
  }
  select.value = value;
}

/** Load models from every enabled provider and populate the model select. */
export async function fetchModels(): Promise<void> {
  const sel = document.getElementById('modelSelect') as HTMLSelectElement;

  if (modelsFetchAbort) modelsFetchAbort.abort();
  const controller = new AbortController();
  setModelsFetchAbort(controller);
  const { signal } = controller;

  sel.innerHTML = '<option value="">Loading models…</option>';
  syncModelSelectPicker();
  if (!isModelLoadUnloadBusy()) {
    setStatus('spin', 'Loading models…');
  }
  updateModelLoadUnloadButtons();
  if (isModelLoadUnloadBusy()) {
    updateModelStateDot();
  }

  try {
    await loadDefaultModelValue();
    if (signal.aborted) return;
    const { providers } = await listProviders();
    const enabled = providers.filter((p) => p.enabled !== false);

    if (enabled.length === 0) {
      sel.innerHTML = '<option value="">No providers configured</option>';
      const { loadRouterConfig, routerOptions } = await import('../models/routers');
      const routers = await loadRouterConfig().catch(() => null);
      if (routers) routerOptions(sel, routers);
      restoreDefaultModelOption(sel);
      syncModelSelectPicker();
      setStatus('err', 'No providers configured. Use Settings → Providers.');
      updateModelLoadUnloadButtons();
      return;
    }

    const results = await populateMultiProviderModelSelect(sel, { signal });
    if (!results) {
      restoreDefaultModelOption(sel);
      const { providers: listed } = await listProviders();
      const enabledCount = listed.filter((p) => p.enabled !== false).length;
      if (enabledCount === 0) {
        setStatus('err', 'No providers configured. Use Settings → Providers.');
      } else {
        setStatus('err', 'Cannot reach one or more providers. Check Settings → Providers.');
      }
      updateModelLoadUnloadButtons();
      return;
    }

    restoreDefaultModelOption(sel);
    const failures = results.filter((r) => r.error);
    const catalogCount = [...sel.options].filter((o) => o.value.trim()).length;

    if (catalogCount === 0) {
      const names = failures.map((f) => f.provider.label).join(', ');
      setStatus(
        'err',
        failures.length === results.length
          ? `Cannot reach providers (${names || 'unknown'}). Check Settings → Providers.`
          : 'No models returned from any provider.',
      );
      updateModelLoadUnloadButtons();
      return;
    }

    const ac = getActiveChat();
    const optionValues = [...sel.options].map((o) => o.value);

    const savedDefault = resolveDefaultModelSelectValue(optionValues);
    if (savedDefault) {
      sel.value = savedDefault;
    } else {
      const chosen = pickInitialSelectValue(results, ac);
      sel.value = chosen || optionValues.find((v) => v.trim()) || '';
    }

    const withModels = results.filter((r) => r.models.length > 0);
    const okCount = withModels.length;
    const totalModels = catalogCount;
    if (failures.length > 0) {
      const failedLabels = failures.map((f) => f.provider.label).join(', ');
      setStatus('ok', `${totalModels} models · ${okCount} providers (${failedLabels} unreachable)`);
    } else {
      setStatus('ok', `${totalModels} models · ${okCount} provider${okCount === 1 ? '' : 's'}`);
    }

    if (!isModelLoadUnloadBusy()) {
      setReadyStatus();
    }
    updateModelStateDot(sel.value);
    showCachedModelInfo();
    syncModelSelectPicker();
    void import('../ui/composer-model-trigger').then((m) => m.syncComposerModelTriggers());
    syncComposerReasoningEffortFromActiveChat();
    renderSidebar();
    scheduleSaveSessions();
    scheduleCapabilityProbeForSelectValue(sel.value);
    void import('../ui/context-usage-ring').then((m) => m.refreshContextUsageRing());
    void import('../ui/benchmark/roster-picker.ts').then((m) => m.refreshBenchmarkRosterPicker());
  } catch (err) {
    const e = err as { name?: string };
    if (e && e.name === 'AbortError') return;
    sel.innerHTML = '<option value="">Cannot reach providers</option>';
    restoreDefaultModelOption(sel);
    syncModelSelectPicker();
    setStatus('err', 'Cannot reach one or more providers. Check Settings → Providers.');
  } finally {
    if (modelsFetchAbort && modelsFetchAbort.signal === signal) {
      setModelsFetchAbort(null);
    }
    updateModelLoadUnloadButtons();
    updateModelStateDot(sel.value);
    syncModelSelectPicker();
  }
}

/**
 * After serve, pick the new provider's model in the top bar.
 * @returns true when a matching option was found and selected.
 */
export async function selectProviderModel(
  providerId: string,
  modelIdHint: string,
): Promise<boolean> {
  await fetchModels();
  if (readPersistedDefaultModelValue()) return false;
  const sel = document.getElementById('modelSelect') as HTMLSelectElement;
  const hint = modelIdHint.trim().toLowerCase();
  if (!hint) return false;

  for (const opt of [...sel.options]) {
    const decoded = decodeModelSelectKey(opt.value);
    if (!decoded || decoded.providerId !== providerId) continue;
    const mid = decoded.modelId.toLowerCase();
    if (mid.includes(hint) || hint.includes(mid) || mid.endsWith(hint) || hint.endsWith(mid)) {
      sel.value = opt.value;
      const chat = getActiveChat();
      applyModelSelectValueToChat(chat, opt.value);
      touchChat(chat);
      scheduleSaveSessions();
      scheduleCapabilityProbeForSelectValue(opt.value);
      syncModelSelectPicker();
      updateModelLoadUnloadButtons();
      showCachedModelInfo();
      renderSidebar();
      return true;
    }
  }
  return false;
}
