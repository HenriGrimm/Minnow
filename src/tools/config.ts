import { bumpToolConfigEpoch } from '../chat/outbound-estimate-epochs';
import { getTools, putTools } from '../config/api-client';
import { defaultToolConfig as buildDefaultToolConfig } from '../config/defaults';
import {
  loadSearchConfig,
  saveSearchConfig,
  toLegacyWebSearchProvider,
  type SearchProvider,
} from '../config/search-config';
import { isServerStorageMode } from '../config/storage-mode';
import { setStatus } from '../ui/status';
import type { ToolConfig } from './tool-settings-types';
import { normalizeToolOutputConfig } from '../../server/tools/output-cap.js';
export type { ToolConfig } from './tool-settings-types';

export { defaultToolConfig } from '../config/defaults';

/** @deprecated Direct localStorage use — migration read / Vite-only fallback only. */
export const TOOL_CONFIG_STORAGE_KEY = 'minnow.tools';

let cachedConfig: ToolConfig | null = null;
let toolConfigLoaded = false;

/** Set when `GET /api/config/tools` fails in server mode; cleared on success. */
let serverToolsFetchFailed = false;

/** Deduplicate overlapping {@link loadToolConfigFromStorage} calls (settings refresh + init). */
let loadFromStoragePromise: Promise<ToolConfig> | null = null;

/** Whether `npm start` tool server responded to ping (set by client / init). */
let localServerAvailable = false;

/** Merge stored JSON with defaults; ignore unknown shapes. */
export function normalizeToolConfig(raw: unknown): ToolConfig {
  const config = buildDefaultToolConfig();
  if (!raw || typeof raw !== 'object') return config;

  const stored = raw as {
    keys?: unknown;
    plugins?: Record<string, { enabled?: boolean }>;
    toolCache?: unknown;
    toolOutput?: unknown;
    lazyTools?: unknown;
    webSearchProvider?: unknown;
  };
  if (stored.plugins && typeof stored.plugins === 'object') {
    config.plugins = {};
    for (const [id, plugin] of Object.entries(stored.plugins)) {
      if (plugin && typeof plugin === 'object') config.plugins[id] = { enabled: plugin.enabled !== false };
    }
  }
  if (stored.keys && typeof stored.keys === 'object') {
    const keysMap = stored.keys as Record<string, unknown>;
    if (typeof keysMap.braveApiKey === 'string') {
      config.keys.braveApiKey = keysMap.braveApiKey;
    }
    if (typeof keysMap.tavilyApiKey === 'string') {
      config.keys.tavilyApiKey = keysMap.tavilyApiKey;
    }
  }

  if (
    stored.webSearchProvider === 'brave' ||
    stored.webSearchProvider === 'tavily' ||
    stored.webSearchProvider === 'duckduckgo'
  ) {
    config.webSearchProvider = stored.webSearchProvider;
  }

  if (stored.toolCache && typeof stored.toolCache === 'object') {
    const cacheMap = stored.toolCache as Record<string, unknown>;
    if (typeof cacheMap.enabled === 'boolean') {
      config.toolCache = { enabled: cacheMap.enabled };
    }
  }
  if (!config.toolCache) {
    config.toolCache = { enabled: true };
  }

  config.toolOutput = normalizeToolOutputConfig(stored.toolOutput);
  config.lazyTools = stored.lazyTools !== false;

  return config;
}

/** Clear in-memory tool config so the next load re-reads persistence. */
export function invalidateToolConfigCache(): void {
  cachedConfig = null;
  toolConfigLoaded = false;
  loadFromStoragePromise = null;
}

// ── Load ─────────────────────────────────────────────────────────────────────

