import { PROVIDER_ID_BY_ENGINE, MTPLX_LOCAL_ID, isLocalServeProviderId } from '../../src/models/engine-ids.mjs';
import { listProviders, MINNOW_LIBRARY_PROVIDER_ID } from '../providers/store.js';
import { proxyModels } from '../providers/proxy.js';
import { readCapabilities } from '../providers/capabilities-store.js';
import { LLAMA_CPP_LOCAL_ID, MLX_LM_LOCAL_ID } from '../../src/models/runtime-ids.mjs';
import {
  findLibraryCachedRow,
  isLibraryModelBinding,
  libraryCachedRowHasVision,
  resolveLibraryCachedTarget,
  resolveLibraryIdForProviderModel,
} from '../models/library-binding.js';
import { listServes } from '../models/serve.js';
import { getLaunchPrefs } from '../models/launch-prefs.js';
import { serveMatchesModelId } from '../models/admit-serve.js';
import { libraryServePhase } from './library-serve.js';

const catalogs = new Map();

export function invalidateRouterProvider(providerId) { catalogs.delete(providerId); }

function isLiveStatus(status) {
  return status === 'running' || status === 'starting' || status === 'unhealthy';
}

async function libraryAvailabilityForEntry(entry, body, capabilitiesByProvider) {
  const libraryId =
    (await resolveLibraryIdForProviderModel(entry.providerId, entry.modelId)) ||
    (isLibraryModelBinding(entry.providerId, entry.modelId) ? entry.modelId : null);
  if (!libraryId) {
    return { available: false, reason: 'Model unavailable' };
  }
  const target = await resolveLibraryCachedTarget(libraryId);
  if (!target) return { available: false, reason: 'Model unavailable' };

  const vision = (body.messages || []).some((m) => Array.isArray(m.content) && m.content.some((c) => c.type === 'image_url'));
  const row = await findLibraryCachedRow(libraryId);
  const catalogVision = libraryCachedRowHasVision(row);
  const runtimeId = PROVIDER_ID_BY_ENGINE[target.runtime] ?? LLAMA_CPP_LOCAL_ID;
  const capabilities =
    capabilitiesByProvider.get(MINNOW_LIBRARY_PROVIDER_ID)?.models?.[libraryId] ||
    capabilitiesByProvider.get(runtimeId)?.models?.[libraryId] ||
    capabilitiesByProvider.get(runtimeId)?.models?.[entry.modelId];

  let reason = 'Available';
  if (vision && !(capabilities?.vision === true || catalogVision)) reason = 'Image input unsupported or unverified';
  if (vision && capabilities?.vision === false && capabilities.sources?.vision === 'probe') reason = 'Image input unsupported';
  if (vision && (await getLaunchPrefs().catch(() => null))?.byLibraryId?.[libraryId]?.no_mmproj === true) {
    reason = 'Vision turned off in load settings';
  }
  if (body.tools?.length && capabilities?.tools === false) reason = 'Tool calling unsupported';
  if (body.stream !== false && capabilities?.streaming === false) reason = 'Streaming unsupported';
  if (reason !== 'Available') return { available: false, reason };

  const phase = libraryServePhase(libraryId);
  if (phase === 'waiting') return { available: true, reason: 'Waiting for GPU' };
  if (phase === 'loading') return { available: true, reason: 'Loading' };

  const serves = await listServes().catch(() => []);
  const loaded = (Array.isArray(serves) ? serves : []).some(
    (serve) =>
      serve &&
      isLiveStatus(serve.status) &&
      (serve.libraryId === libraryId || serveMatchesModelId(serve, libraryId) || serveMatchesModelId(serve, entry.modelId)),
  );
  return { available: true, reason: loaded ? 'Available' : 'Available · not loaded' };
}

export async function routerAvailability(router, body = {}) {
  const { providers } = await listProviders();
  const results = new Map();
  const capabilitiesByProvider = new Map();
  const providerIds = [...new Set(router.entries.map((e) => e.providerId))];
  await Promise.all(providerIds.map(async (id) => {
    if (id === MINNOW_LIBRARY_PROVIDER_ID) {
      results.set(id, { library: true });
      try { capabilitiesByProvider.set(id, await readCapabilities(id)); } catch { capabilitiesByProvider.set(id, { models: {} }); }
      return;
    }
    const provider = providers.find((p) => p.id === id && p.enabled !== false);
    if (!provider) { results.set(id, { error: 'Provider missing or disabled' }); return; }
    let cached = catalogs.get(id);
    if (!cached || cached.expires < Date.now()) {
      const promise = proxyModels(id).catch(() => ({ data: [], error: 'Provider unavailable or credentials rejected' }));
      cached = { expires: Date.now() + 10000, promise };
      catalogs.set(id, cached);
    }
    results.set(id, await cached.promise);
    capabilitiesByProvider.set(id, await readCapabilities(id));
  }));
  try {
    capabilitiesByProvider.set(LLAMA_CPP_LOCAL_ID, await readCapabilities(LLAMA_CPP_LOCAL_ID));
  } catch { capabilitiesByProvider.set(LLAMA_CPP_LOCAL_ID, { models: {} }); }
  try {
    capabilitiesByProvider.set(MTPLX_LOCAL_ID, await readCapabilities(MTPLX_LOCAL_ID));
    capabilitiesByProvider.set(MLX_LM_LOCAL_ID, await readCapabilities(MLX_LM_LOCAL_ID));
  } catch { capabilitiesByProvider.set(MLX_LM_LOCAL_ID, { models: {} }); }

  const vision = (body.messages || []).some((m) => Array.isArray(m.content) && m.content.some((c) => c.type === 'image_url'));
  return Object.fromEntries(await Promise.all(router.entries.map(async (entry) => {
    if (!router.enabled) return [entry.id, { available: false, reason: 'Router disabled' }];
    if (!entry.enabled) return [entry.id, { available: false, reason: 'Entry disabled' }];
    if (
      entry.providerId === MINNOW_LIBRARY_PROVIDER_ID ||
      isLibraryModelBinding(entry.providerId, entry.modelId) ||
      isLocalServeProviderId(entry.providerId)
    ) {
      const library = await libraryAvailabilityForEntry(entry, body, capabilitiesByProvider);
      if (library.reason !== 'Model unavailable' || entry.providerId === MINNOW_LIBRARY_PROVIDER_ID) {
        return [entry.id, library];
      }
    }
    const catalog = results.get(entry.providerId);
    const model = catalog?.data?.find((m) => m.id === entry.modelId);
    const capabilities = capabilitiesByProvider.get(entry.providerId)?.models?.[entry.modelId];
    let reason = catalog?.error || (!model ? 'Model unavailable' : 'Available');
    if (model?.enabled === false || model?.type === 'embeddings' || model?.type === 'embedding') reason = 'Model unavailable for chat';
    if (model && vision && !(capabilities?.vision === true || model.catalogVision === true || model.type === 'vlm')) reason = 'Image input unsupported or unverified';
    if (model && vision && capabilities?.vision === false && capabilities.sources?.vision === 'probe') reason = 'Image input unsupported';
    if (model && body.tools?.length && capabilities?.tools === false) reason = 'Tool calling unsupported';
    if (model && body.stream !== false && capabilities?.streaming === false) reason = 'Streaming unsupported';
    return [entry.id, { available: reason === 'Available', reason }];
  })));
}
