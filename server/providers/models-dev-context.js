/**
 * Enrich hosted model lists whose /models response omits context metadata.
 * OpenCode also uses models.dev as the authority for vision metadata.
 */

const MODELS_DEV_URL = 'https://models.dev/api.json';
const MODELS_DEV_TIMEOUT_MS = 20_000;
/** Refresh catalog daily; limits change infrequently. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * @typedef {{
 *   limit?: { context?: number },
 *   attachment?: boolean,
 *   modalities?: { input?: string[], output?: string[] },
 * }} ModelsDevEntry
 */

/** @type {{ fetchedAt: number, catalog: Record<string, { api?: string, models?: Record<string, ModelsDevEntry> }> | null, pending: Promise<object> | null }} */
const cache = { fetchedAt: 0, catalog: null, pending: null };

const HOSTED_PROVIDER_IDS = new Map([
  ['api.openai.com', 'openai'],
  ['api.anthropic.com', 'anthropic'],
  ['api.groq.com', 'groq'],
  ['api.mistral.ai', 'mistral'],
  ['api.deepseek.com', 'deepseek'],
]);

/**
 * @param {string} baseUrl
 */
export function isOpenCodeProviderBaseUrl(baseUrl) {
  const raw = typeof baseUrl === 'string' ? baseUrl.trim() : '';
  if (!raw) return false;
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return host === 'opencode.ai' || host.endsWith('.opencode.ai');
  } catch {
    return false;
  }
}

/**
 * OpenCode Go origin (`/zen/go`), not Zen (`/zen`).
 * Re-export of the shared helper so server callers stay on one import.
 *
 * @param {string | null | undefined} baseUrl
 * @returns {boolean}
 */
export { isOpenCodeGoBaseUrl } from '../../src/lib/openai-responses-route.mjs';

/**
 * @returns {Promise<Record<string, { api?: string, models?: Record<string, ModelsDevEntry> }>>}
 */
async function loadModelsDevCatalog() {
  const now = Date.now();
  if (cache.catalog && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.catalog;
  }
  if (cache.pending) return cache.pending;

  const request = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MODELS_DEV_TIMEOUT_MS);
    try {
      const res = await fetch(MODELS_DEV_URL, { signal: controller.signal });
      if (!res.ok) {
        throw new Error(`models.dev HTTP ${res.status}`);
      }
      const json = await res.json();
      const catalog = json && typeof json === 'object' ? json : {};
      cache.fetchedAt = Date.now();
      cache.catalog = catalog;
      return catalog;
    } finally {
      clearTimeout(timer);
    }
  };
  cache.pending = request();
  try {
    return await cache.pending;
  } finally {
    cache.pending = null;
  }
}

/** Match only an official endpoint, never an arbitrary compatible proxy. */
export function modelsDevProviderId(baseUrl, catalog) {
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== 'https:') return undefined;
    const origin = url.origin.toLowerCase();
    const path = url.pathname.replace(/\/+$/, '').toLowerCase();
    if (url.hostname.toLowerCase() === 'opencode.ai') {
      if ((path === '/zen/go' || path === '/zen/go/v1') && catalog['opencode-go']) return 'opencode-go';
      if ((path === '/zen' || path === '/zen/v1') && catalog.opencode) return 'opencode';
    }
    for (const [id, provider] of Object.entries(catalog)) {
      if (typeof provider?.api !== 'string') continue;
      try {
        const api = new URL(provider.api);
        const apiPath = api.pathname.replace(/\/+$/, '').toLowerCase();
        if (api.origin.toLowerCase() === origin &&
          (apiPath === path || apiPath === `${path}/v1`)) return id;
      } catch {
        // One malformed catalog endpoint must not hide other providers.
      }
    }
    if (url.hostname.toLowerCase() === 'api.groq.com' && (path === '/openai' || path === '/openai/v1')) return 'groq';
    if (path === '' || path === '/v1') return HOSTED_PROVIDER_IDS.get(url.hostname.toLowerCase());
  } catch {
    // Invalid provider URL.
  }
  return undefined;
}

/**
 * Image-input support for one models.dev entry, or undefined when it says nothing.
 *
 * `modalities.input` is the precise field; `attachment` is the older flag and is
 * only read as a positive, since plenty of vision models predate it being set.
 *
 * @param {ModelsDevEntry | undefined} entry
 * @returns {boolean | undefined}
 */
export function modelsDevVisionFlag(entry) {
  const input = entry?.modalities?.input;
  if (Array.isArray(input) && input.length > 0) {
    return input.some((m) => typeof m === 'string' && /^images?$/i.test(m.trim()));
  }
  if (entry?.attachment === true) return true;
  return undefined;
}

/**
 * Attach max_context_length and vision support from models.dev when OpenCode
 * upstream omits them. Exact model id match only — authoritative for opencode.ai
 * providers, including the negative case: `modalities.input: ["text"]` is how a
 * text-only model stops being probed (and mis-reported) as multimodal.
 *
 * @param {{ data: Array<{ id: string, max_context_length?: number, catalogVision?: boolean, [key: string]: unknown }> }} normalized
 */
export async function enrichModelsFromModelsDev(baseUrl, normalized) {
  if (!normalized?.data?.length) {
    return normalized;
  }

  let catalog;
  try {
    catalog = await loadModelsDevCatalog();
  } catch (err) {
    console.warn('[providers] models.dev context enrichment failed:', err?.message || err);
    return normalized;
  }

  const providerId = modelsDevProviderId(baseUrl, catalog);
  if (!providerId) return normalized;
  const models = catalog[providerId]?.models ?? {};
  const isOpenCode = isOpenCodeProviderBaseUrl(baseUrl);
  const data = normalized.data.map((row) => {
    const entry = models[row.id];
    if (!entry) return row;

    const next = { ...row };
    const devLimit = entry.limit?.context;
    if (typeof devLimit === 'number' && Number.isFinite(devLimit) && devLimit > 0 &&
      (isOpenCode || !(typeof row.max_context_length === 'number' && Number.isFinite(row.max_context_length) && row.max_context_length > 0))) {
      next.max_context_length = devLimit;
    }
    const vision = isOpenCode ? modelsDevVisionFlag(entry) : undefined;
    if (vision !== undefined) {
      next.catalogVision = vision;
    }
    return next;
  });

  return { data };
}

/** Compatibility entry point for existing OpenCode callers. */
export function enrichOpenCodeModelsFromModelsDev(normalized) {
  return enrichModelsFromModelsDev('https://opencode.ai/zen', normalized);
}

/** Test hook: reset in-memory models.dev cache. */
export function resetModelsDevContextCacheForTests() {
  cache.fetchedAt = 0;
  cache.catalog = null;
  cache.pending = null;
}
