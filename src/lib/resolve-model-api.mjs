/**
 * Resolve which upstream API a model should use within a provider entry.
 * Shared by server generations pump and client model catalog normalization.
 */

import { isOpenCodeGoBaseUrl, shouldUseOpenAiResponses } from './openai-responses-route.mjs';

// Go's published transport is provider-specific, not the model's architecture.
// https://opencode.ai/docs/go/#endpoints
const GO_MESSAGES_MODELS = new Set([
  'minimax-m3', 'minimax-m2.7', 'minimax-m2.5',
  'qwen3.8-max', 'qwen3.8-flash', 'qwen3.7-max', 'qwen3.7-plus', 'qwen3.6-plus',
  'union-alpha',
]);

/** @typedef {'lm-studio-v0' | 'openai-v1' | 'anthropic-v1' | 'agent-cli-v1'} ApiKind */
/** @typedef {ApiKind | 'openai-responses'} GenerationApiKind */

const API_KINDS = new Set(['lm-studio-v0', 'openai-v1', 'anthropic-v1', 'agent-cli-v1']);

/**
 * @param {unknown} value
 * @returns {ApiKind | null}
 */
function coerceApiKind(value) {
  if (typeof value === 'string' && API_KINDS.has(value)) {
    return /** @type {ApiKind} */ (value);
  }
  return null;
}

/**
 * Heuristic + catalog signals for Anthropic Messages routing on mixed gateways.
 *
 * @param {string} modelId
 * @param {{ owned_by?: string, arch?: string, family?: string, api?: string } | null | undefined} modelMeta
 * @returns {boolean}
 */
export function modelLooksAnthropic(modelId, modelMeta) {
  if (modelMeta) {
    const tagged = coerceApiKind(modelMeta.api);
    if (tagged === 'anthropic-v1') return true;
    if (tagged === 'openai-v1') return false;

    const ownedBy = typeof modelMeta.owned_by === 'string' ? modelMeta.owned_by.trim().toLowerCase() : '';
    if (ownedBy === 'anthropic') return true;

    const arch = typeof modelMeta.arch === 'string' ? modelMeta.arch.trim().toLowerCase() : '';
    if (arch === 'anthropic') return true;

    const family = typeof modelMeta.family === 'string' ? modelMeta.family.trim().toLowerCase() : '';
    if (family === 'anthropic') return true;
  }

  const id = String(modelId || '').trim();
  if (!id) return false;
  if (id.startsWith('anthropic/')) return true;
  return /(^|[/:])claude|anthropic/i.test(id);
}

/**
 * @param {{ profile?: { apiKind?: string, autoApi?: boolean, modelApiOverrides?: Record<string, string> } } | { apiKind?: string, autoApi?: boolean, modelApiOverrides?: Record<string, string> }} runtimeOrProfile
 * @param {string} modelId
 * @param {{ owned_by?: string, arch?: string, family?: string, api?: string } | null | undefined} [modelMeta]
 * @returns {ApiKind}
 */
export function resolveModelApi(runtimeOrProfile, modelId, modelMeta) {
  const profile =
    runtimeOrProfile && typeof runtimeOrProfile === 'object' && runtimeOrProfile.profile
      ? runtimeOrProfile.profile
      : runtimeOrProfile;

  const overrides =
    profile && typeof profile === 'object' && profile.modelApiOverrides
      ? profile.modelApiOverrides
      : undefined;

  if (overrides && typeof overrides === 'object') {
    const override = coerceApiKind(overrides[modelId]);
    if (override) return override;
  }

  const baseKind = coerceApiKind(profile?.apiKind) ?? 'openai-v1';
  const bareModelId = String(modelId || '').trim().toLowerCase().split('/').pop();
  if (baseKind === 'openai-v1' && isOpenCodeGoBaseUrl(profile?.baseUrl) && GO_MESSAGES_MODELS.has(bareModelId)) {
    return 'anthropic-v1';
  }
  if (!profile?.autoApi || baseKind !== 'openai-v1') {
    return baseKind;
  }

  return modelLooksAnthropic(modelId, modelMeta) ? 'anthropic-v1' : 'openai-v1';
}

/**
 * Unwrap a runtime `{ profile }` wrapper or a bare profile object.
 *
 * @param {unknown} runtimeOrProfile
 * @returns {Record<string, unknown> | null}
 */
function profileFromRuntime(runtimeOrProfile) {
  if (!runtimeOrProfile || typeof runtimeOrProfile !== 'object') return null;
  const wrapped = /** @type {{ profile?: unknown }} */ (runtimeOrProfile).profile;
  if (wrapped && typeof wrapped === 'object') {
    return /** @type {Record<string, unknown>} */ (wrapped);
  }
  return /** @type {Record<string, unknown>} */ (runtimeOrProfile);
}

/**
 * Pump-side transport: same as `resolveModelApi`, plus OpenCode Go Responses models.
 * Catalog rows stay `openai-v1` so thinking/tools UI keep Chat Completions semantics.
 *
 * @param {{ profile?: { apiKind?: string, autoApi?: boolean, modelApiOverrides?: Record<string, string>, baseUrl?: string } } | { apiKind?: string, autoApi?: boolean, modelApiOverrides?: Record<string, string>, baseUrl?: string }} runtimeOrProfile
 * @param {string} modelId
 * @param {{ owned_by?: string, arch?: string, family?: string, api?: string } | null | undefined} [modelMeta]
 * @returns {GenerationApiKind}
 */
export function resolveGenerationApi(runtimeOrProfile, modelId, modelMeta) {
  const kind = resolveModelApi(runtimeOrProfile, modelId, modelMeta);
  if (kind !== 'openai-v1') return kind;
  const profile = profileFromRuntime(runtimeOrProfile);
  const baseUrl = typeof profile?.baseUrl === 'string' ? profile.baseUrl : '';
  if (shouldUseOpenAiResponses(baseUrl, modelId)) {
    return 'openai-responses';
  }
  return kind;
}