/** Load tool config from API or localStorage (call during initApp). */
export async function loadToolConfigFromStorage(): Promise<ToolConfig> {
  if (loadFromStoragePromise) return loadFromStoragePromise;

  loadFromStoragePromise = (async (): Promise<ToolConfig> => {
    try {
      if (isServerStorageMode()) {
        try {
          await loadSearchConfig();
          cachedConfig = normalizeToolConfig(await getTools());
          serverToolsFetchFailed = false;
          toolConfigLoaded = true;
          return cachedConfig;
        } catch {
          serverToolsFetchFailed = true;
          setStatus('err', 'Could not load tool settings from ~/.minnow');
          cachedConfig = cachedConfig ?? buildDefaultToolConfig();
          toolConfigLoaded = true;
          return cachedConfig;
        }
      }

      try {
        const raw = localStorage.getItem(TOOL_CONFIG_STORAGE_KEY);
        cachedConfig = raw
          ? normalizeToolConfig(JSON.parse(raw) as unknown)
          : buildDefaultToolConfig();
      } catch {
        cachedConfig = buildDefaultToolConfig();
      }

      toolConfigLoaded = true;
      return cachedConfig;
    } catch {
      cachedConfig = buildDefaultToolConfig();
      toolConfigLoaded = true;
      return cachedConfig;
    } finally {
      loadFromStoragePromise = null;
    }
  })();

  return loadFromStoragePromise;
}

export async function loadToolConfigForSettingsUi(): Promise<ToolConfig> {
  if (cachedConfig !== null && !serverToolsFetchFailed) {
    return cachedConfig;
  }
  if (serverToolsFetchFailed) {
    invalidateToolConfigCache();
  }
  return loadToolConfigFromStorage();
}

/** True when settings UI can hydrate from memory without a network round-trip. */
export function isToolConfigReadyForSettingsUi(): boolean {
  return cachedConfig !== null && !serverToolsFetchFailed;
}

export async function ensureToolConfigReady(): Promise<ToolConfig> {
  if (cachedConfig !== null) return cachedConfig;
  return loadToolConfigFromStorage();
}

/** Read config from memory cache (loads defaults if init skipped). */
export function loadToolConfig(): ToolConfig {
  if (cachedConfig) return cachedConfig;
  if (!toolConfigLoaded) {
    void loadToolConfigFromStorage();
  }
  return buildDefaultToolConfig();
}

/** Current config (loads from storage on first access). */
export function getToolConfig(): ToolConfig {
  return loadToolConfig();
}

/** Override in-memory tool config (headless tests). */
export function setToolConfigForTests(config: ToolConfig): void {
  cachedConfig = config;
  toolConfigLoaded = true;
}

/** Persist config to API or localStorage; server write is best-effort (see {@link saveToolConfigAsync}). */
export function saveToolConfig(config: ToolConfig): void {
  void saveToolConfigAsync(config).catch(() => {
    if (isServerStorageMode()) {
      setStatus('err', 'Could not save tool settings to ~/.minnow');
    }
  });
}

export async function saveToolConfigAsync(config: ToolConfig): Promise<void> {
  config = normalizeToolConfig(config);
  cachedConfig = config;
  bumpToolConfigEpoch();

  if (isServerStorageMode()) {
    try {
      await putTools(config);
    } catch {
      setStatus('err', 'Could not save tool settings to ~/.minnow');
    }
    return;
  }

  try {
    localStorage.setItem(TOOL_CONFIG_STORAGE_KEY, JSON.stringify(config));
  } catch {}
}

/** Update local tool server availability. */
export function setLocalServerAvailable(available: boolean): void {
  localServerAvailable = available;
}

/** Whether the dev tool API (`/api/tools/ping`) is reachable. */
export function isLocalServerAvailable(): boolean {
  return localServerAvailable;
}

/** Test-only: override the local server availability flag. */
export function setLocalServerAvailableForTests(available: boolean): void {
  localServerAvailable = available;
}

/** Synchronize operational search/cache settings in the legacy drawer. */
export function loadToolConfigIntoDrawer(_root?: ParentNode): void {
  if (typeof document === 'undefined') return;
  const config = loadToolConfig();
  for (const [id, value] of [['braveApiKey', config.keys.braveApiKey], ['tavilyApiKey', config.keys.tavilyApiKey]]) {
    const input = document.getElementById(id) as HTMLInputElement | null;
    if (input) input.value = value;
  }
  const cache = document.getElementById('settingsToolCacheEnabled') as HTMLInputElement | null;
  if (cache) cache.checked = config.toolCache?.enabled !== false;
}

