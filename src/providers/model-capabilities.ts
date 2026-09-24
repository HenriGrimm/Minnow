/**
 * Per-model capability matrix: fetch, merge with catalog, probe trigger.
 */

import { isModelLoaded } from '../api/model-loaded-state';
import { modelCache } from '../app-state';
import { isServerStorageMode } from '../config/storage-mode';
import { contextLengthFromModelRow } from '../lib/context-length';
import { anthropicModelUsesAdaptiveThinking } from '../lib/anthropic-thinking-style';
import {
  DEEPSEEK_V4_REASONING_OPTIONS,
  ensureDeepSeekV4ReasoningAllowedOptions,
  ensureGlm53ReasoningAllowedOptions,
  ensureQwen38ReasoningAllowedOptions,
  inferReasoningOptionsFromModelId,
  isDeepSeekV4ModelId,
  isGlm53ModelId,
  isQwen38ModelId,
  modelHasReasoningEffortLevels,
  normalizeReasoningAllowedOptions,
  normalizeReasoningCatalogValue,
  GLM53_REASONING_OPTIONS,
  QWEN38_REASONING_OPTIONS,
} from '../lib/reasoning-effort';
import { decodeModelSelectKey, encodeModelSelectKey, findFirstSelectKeyForCanonicalModelId } from '../lib/model-select-key';
import { LIBRARY_MODEL_PROVIDER_ID } from '../models/model-select-library';
import {
  LLAMA_CPP_LOCAL_PROVIDER_ID,
  MLX_LM_LOCAL_PROVIDER_ID,
  type ApiKind,
} from './types';
import type { LmModelRecord, ModelCapabilities } from '../types';
import { getCachedProviderList } from './store';

export type { CapabilitySource, ModelCapabilities } from '../types';

export interface ProviderCapabilitiesFile {
  schemaVersion: number;
  providerId: string;
  probedAt: string;
  apiKind: string;
  models: Record<string, ModelCapabilities>;
}

// ── Cache ────────────────────────────────────────────────────────────────────

const providerCapabilitiesCache = new Map<string, ProviderCapabilitiesFile>();

let lastAppliedCapabilities: ProviderCapabilitiesFile | null = null;

let probeAbort: AbortController | null = null;
/** True while Settings → Probe models owns `probeAbort` (auto-probe must not steal it). */
let probeIsManual = false;

/** Match chat model ids to catalog rows when slash-prefixed ids differ (e.g. deepseek/deepseek-v4-flash). */
function modelIdsMatchForCapabilities(chatModelId: string, catalogModelId: string): boolean {
  const chat = chatModelId.trim().toLowerCase();
  const catalog = catalogModelId.trim().toLowerCase();
  if (!chat || !catalog) return false;
  if (chat === catalog) return true;
  const chatTail = chat.includes('/') ? chat.slice(chat.lastIndexOf('/') + 1) : chat;
  const catalogTail = catalog.includes('/') ? catalog.slice(catalog.lastIndexOf('/') + 1) : catalog;
  return chatTail === catalogTail;
}

function findModelCacheRow(providerId: string, modelId: string): LmModelRecord | undefined {
  const pid = providerId.trim();
  const mid = modelId.trim();
  if (!pid || !mid) return undefined;

  const exact = modelCache.get(encodeModelSelectKey(pid, mid));
  if (exact) return exact;

  for (const [key, row] of modelCache.entries()) {
    const decoded = decodeModelSelectKey(key);
    if (!decoded || decoded.providerId !== pid) continue;
    if (modelIdsMatchForCapabilities(mid, decoded.modelId)) return row;
  }

  const fallbackKey = findFirstSelectKeyForCanonicalModelId(modelCache.keys(), mid);
  if (fallbackKey) return modelCache.get(fallbackKey);
  return undefined;
}

/** ISO timestamp of the last capabilities file applied to modelCache. */
export function getLastCapabilitiesProbedAt(): string | undefined {
  const at = lastAppliedCapabilities?.probedAt;
  if (!at?.trim()) return undefined;
  return at;
}

