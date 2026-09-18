/**
 * Fetch model list for a resolved provider (direct or proxy).
 */

import type { LmModelRecord } from '../types';
import { resolveModelApi } from './resolve-model-api';
import { resolveProviderEndpoints } from './resolve';
import type { ProviderPublic } from './types';

/** Normalize provider model rows to LM Studio-shaped records for modelCache. */
export function normalizeModelsForUi(
  provider: ProviderPublic,
  data: LmModelRecord[],
): LmModelRecord[] {
  const apiKind = provider.apiKind;
  return data.map((m) => ({
    id: m.id,
    type:
      m.type ||
      (apiKind === 'openai-v1' || apiKind === 'anthropic-v1' || apiKind === 'agent-cli-v1'
        ? 'llm'
        : m.type),
    state:
      m.state ||
      (apiKind === 'openai-v1' || apiKind === 'anthropic-v1' || apiKind === 'agent-cli-v1'
        ? 'loaded'
        : m.state),
    arch: m.arch,
    quantization: m.quantization,
    max_context_length: m.max_context_length,
    loaded_context_length: m.loaded_context_length,
    ...(m.owned_by ? { owned_by: m.owned_by } : {}),
    ...(m.family ? { family: m.family } : {}),
    api: m.api ?? resolveModelApi(provider, m.id, m),
    ...(m.reasoning ? { reasoning: m.reasoning } : {}),
    ...(m.catalogVision !== undefined ? { catalogVision: m.catalogVision } : {}),
  }));
}

/**
 * GET models for provider; returns filtered llm/vlm rows.
 */
export async function fetchModelsForProvider(
  provider: ProviderPublic,
  signal: AbortSignal,
): Promise<LmModelRecord[]> {
  const endpoints = resolveProviderEndpoints(provider);
  const res = await fetch(endpoints.modelsUrl, { signal, cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const json = (await res.json()) as {
    data?: LmModelRecord[];
    unreachable?: boolean;
    error?: string;
  };
  // 200 + unreachable: host is down (LM Studio off). Keep picker "unreachable" without a 500.
  if (json.unreachable) {
    throw new Error(json.error?.trim() || 'Provider unreachable');
  }
  const raw = json.data || [];
  const normalized = normalizeModelsForUi(provider, raw);
  return normalized.filter((m) => m.type === 'llm' || m.type === 'vlm');
}
