import { listProviders } from '../providers/store';
import { fetchModelsForAllProviders } from '../providers/fetch-all-models';
import { fetchLibraryModelSelectMerge, omitLocalRuntimeCatalogModels } from './model-select-library';
import { loadRouterConfig } from './routers';
import { encodeModelSelectKey } from '../lib/model-select-key';
import { setModelCatalogEntries } from './selection';
import { modelCache } from '../app-state';
import { catalogCapabilitiesFromRow, mergeModelCapabilities } from '../providers/model-capabilities';
import { formatModelLabel } from '../lib/format-model-label';
import { isKnownLocalProviderId, isLocalProviderBaseUrl } from '../providers/provider-host';

export interface ModelChoice { value: string; label: string; group: string; host?: 'local' | 'cloud' }

/** Independent catalog for setup, launch controls and system routing. */
export async function loadModelChoices(signal: AbortSignal): Promise<ModelChoice[]> {
  const { providers } = await listProviders();
  const [catalogs, library, pools] = await Promise.all([
    fetchModelsForAllProviders(providers.filter((provider) => provider.enabled !== false), signal),
    fetchLibraryModelSelectMerge().catch(() => null),
    loadRouterConfig(),
  ]);
  signal.throwIfAborted();
  const choices: ModelChoice[] = [];
  for (const result of omitLocalRuntimeCatalogModels(catalogs)) {
    for (const model of result.models) {
      if (model.type !== 'llm' && model.type !== 'vlm') continue;
      const value = encodeModelSelectKey(result.provider.id, model.id);
      modelCache.set(value, { ...model, capabilities: mergeModelCapabilities(model,
        modelCache.get(value)?.capabilities ?? catalogCapabilitiesFromRow(model, result.provider.apiKind)) });
      choices.push({ value, label: formatModelLabel(model).optionText, group: result.provider.label,
        host: isKnownLocalProviderId(result.provider.id) || isLocalProviderBaseUrl(result.provider.baseUrl) ? 'local' : 'cloud' });
    }
  }
  for (const model of library?.library ?? []) choices.push({ value: encodeModelSelectKey('minnow-library', model.id), label: model.name, group: 'My Models', host: 'local' });
  for (const { key, row } of library?.cacheEntries ?? []) modelCache.set(key,
    { ...row, capabilities: mergeModelCapabilities(row, modelCache.get(key)?.capabilities ?? row.capabilities) });
  for (const pool of pools.routers.filter((pool) => pool.enabled)) choices.push({ value: encodeModelSelectKey('minnow-router', pool.id), label: pool.name, group: 'Model pools' });
  setModelCatalogEntries(choices);
  return choices;
}