/** Cached capabilities file for a provider (in-memory). */
export function getCachedProviderCapabilities(
  providerId: string,
): ProviderCapabilitiesFile | undefined {
  return providerCapabilitiesCache.get(providerId);
}

/** Apply fetched capabilities file to cache and merge into model rows. */
export function applyProviderCapabilities(file: ProviderCapabilitiesFile): void {
  providerCapabilitiesCache.set(file.providerId, file);
  stampModelCacheFromCapabilitiesFile(file);
}

/**
 * Probe files are keyed by the upstream provider (`llama-cpp-local` / `mlx-lm-local`).
 * My Models picker rows use `minnow-library` + the same model id — stamp those too
 * so a first-load probe can show a Vision badge on the row the user selected.
 */
function cacheRowAcceptsCapabilitiesFile(
  fileProviderId: string,
  rowProviderId: string | undefined,
): boolean {
  if (rowProviderId === undefined || rowProviderId === fileProviderId) return true;
  if (rowProviderId !== LIBRARY_MODEL_PROVIDER_ID) return false;
  return (
    fileProviderId === LLAMA_CPP_LOCAL_PROVIDER_ID ||
    fileProviderId === MLX_LM_LOCAL_PROVIDER_ID
  );
}

/** Write each file entry onto matching modelCache rows. */
function stampModelCacheFromCapabilitiesFile(file: ProviderCapabilitiesFile): void {
  for (const [modelId, caps] of Object.entries(file.models)) {
    for (const [cacheKey, row] of modelCache.entries()) {
      const decoded = decodeModelSelectKey(cacheKey);
      const logicalId = decoded?.modelId ?? cacheKey;
      if (logicalId !== modelId) continue;
      if (!cacheRowAcceptsCapabilitiesFile(file.providerId, decoded?.providerId)) continue;
      row.capabilities = mergeModelCapabilities(row, caps);
    }
  }
}

function reasoningCatalogFromRow(
  row: LmModelRecord,
): Pick<ModelCapabilities, 'reasoning' | 'reasoningAllowedOptions' | 'reasoningDefault'> {
  const block = row.reasoning;
  if (!block || typeof block !== 'object') {
    return { reasoning: null };
  }
  const allowedRaw = Array.isArray(block.allowed_options)
    ? block.allowed_options
    : [];
  const allowed = normalizeReasoningAllowedOptions(allowedRaw, row.id);
  const def = normalizeReasoningCatalogValue(block.default, row.id);
  const reasoningOnDefault =
    def === 'on' ||
    def === 'low' ||
    def === 'medium' ||
    def === 'high' ||
    def === 'max';
  const reasoning =
    allowed.length > 0 ? true : reasoningOnDefault ? true : def === 'off' ? false : null;
  return {
    reasoning,
    ...(allowed.length > 0 ? { reasoningAllowedOptions: allowed } : {}),
    ...(def ? { reasoningDefault: def } : {}),
  };
}

// ── Catalog ──────────────────────────────────────────────────────────────────

/** True when catalog row indicates multimodal vision (vlm type or LM Studio capabilities.vision). */
export function catalogRowHasVision(row: LmModelRecord): boolean {
  return row.type === 'vlm' || row.catalogVision === true;
}

/** Catalog default: Qwen3.8 prefers High; GLM-5.3 prefers Max; ignore off/on when levels exist. */
function resolveCatalogReasoningDefault(
  modelId: string,
  allowed: ModelCapabilities['reasoningAllowedOptions'],
  catalogDefault: ModelCapabilities['reasoningDefault'],
): ModelCapabilities['reasoningDefault'] {
  const options = allowed ?? [];
  if (
    catalogDefault &&
    options.includes(catalogDefault) &&
    catalogDefault !== 'off' &&
    catalogDefault !== 'on'
  ) {
    return catalogDefault;
  }
  if (isQwen38ModelId(modelId) && options.includes('high')) return 'high';
  if (isDeepSeekV4ModelId(modelId) && options.includes('high')) return 'high';
  if (isGlm53ModelId(modelId) && options.includes('max')) return 'max';
  if (options.includes('medium')) return 'medium';
  return catalogDefault;
}

