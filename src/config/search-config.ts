/**
 * search.json — web search provider, keys, and Deep Research fallback chain.
 */

import type { ToolConfig, WebSearchProvider } from '../tools/tool-settings-types';

/** Primary search provider (includes SearXNG and disabled). */
export type SearchProvider =
  | 'searxng'
  | 'tavily'
  | 'brave'
  | 'duckduckgo'
  | 'disabled';

/** Providers allowed in the fallback chain (excludes searxng/disabled). */
export type SearchFallbackProvider = 'tavily' | 'brave' | 'duckduckgo';

export interface SearchConfig {
  provider: SearchProvider;
  fallbackChain: SearchFallbackProvider[];
  searxngUrl: string;
  keys: {
    braveApiKey: string;
    tavilyApiKey: string;
  };
  resultCount: number;
}

export const DEFAULT_SEARCH_CONFIG: SearchConfig = {
  provider: 'tavily',
  fallbackChain: ['tavily', 'brave', 'duckduckgo'],
  searxngUrl: 'http://localhost:8899',
  keys: { braveApiKey: '', tavilyApiKey: '' },
  resultCount: 10,
};

/** Legacy web_search routing providers (brave / tavily / duckduckgo). */
export type LegacyWebSearchProvider = WebSearchProvider;

export interface EffectiveWebSearchSettings {
  provider: SearchProvider;
  keys: SearchConfig['keys'];
}

let cachedSearch: SearchConfig | null = null;
let revision = 0;

/** Scope web result caches without putting API keys into tool arguments. */
export function getSearchConfigRevision(): number { return revision; }

export function hasConfiguredTavilyKey(tools: ToolConfig): boolean {
  return Boolean((cachedSearch?.keys?.tavilyApiKey ?? tools.keys.tavilyApiKey)?.trim());
}

/** Clear in-memory cache (tests or after external edits). */
export function resetSearchConfigCache(): void {
  cachedSearch = null;
  revision += 1;
}

/** GET /api/config/search (cached until reset). */
export async function loadSearchConfig(): Promise<SearchConfig> {
  if (cachedSearch) return cachedSearch;
  try {
    const res = await fetch('/api/config/search', { cache: 'no-store' });
    if (!res.ok) {
      return { ...DEFAULT_SEARCH_CONFIG };
    }
    const data = (await res.json()) as SearchConfig;
    cachedSearch = { ...DEFAULT_SEARCH_CONFIG, ...data };
    return cachedSearch;
  } catch {
    return { ...DEFAULT_SEARCH_CONFIG };
  }
}

/** PUT /api/config/search and refresh cache. */
export async function saveSearchConfig(config: SearchConfig): Promise<SearchConfig> {
  const res = await fetch('/api/config/search', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    const message =
      errBody && typeof errBody === 'object' && 'error' in errBody
        ? String((errBody as { error: unknown }).error)
        : res.statusText;
    throw new Error(message || `Config API ${res.status}`);
  }
  const payload = (await res.json()) as { data?: SearchConfig };
  cachedSearch = payload.data ?? config;
  revision += 1;
  return cachedSearch;
}

/**
 * Merge search.json with tools.json for web_search routing (search wins; tools.json fallback).
 */
export function mergeWebSearchSettings(
  search: SearchConfig | null | undefined,
  tools: ToolConfig,
): EffectiveWebSearchSettings {
  const searchProvider = search?.provider;
  const toolsProvider = tools.webSearchProvider;
  let provider: SearchProvider = 'duckduckgo';
  if (
    searchProvider === 'searxng' ||
    searchProvider === 'tavily' ||
    searchProvider === 'brave' ||
    searchProvider === 'duckduckgo' ||
    searchProvider === 'disabled'
  ) {
    provider = searchProvider;
  } else if (
    toolsProvider === 'brave' ||
    toolsProvider === 'tavily' ||
    toolsProvider === 'duckduckgo'
  ) {
    provider = toolsProvider;
  }

  const braveFromSearch = search?.keys?.braveApiKey?.trim() ?? '';
  const tavilyFromSearch = search?.keys?.tavilyApiKey?.trim() ?? '';
  return {
    provider,
    keys: {
      braveApiKey: braveFromSearch || tools.keys.braveApiKey?.trim() || '',
      tavilyApiKey: tavilyFromSearch || tools.keys.tavilyApiKey?.trim() || '',
    },
  };
}

/** Map SearchProvider to legacy routing when only brave/tavily/ddg are supported. */
export function toLegacyWebSearchProvider(
  provider: SearchProvider,
): LegacyWebSearchProvider | null {
  if (provider === 'brave' || provider === 'tavily' || provider === 'duckduckgo') {
    return provider;
  }
  return null;
}
