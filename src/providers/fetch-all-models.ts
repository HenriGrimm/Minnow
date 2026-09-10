/**
 * Load model catalogs from every enabled provider in parallel (top-bar picker).
 */

import { fetchModelsForProvider } from './fetch-models';
import type { ProviderPublic } from './types';
import type { LmModelRecord } from '../types';

export interface ProviderModelsResult {
  provider: ProviderPublic;
  models: LmModelRecord[];
  error?: string;
}

/**
 * Fetch /models for each enabled provider. Uses allSettled so one failure does not drop the rest.
 * Providers are returned in the same order as the input list.
 */
/** Providers without a base URL (e.g. agent CLI) have no HTTP model catalog. */
function providerHasHttpCatalog(provider: ProviderPublic): boolean {
  return Boolean(provider.baseUrl?.trim());
}

export async function fetchModelsForAllProviders(
  providers: ProviderPublic[],
  signal: AbortSignal,
): Promise<ProviderModelsResult[]> {
  const settled = await Promise.allSettled(
    providers.map(async (provider) => {
      if (!providerHasHttpCatalog(provider)) {
        return { provider, models: [] } satisfies Omit<ProviderModelsResult, 'error'>;
      }
      const models = await fetchModelsForProvider(provider, signal);
      return { provider, models } satisfies Omit<ProviderModelsResult, 'error'>;
    }),
  );

  const out: ProviderModelsResult[] = [];
  for (let i = 0; i < settled.length; i++) {
    const provider = providers[i];
    const r = settled[i];
    if (r.status === 'fulfilled') {
      out.push(r.value);
    } else {
      const reason = r.reason;
      const message = reason instanceof Error ? reason.message : String(reason);
      out.push({ provider, models: [], error: message });
    }
  }
  return out;
}