/** Build catalog-derived capabilities from a models-list row. */
export function catalogCapabilitiesFromRow(
  row: LmModelRecord,
  apiKind?: ApiKind,
): ModelCapabilities {
  const resolvedApi = row.api ?? apiKind;
  const contextLength = contextLengthFromModelRow(row) ?? null;
  const vision = catalogRowHasVision(row);
  const reasoningCaps = reasoningCatalogFromRow(row);
  let reasoningAllowedOptions = reasoningCaps.reasoningAllowedOptions;
  if (!reasoningAllowedOptions || reasoningAllowedOptions.length === 0) {
    const inferred = inferReasoningOptionsFromModelId(row.id, resolvedApi);
    if (inferred.length > 0) {
      reasoningAllowedOptions = inferred;
    }
  }
  if (isQwen38ModelId(row.id)) {
    reasoningAllowedOptions = ensureQwen38ReasoningAllowedOptions(
      row.id,
      reasoningAllowedOptions ?? [],
    );
  }
  if (isGlm53ModelId(row.id)) {
    reasoningAllowedOptions = ensureGlm53ReasoningAllowedOptions(
      row.id,
      reasoningAllowedOptions ?? [],
    );
  }
  if (isDeepSeekV4ModelId(row.id)) {
    reasoningAllowedOptions = ensureDeepSeekV4ReasoningAllowedOptions(
      row.id,
      reasoningAllowedOptions ?? [],
    );
  }
  const isMiniMax = /minimax/i.test(row.id);
  const usesAdaptiveAnthropicThinking =
    resolvedApi === 'anthropic-v1' && anthropicModelUsesAdaptiveThinking(row.id);
  return {
    vision,
    tools: null,
    streaming: null,
    grammar: null,
    reasoning: reasoningCaps.reasoning ?? (reasoningAllowedOptions?.length ? true : null),
    reasoningAllowedOptions:
      reasoningAllowedOptions?.length
        ? reasoningAllowedOptions
        : usesAdaptiveAnthropicThinking
          ? (['off', 'low', 'medium', 'high'] as const)
          : reasoningAllowedOptions,
    reasoningDefault: resolveCatalogReasoningDefault(
      row.id,
      reasoningAllowedOptions,
      reasoningCaps.reasoningDefault,
    ),
    ...(isMiniMax ? { reasoningThinkingEnabledValue: 'adaptive' as const } : {}),
    ...(usesAdaptiveAnthropicThinking ? { reasoningThinkingEnabledValue: 'adaptive' as const } : {}),
    contextLength,
    loadState: row.state?.trim() || null,
    ...(resolvedApi ? { api: resolvedApi } : {}),
    sources: {
      vision: 'catalog',
      contextLength: contextLength !== null ? 'catalog' : undefined,
      loadState: 'catalog',
      ...(reasoningCaps.reasoning !== undefined && reasoningCaps.reasoning !== null
        ? { reasoning: 'catalog' as const }
        : {}),
    },
    probeErrors: {},
  };
}

/** Empty capability shell used when GLM-5.3 is selected but not in modelCache. */
function glm53AssumedCapabilities(): ModelCapabilities {
  return {
    vision: null,
    tools: null,
    streaming: null,
    grammar: null,
    reasoning: true,
    reasoningAllowedOptions: [...GLM53_REASONING_OPTIONS],
    reasoningDefault: 'max',
    contextLength: null,
    loadState: null,
    sources: { reasoning: 'assumed' },
    probeErrors: {},
  };
}

/** Empty capability shell used when Qwen3.8 is selected but not in modelCache. */
function qwen38AssumedCapabilities(): ModelCapabilities {
  return {
    vision: null,
    tools: null,
    streaming: null,
    grammar: null,
    reasoning: true,
    reasoningAllowedOptions: [...QWEN38_REASONING_OPTIONS],
    reasoningDefault: 'high',
    contextLength: null,
    loadState: null,
    sources: { reasoning: 'assumed' },
    probeErrors: {},
  };
}