/** Legacy drawer search-provider select. */
const WEB_SEARCH_PROVIDER_SELECT_IDS = ['webSearchProvider'] as const;

/** Search-provider values that map to search.json. */
const WEB_SEARCH_PROVIDER_VALUES = new Set<SearchProvider>([
  'searxng',
  'duckduckgo',
  'brave',
  'tavily',
]);

function isWebSearchProviderSelect(element: EventTarget | null): element is HTMLSelectElement {
  if (!(element instanceof HTMLSelectElement)) return false;
  return (WEB_SEARCH_PROVIDER_SELECT_IDS as readonly string[]).includes(element.id);
}

// ── Web search ───────────────────────────────────────────────────────────────

/** Keep every web-search provider dropdown in sync. */
export function setWebSearchProviderSelects(provider: string): void {
  for (const id of WEB_SEARCH_PROVIDER_SELECT_IDS) {
    const providerSelect = document.getElementById(id) as HTMLSelectElement | null;
    if (!providerSelect) continue;
    const hasOption = Array.from(providerSelect.options).some((option) => option.value === provider);
    if (hasOption) {
      providerSelect.value = provider;
    }
  }
}

/** Load search.json provider into drawer/composer selects (search.json wins over tools.json). */
export async function syncWebSearchProviderFromSearchConfig(): Promise<void> {
  try {
    const search = await loadSearchConfig();
    if (search.provider === 'disabled') return;
    setWebSearchProviderSelects(search.provider);
  } catch {}
}

/** Persist web search provider and API keys from drawer or composer popover fields. */
export function saveWebSearchSettingsFromDrawer(event?: Event): void {
  const braveInput = document.getElementById('braveApiKey') as HTMLInputElement | null;
  const tavilyInput = document.getElementById('tavilyApiKey') as HTMLInputElement | null;
  const eventTarget = event?.target ?? null;
  const changedProviderSelect = isWebSearchProviderSelect(eventTarget) ? eventTarget : null;
  const providerSelect =
    changedProviderSelect ??
    (document.getElementById('webSearchProvider') as HTMLSelectElement | null) ??
    null;
  if (!braveInput && !tavilyInput && !providerSelect) return;

  const config = loadToolConfig();
  if (braveInput) {
    config.keys.braveApiKey = braveInput.value.trim();
  }
  if (tavilyInput) {
    config.keys.tavilyApiKey = tavilyInput.value.trim();
  }

  const providerValue = providerSelect?.value;
  const searchProvider =
    providerValue && WEB_SEARCH_PROVIDER_VALUES.has(providerValue as SearchProvider)
      ? (providerValue as SearchProvider)
      : null;

  if (searchProvider) {
    setWebSearchProviderSelects(searchProvider);
    const legacyProvider = toLegacyWebSearchProvider(searchProvider);
    if (legacyProvider) {
      config.webSearchProvider = legacyProvider;
    }
  }

  saveToolConfig(config);

  if (searchProvider) {
    void (async () => {
      try {
        const search = await loadSearchConfig();
        await saveSearchConfig({ ...search, provider: searchProvider });
      } catch {}
      loadToolConfigIntoDrawer(document);
    })();
    return;
  }

  loadToolConfigIntoDrawer(document);
}

let webSearchHandlersRegistered = false;

/** Wire operational search settings without any per-tool controls. */
export function registerWebSearchSettingsHandlers(): void {
  if (webSearchHandlersRegistered) return;
  webSearchHandlersRegistered = true;
  for (const id of ['webSearchProvider', 'braveApiKey', 'tavilyApiKey']) {
    document.getElementById(id)?.addEventListener('change', saveWebSearchSettingsFromDrawer);
  }
}
