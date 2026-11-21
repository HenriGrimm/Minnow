/**
 * Structured web search for Deep Research — provider chain with fallback and disk cache.
 */

import { readConfigJson } from '../config/store.js';
import { normalizeToolConfig } from '../config/validators.js';
import { getManagedSearxngUrl } from '../servers/manager.js';
import { searchBraveStructured } from '../tools/web-search-brave.js';
import { searchDdgStructured } from '../tools/web-search-ddg.js';
import { searchSearxngStructured } from '../tools/web-search-searxng.js';
import { searchTavilyStructured } from '../tools/web-search-tavily.js';
import { looksUnrelated } from '../tools/search-result.js';
import { getSearch, setSearch } from './search-cache.js';

/** @typedef {'searxng' | 'tavily' | 'brave' | 'duckduckgo' | 'disabled'} SearchProviderId */

/** @type {string | null} */
let lastSearchError = null;

/** @type {SearchProviderId | null} */
let lastSearchProvider = null;

/** True when the last search discarded a result set as unrelated (not merely empty). */
let lastSearchDiscardedUnrelated = false;

const DEFAULT_FALLBACK_CHAIN = ['tavily', 'brave', 'duckduckgo'];
const DEFAULT_SEARXNG_URL = 'http://localhost:8899';
const DEFAULT_RESULT_COUNT = 10;

/**
 * Last provider error message (for engine empty-round messaging).
 * @returns {string | null}
 */
export function getLastSearchError() {
  return lastSearchError;
}

/**
 * Provider that produced the most recent non-empty result set.
 * @returns {SearchProviderId | null}
 */
export function getLastSearchProvider() {
  return lastSearchProvider;
}

/**
 * True when at least one provider returned results that were discarded as unrelated to
 * the query. Distinguishes "nothing found" from "the engine answered with junk", which
 * point at different fixes.
 * @returns {boolean}
 */
export function getLastSearchDiscardedUnrelated() {
  return lastSearchDiscardedUnrelated;
}

/**
 * @param {unknown} value
 * @returns {SearchProviderId}
 */
function normalizeProviderId(value) {
  if (
    value === 'searxng' ||
    value === 'tavily' ||
    value === 'brave' ||
    value === 'duckduckgo' ||
    value === 'disabled'
  ) {
    return value;
  }
  return 'duckduckgo';
}

/**
 * Load search settings from search.json with tools.json fallback (Phase 0 migration).
 * Missing search.json defaults the research primary to SearXNG; managed SearXNG overrides the URL when healthy.
 * @returns {Promise<{
 *   provider: SearchProviderId;
 *   fallbackChain: SearchProviderId[];
 *   searxngUrl: string;
 *   braveApiKey: string;
 *   tavilyApiKey: string;
 *   resultCount: number;
 * }>}
 */
export async function loadSearchSettings() {
  const toolsRaw = (await readConfigJson('tools.json')) ?? {};
  const tools = normalizeToolConfig(toolsRaw);
  const searchRaw = await readConfigJson('search.json');

  let provider =
    searchRaw && typeof searchRaw === 'object'
      ? normalizeProviderId(searchRaw.provider ?? 'searxng')
      : 'searxng';
  let fallbackChain = [...DEFAULT_FALLBACK_CHAIN];
  let searxngUrl = DEFAULT_SEARXNG_URL;
  let braveApiKey = tools.keys?.braveApiKey?.trim() ?? '';
  let tavilyApiKey = tools.keys?.tavilyApiKey?.trim() ?? '';
  let resultCount = DEFAULT_RESULT_COUNT;

  if (searchRaw && typeof searchRaw === 'object') {
    if (Array.isArray(searchRaw.fallbackChain)) {
      fallbackChain = searchRaw.fallbackChain
        .map((id) => normalizeProviderId(id))
        .filter((id) => id !== 'disabled' && id !== 'searxng');
    }
    if (typeof searchRaw.searxngUrl === 'string' && searchRaw.searxngUrl.trim()) {
      searxngUrl = searchRaw.searxngUrl.trim();
    }
    const keys = searchRaw.keys;
    if (keys && typeof keys === 'object') {
      if (typeof keys.braveApiKey === 'string') {
        braveApiKey = keys.braveApiKey.trim();
      }
      if (typeof keys.tavilyApiKey === 'string') {
        tavilyApiKey = keys.tavilyApiKey.trim();
      }
    }
    if (Number.isFinite(searchRaw.resultCount)) {
      resultCount = Math.min(Math.max(Number(searchRaw.resultCount), 1), 30);
    }
  }

  const managedSearxngUrl = await getManagedSearxngUrl();
  if (managedSearxngUrl) {
    searxngUrl = managedSearxngUrl;
  }

  return {
    provider,
    fallbackChain,
    searxngUrl,
    braveApiKey,
    tavilyApiKey,
    resultCount,
  };
}