function deepSeekV4AssumedCapabilities(): ModelCapabilities {
  return {
    vision: null,
    tools: null,
    streaming: null,
    grammar: null,
    reasoning: true,
    reasoningAllowedOptions: [...DEEPSEEK_V4_REASONING_OPTIONS],
    reasoningDefault: 'high',
    contextLength: null,
    loadState: null,
    sources: { reasoning: 'assumed' },
    probeErrors: {},
  };
}

/** Force GLM-5.3 Low/High/Max onto a capability object (composer dropdown). */
function withGlm53ReasoningLevels(
  modelId: string,
  caps: ModelCapabilities,
): ModelCapabilities {
  if (!isGlm53ModelId(modelId)) return caps;
  const reasoningAllowedOptions = ensureGlm53ReasoningAllowedOptions(
    modelId,
    caps.reasoningAllowedOptions ?? [],
  );
  return {
    ...caps,
    reasoning: true,
    reasoningAllowedOptions,
    reasoningDefault: resolveCatalogReasoningDefault(
      modelId,
      reasoningAllowedOptions,
      caps.reasoningDefault,
    ),
  };
}

/** Force Qwen3.8 Low/Medium/High onto a capability object (composer dropdown). */
function withQwen38ReasoningLevels(
  modelId: string,
  caps: ModelCapabilities,
): ModelCapabilities {
  if (!isQwen38ModelId(modelId)) return caps;
  const reasoningAllowedOptions = ensureQwen38ReasoningAllowedOptions(
    modelId,
    caps.reasoningAllowedOptions ?? [],
  );
  return {
    ...caps,
    reasoning: true,
    reasoningAllowedOptions,
    reasoningDefault: resolveCatalogReasoningDefault(
      modelId,
      reasoningAllowedOptions,
      caps.reasoningDefault,
    ),
  };
}

/** Apply family-specific reasoning option overrides (Qwen3.8, then GLM-5.3). */
function withFamilyReasoningLevels(
  modelId: string,
  caps: ModelCapabilities,
): ModelCapabilities {
  const family = withGlm53ReasoningLevels(modelId, withQwen38ReasoningLevels(modelId, caps));
  if (!isDeepSeekV4ModelId(modelId)) return family;
  const reasoningAllowedOptions = ensureDeepSeekV4ReasoningAllowedOptions(
    modelId,
    family.reasoningAllowedOptions ?? [],
  );
  return {
    ...family,
    reasoning: true,
    reasoningAllowedOptions,
    reasoningDefault: resolveCatalogReasoningDefault(
      modelId,
      reasoningAllowedOptions,
      family.reasoningDefault,
    ),
  };
}

// ── Resolve ──────────────────────────────────────────────────────────────────

/**
 * Resolve send-time capabilities for a provider-bound model row.
 * Re-applies openai-v1 inference when cached caps lack selectable reasoning options.
 */
