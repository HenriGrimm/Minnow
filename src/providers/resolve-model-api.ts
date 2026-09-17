/**
 * TypeScript wrapper for shared per-model API resolution.
 */

import { resolveModelApi as resolveModelApiCore } from '../lib/resolve-model-api.mjs';
import type { ApiKind, ProviderPublic } from '../providers/types';
import type { LmModelRecord } from '../types';

type ModelMeta = Pick<LmModelRecord, 'id' | 'api' | 'owned_by' | 'arch'> & {
  family?: string;
};

/** Resolve the upstream API for a model within a provider entry. */
export function resolveModelApi(
  provider: Pick<ProviderPublic, 'apiKind' | 'autoApi' | 'modelApiOverrides'> & { baseUrl?: string },
  modelId: string,
  modelMeta?: ModelMeta | null,
): ApiKind {
  return resolveModelApiCore({ profile: provider }, modelId, modelMeta ?? undefined);
}

/** Resolved API for a cached model row, falling back to provider profile. */
export function resolvedApiForModel(
  provider: Pick<ProviderPublic, 'apiKind' | 'autoApi' | 'modelApiOverrides'> & { baseUrl?: string },
  modelRow?: Pick<LmModelRecord, 'id' | 'api' | 'owned_by' | 'arch'> | null,
): ApiKind {
  if (modelRow?.api === 'anthropic-v1' || modelRow?.api === 'openai-v1' || modelRow?.api === 'lm-studio-v0') {
    return modelRow.api;
  }
  return resolveModelApi(provider, modelRow?.id ?? '', modelRow ?? undefined);
}
