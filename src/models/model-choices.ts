import { listProviders } from '../providers/store';
import { fetchModelsForAllProviders } from '../providers/fetch-all-models';
import { fetchLibraryModelSelectMerge, omitLocalRuntimeCatalogModels } from './model-select-library';
import { loadRouterConfig } from './routers';
import { encodeModelSelectKey } from '../lib/model-select-key';
import { setModelCatalogEntries } from './selection';

export interface ModelChoice { value: string; label: string; group: string }

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
      choices.push({ value: encodeModelSelectKey(result.provider.id, model.id), label: model.id, group: result.provider.label });
    }
  }
  for (const model of library?.library ?? []) choices.push({ value: encodeModelSelectKey('minnow-library', model.id), label: model.name, group: 'My Models' });
  for (const pool of pools.routers.filter((pool) => pool.enabled)) choices.push({ value: encodeModelSelectKey('minnow-router', pool.id), label: pool.name, group: 'Model pools' });
  setModelCatalogEntries(choices);
  return choices;
}