export function resolveSendCapabilities(
  providerId: string,
  modelId: string,
  apiKind?: ApiKind,
): ModelCapabilities | undefined {
  const pid = providerId.trim();
  const mid = modelId.trim();
  if (!pid || !mid) return undefined;

  const row = findModelCacheRow(pid, mid);
  if (!row) {
    if (isGlm53ModelId(mid)) return glm53AssumedCapabilities();
    if (isDeepSeekV4ModelId(mid)) return deepSeekV4AssumedCapabilities();
    return isQwen38ModelId(mid) ? qwen38AssumedCapabilities() : undefined;
  }

  const kind =
    apiKind ?? getCachedProviderList()?.providers.find((p) => p.id === pid)?.apiKind;
  const fromCatalog = catalogCapabilitiesFromRow(row, kind);
  const cached = row.capabilities;
  const familyId =
    isGlm53ModelId(mid) || isQwen38ModelId(mid) || isDeepSeekV4ModelId(mid) ? mid : row.id;

  if (!cached) return withFamilyReasoningLevels(familyId, fromCatalog);

  const cachedHasLevels = modelHasReasoningEffortLevels(cached);
  const catalogHasLevels = modelHasReasoningEffortLevels(fromCatalog);
  const cachedAllowed = cached.reasoningAllowedOptions?.length ?? 0;
  const catalogAllowed = fromCatalog.reasoningAllowedOptions?.length ?? 0;
  if ((catalogAllowed >= 2 && cachedAllowed < 2) || (catalogHasLevels && !cachedHasLevels)) {
    return withFamilyReasoningLevels(familyId, {
      ...cached,
      reasoning: fromCatalog.reasoning ?? cached.reasoning,
      reasoningAllowedOptions: fromCatalog.reasoningAllowedOptions,
      reasoningDefault: fromCatalog.reasoningDefault ?? cached.reasoningDefault,
      reasoningThinkingEnabledValue:
        cached.reasoningThinkingEnabledValue ?? fromCatalog.reasoningThinkingEnabledValue,
    });
  }

  if (!cached.reasoningThinkingEnabledValue && fromCatalog.reasoningThinkingEnabledValue) {
    return withFamilyReasoningLevels(familyId, {
      ...cached,
      reasoningThinkingEnabledValue: fromCatalog.reasoningThinkingEnabledValue,
    });
  }

  return withFamilyReasoningLevels(familyId, cached);
}

/**
 * Merge catalog row with persisted probe file entry.
 * Catalog wins when probe source is not set for a field that catalog provides.
 */
export function mergeModelCapabilities(
  row: LmModelRecord,
  fromFile?: ModelCapabilities | null,
): ModelCapabilities {
  const catalog = catalogCapabilitiesFromRow(row);
  if (!fromFile) return catalog;

  const merged: ModelCapabilities = { ...catalog };

  const preferProbe = (field: keyof ModelCapabilities, catalogValue: boolean | number | null) => {
    const fileValue = fromFile[field];
    if (fileValue === null || fileValue === undefined) return;
    const source = fromFile.sources?.[field as keyof ModelCapabilities];
    if (source === 'catalog' && catalogValue !== null && catalogValue !== undefined) {
      merged[field] = catalogValue as never;
      return;
    }
    merged[field] = fileValue as never;
    if (source) {
      merged.sources = { ...merged.sources, [field]: source };
    }
  };

  preferProbe('vision', catalog.vision);
  preferProbe('tools', catalog.tools);
  preferProbe('streaming', catalog.streaming);
  preferProbe('grammar', catalog.grammar);
  preferProbe('reasoning', catalog.reasoning);
  if (fromFile.reasoningAllowedOptions?.length) {
    merged.reasoningAllowedOptions = [...fromFile.reasoningAllowedOptions];
  } else if (catalog.reasoningAllowedOptions?.length) {
    merged.reasoningAllowedOptions = [...catalog.reasoningAllowedOptions];
  }
  if (fromFile.reasoningDefault) {
    merged.reasoningDefault = fromFile.reasoningDefault;
  } else if (catalog.reasoningDefault) {
    merged.reasoningDefault = catalog.reasoningDefault;
  }
  if (fromFile.reasoningThinkingEnabledValue) {
    merged.reasoningThinkingEnabledValue = fromFile.reasoningThinkingEnabledValue;
  } else if (catalog.reasoningThinkingEnabledValue) {
    merged.reasoningThinkingEnabledValue = catalog.reasoningThinkingEnabledValue;
  }
  preferProbe('contextLength', catalog.contextLength);
  if (fromFile.loadState) {
    merged.loadState = fromFile.loadState;
    if (fromFile.sources?.loadState) {
      merged.sources = { ...merged.sources, loadState: fromFile.sources.loadState };
    }
  }
  if (fromFile.probeErrors && Object.keys(fromFile.probeErrors).length > 0) {
    merged.probeErrors = { ...catalog.probeErrors, ...fromFile.probeErrors };
  }
  if (fromFile.api) {
    merged.api = fromFile.api;
  } else if (catalog.api) {
    merged.api = catalog.api;
  }

  return withFamilyReasoningLevels(row.id, merged);
}