/**
 * @param {SearchProviderId} primary
 * @param {SearchProviderId[]} fallbackChain
 * @returns {SearchProviderId[]}
 */
export function buildProviderChain(primary, fallbackChain) {
  const chain = [];
  const seen = new Set();

  const push = (id) => {
    if (!id || id === 'disabled' || seen.has(id)) {
      return;
    }
    seen.add(id);
    chain.push(id);
  };

  push(primary);
  for (const id of fallbackChain) {
    push(id);
  }

  if (!chain.length) {
    push('duckduckgo');
  }

  return chain;
}

/**
 * @param {SearchProviderId} providerId
 * @param {string} query
 * @param {Awaited<ReturnType<typeof loadSearchSettings>>} settings
 * @returns {Promise<{ results: import('../tools/search-result.js').SearchResult[]; error?: string }>}
 */
async function callProvider(providerId, query, settings) {
  const count = settings.resultCount;

  if (providerId === 'searxng') {
    return searchSearxngStructured(query, settings.searxngUrl, count);
  }
  if (providerId === 'tavily') {
    if (!settings.tavilyApiKey) {
      return { results: [], error: 'Error: Tavily API key not configured.' };
    }
    return searchTavilyStructured(query, settings.tavilyApiKey, count);
  }
  if (providerId === 'brave') {
    if (!settings.braveApiKey) {
      return { results: [], error: 'Error: Brave API key not configured.' };
    }
    return searchBraveStructured(query, settings.braveApiKey, count);
  }
  if (providerId === 'duckduckgo') {
    return searchDdgStructured(query);
  }

  return { results: [], error: `Error: unknown search provider "${providerId}"` };
}

/**
 * Structured search with provider chain, disk cache, and last-error tracking.
 * Re-check cached hits: old entries can stay pinned for the full TTL after a provider starts decoying.
 * @param {string} query
 * @param {{ provider?: SearchProviderId; count?: number; useCache?: boolean }} [opts]
 * @returns {Promise<import('../tools/search-result.js').SearchResult[]>}
 */
export async function searchStructured(query, opts = {}) {
  lastSearchError = null;
  lastSearchProvider = null;
  lastSearchDiscardedUnrelated = false;

  const trimmed = String(query ?? '').trim();
  if (!trimmed) {
    lastSearchError = 'Error: search query is required';
    return [];
  }

  const settings = await loadSearchSettings();
  if (opts.count !== undefined && Number.isFinite(opts.count)) {
    settings.resultCount = Math.min(Math.max(Number(opts.count), 1), 30);
  }

  const primary =
    opts.provider ??
    (settings.provider || 'searxng');
  const chain = buildProviderChain(primary, settings.fallbackChain);

  const cacheKey = JSON.stringify({ query: trimmed, chain, count: settings.resultCount });
  const useCache = opts.useCache !== false;
  if (useCache) {
    const cached = await getSearch(cacheKey);
    if (cached?.length && !looksUnrelated(trimmed, cached)) {
      lastSearchProvider = primary;
      return cached;
    }
  }

  const errors = [];

  for (const providerId of chain) {
    const { results, error } = await callProvider(providerId, trimmed, settings);
    if (results.length > 0) {
      lastSearchProvider = providerId;
      if (useCache) {
        await setSearch(cacheKey, results);
      }
      return results;
    }
    if (error) {
      if (error.includes('unrelated to')) {
        lastSearchDiscardedUnrelated = true;
      }
      errors.push(`${providerId}: ${error}`);
    }
  }

  if (errors.length) {
    lastSearchError = errors.join(' | ');
  } else {
    lastSearchError = 'All search providers returned no results.';
  }

  return [];
}