/** Attach merged capabilities to every matching modelCache row for a provider file. */
export function mergeCapabilitiesIntoModelCache(file: ProviderCapabilitiesFile): void {
  lastAppliedCapabilities = file;
  applyProviderCapabilities(file);
}

/** GET persisted capabilities for a provider. */
export async function fetchProviderCapabilities(
  providerId: string,
  signal?: AbortSignal,
): Promise<ProviderCapabilitiesFile> {
  const encoded = encodeURIComponent(providerId);
  const res = await fetch(`/api/providers/${encoded}/capabilities`, {
    signal,
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new Error(`Capabilities HTTP ${res.status}`);
  }
  const json = (await res.json()) as ProviderCapabilitiesFile;
  return json;
}

// ── Probe ────────────────────────────────────────────────────────────────────

/** POST capability probe; returns updated file. */
export async function runCapabilityProbe(
  providerId: string,
  options: {
    modelIds?: string[];
    selectedModelId?: string;
    signal?: AbortSignal;
    /** First-load background probe — server skips vision on loopback openai-v1. */
    auto?: boolean;
    skipVision?: boolean;
  } = {},
): Promise<ProviderCapabilitiesFile> {
  const encoded = encodeURIComponent(providerId);
  const res = await fetch(`/api/providers/${encoded}/capabilities/probe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      modelIds: options.modelIds,
      selectedModelId: options.selectedModelId,
      ...(options.auto === true ? { auto: true } : {}),
      ...(options.skipVision === true ? { skipVision: true } : {}),
    }),
    signal: options.signal,
    cache: 'no-store',
  });
  if (!res.ok) {
    const text = await res.text();
    let message = `Probe HTTP ${res.status}`;
    try {
      const errJson = JSON.parse(text) as { error?: string };
      if (errJson.error) message = errJson.error;
    } catch {
      if (text.trim()) message = text.slice(0, 200);
    }
    throw new Error(message);
  }
  return (await res.json()) as ProviderCapabilitiesFile;
}

/** All loaded canonical model ids for a provider (from modelCache). */
export function findLoadedModelIdsForProvider(providerId: string): string[] {
  const pid = providerId.trim();
  if (!pid) return [];

  const loaded: string[] = [];
  for (const [key, row] of modelCache.entries()) {
    const decoded = decodeModelSelectKey(key);
    if (!decoded || decoded.providerId !== pid) continue;
    if (!isModelLoaded(row.state)) continue;
    loaded.push(decoded.modelId);
  }
  return [...new Set(loaded)];
}

/** All catalog model ids for a provider (from modelCache), regardless of load state. */
export function findCatalogModelIdsForProvider(providerId: string): string[] {
  const pid = providerId.trim();
  if (!pid) return [];

  const ids: string[] = [];
  for (const [key] of modelCache.entries()) {
    const decoded = decodeModelSelectKey(key);
    if (!decoded || decoded.providerId !== pid) continue;
    ids.push(decoded.modelId);
  }
  return [...new Set(ids)];
}

/**
 * Model id to use for capability probes: prefers the top-bar / chat selection when
 * it belongs to this provider; cloud providers may use any catalog row (not only loaded).
 */
export function findProbeModelIdForProvider(
  providerId: string,
  preferredModelId?: string,
  apiKind?: ApiKind,
): string | null {
  const isLmStudio = apiKind === 'lm-studio-v0';
  const candidateIds = isLmStudio
    ? findLoadedModelIdsForProvider(providerId)
    : findCatalogModelIdsForProvider(providerId);
  if (candidateIds.length === 0) return null;

  const preferredCanonical = preferredModelId
    ? decodeModelSelectKey(preferredModelId)?.modelId ?? preferredModelId.trim()
    : undefined;
  const [pick] = prioritizeModelIdsForProbe(candidateIds, preferredCanonical);
  return pick ?? null;
}

/**
 * First loaded model id for a provider (selected chat model preferred when loaded).
 */
export function findLoadedModelIdForProvider(
  providerId: string,
  selectedModelId?: string,
): string | null {
  const loaded = findLoadedModelIdsForProvider(providerId);
  if (loaded.length === 0) return null;
  const [first] = prioritizeModelIdsForProbe(loaded, selectedModelId);
  return first ?? null;
}

/**
 * Prioritize model ids for probe (selected → loaded → alphabetical), cap at 8.
 */
export function prioritizeModelIdsForProbe(
  modelIds: string[],
  selectedModelId?: string,
): string[] {
  const selectedCanonical = selectedModelId
    ? decodeModelSelectKey(selectedModelId)?.modelId ?? selectedModelId
    : undefined;
  const loaded = new Set(
    [...modelCache.entries()]
      .filter(([, row]) => row.state === 'loaded')
      .map(([id]) => decodeModelSelectKey(id)?.modelId ?? id),
  );
  const score = (id: string) => {
    if (selectedCanonical && id === selectedCanonical) return 0;
    if (loaded.has(id)) return 1;
    return 2;
  };
  return [...new Set(modelIds)]
    .sort((a, b) => {
      const sa = score(a);
      const sb = score(b);
      if (sa !== sb) return sa - sb;
      return a.localeCompare(b);
    })
    .slice(0, 8);
}

export const NO_LOADED_MODEL_MATRIX_PROBE_MSG =
  'No loaded model found. Load a model in LM Studio, then run the probe again.';

/** True while a Settings-initiated matrix probe is in flight. */
export function isManualCapabilityProbeInFlight(): boolean {
  return probeAbort !== null && probeIsManual;
}

/** Run capability matrix probe (Settings → Providers button; optional model id filter). */
export async function runCapabilityProbeForProvider(
  providerId: string,
  options: {
    modelIds?: string[];
    selectedModelId?: string;
    apiKind?: ApiKind;
    /** Settings button — may abort an in-flight first-load probe. */
    manual?: boolean;
    /** First-load background probe — skip vision on loopback openai-v1 (MIN-839). */
    auto?: boolean;
    skipVision?: boolean;
  } = {},
): Promise<boolean> {
  if (!isServerStorageMode()) return false;

  const isManual = options.manual === true;
  if (probeAbort) {
    if (isManual) {
      probeAbort.abort();
    } else {
      return false;
    }
  }
  const controller = new AbortController();
  probeAbort = controller;
  probeIsManual = isManual;

  try {
    let modelIds = options.modelIds;
    const apiKind = options.apiKind;
    if (apiKind === 'lm-studio-v0' && modelIds === undefined) {
      const loadedIds = findLoadedModelIdsForProvider(providerId);
      if (loadedIds.length === 0) {
        throw new Error(NO_LOADED_MODEL_MATRIX_PROBE_MSG);
      }
      modelIds = loadedIds;
    }

    const prioritized =
      modelIds !== undefined
        ? prioritizeModelIdsForProbe(modelIds, options.selectedModelId)
        : undefined;
    const file = await runCapabilityProbe(providerId, {
      modelIds: prioritized,
      selectedModelId: options.selectedModelId,
      signal: controller.signal,
      auto: options.auto === true,
      skipVision: options.skipVision === true,
    });
    if (probeAbort === controller) {
      mergeCapabilitiesIntoModelCache(file);
    }
    return true;
  } catch (err) {
    const e = err as { name?: string };
    if (e?.name === 'AbortError') return false;
    throw err;
  } finally {
    if (probeAbort === controller) {
      probeAbort = null;
      probeIsManual = false;
    }
  }
}

/** Whether merged capabilities indicate vision / VLM support. */
export function modelSupportsVision(modelId: string | undefined): boolean {
  if (!modelId) return false;
  let row = modelCache.get(modelId);
  if (!row) {
    const key = findFirstSelectKeyForCanonicalModelId(modelCache.keys(), modelId);
    if (key) row = modelCache.get(key);
  }
  if (!row) return false;
  const caps = row.capabilities ?? catalogCapabilitiesFromRow(row);
  if (caps.vision === true) return true;
  if (caps.vision === false) return false;
  return catalogRowHasVision(row);
}
