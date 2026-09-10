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
import { BUILT_IN_TOOLS, type ToolCategory } from './definitions';
import { BRAIN_DESTRUCTIVE_TOOL_IDS, BRAIN_FULL_PERMISSION_TOOL_IDS, BRAIN_FULL_PERMISSION_TOOL_ID_SET } from './brain-tool-ids';
import { isMinnowElectronShell } from './minnow-shell';
import {
  createEmptyToolPermissionsConfig,
  type ToolConfig,
  type ToolPermissionMode,
  type ToolPermissionsConfig,
} from './tool-settings-types';
import { normalizeToolOutputConfig } from '../../server/tools/output-cap.js';

export type {
  ToolConfig,
  ToolPermissionMode,
  ToolPermissionsConfig,
} from './tool-settings-types';

export { defaultToolConfig } from '../config/defaults';

/** @deprecated Direct localStorage use — migration read / Vite-only fallback only. */
export const TOOL_CONFIG_STORAGE_KEY = 'minnow.tools';

const PERMISSION_SET = new Set<ToolPermissionMode>(['full', 'ask', 'off']);

// ── Permissions ──────────────────────────────────────────────────────────────

function defaultPermissionForBuiltIn(id: string, enabled: boolean): ToolPermissionMode {
  if (BRAIN_FULL_PERMISSION_TOOL_ID_SET.has(id)) {
    return enabled ? 'full' : 'off';
  }
  return enabled ? 'ask' : 'off';
}

/** True when `value` is a valid stored permission string. */
export function isToolPermissionMode(value: unknown): value is ToolPermissionMode {
  return typeof value === 'string' && PERMISSION_SET.has(value as ToolPermissionMode);
}

export { createEmptyToolPermissionsConfig } from './tool-settings-types';

/** True when persisted `permissions` is the legacy flat toolId → mode map. */
export function isLegacyFlatPermissions(permissions: unknown): boolean {
  if (!permissions || typeof permissions !== 'object') return false;
  const obj = permissions as Record<string, unknown>;
  if (obj.default && typeof obj.default === 'object' && !Array.isArray(obj.default)) {
    return false;
  }
  for (const value of Object.values(obj)) {
    if (isToolPermissionMode(value)) return true;
  }
  return false;
}

/** Merges legacy flat or v2 stored permissions into {@link ToolPermissionsConfig}. */
export function normalizePermissionsFromStored(
  stored: unknown,
  seedDefault: Record<string, ToolPermissionMode>,
): ToolPermissionsConfig {
  if (!stored || typeof stored !== 'object') {
    return { default: { ...seedDefault } };
  }

  if (isLegacyFlatPermissions(stored)) {
    const flat = stored as Record<string, unknown>;
    const merged = { ...seedDefault };
    for (const [id, value] of Object.entries(flat)) {
      if (!id || !isToolPermissionMode(value)) continue;
      merged[id] = value;
    }
    return { default: merged };
  }

  const obj = stored as Record<string, unknown>;
  const defaultRaw = obj.default;
  const merged = { ...seedDefault };
  if (defaultRaw && typeof defaultRaw === 'object') {
    for (const [id, value] of Object.entries(defaultRaw as Record<string, unknown>)) {
      if (!id || !isToolPermissionMode(value)) continue;
      merged[id] = value;
    }
  }

  return { default: merged };
}

/** True when a tool id was present in persisted tools.json (enabled or permissions). */
function toolIdWasStored(raw: unknown, id: string): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const stored = raw as {
    enabled?: Record<string, unknown>;
    permissions?: Record<string, unknown> & { default?: Record<string, unknown> };
  };
  if (stored.enabled && typeof stored.enabled === 'object') {
    if (Object.prototype.hasOwnProperty.call(stored.enabled, id)) return true;
  }
  if (stored.permissions && typeof stored.permissions === 'object') {
    if (isLegacyFlatPermissions(stored.permissions)) {
      if (Object.prototype.hasOwnProperty.call(stored.permissions, id)) return true;
    } else if (
      stored.permissions.default &&
      typeof stored.permissions.default === 'object' &&
      Object.prototype.hasOwnProperty.call(stored.permissions.default, id)
    ) {
      return true;
    }
  }
  return false;
}

/** Insert missing Brain tool ids at `full` for upgraded configs (Correction 6). */
function backfillBrainTools(config: ToolConfig, raw: unknown): void {
  for (const id of BRAIN_FULL_PERMISSION_TOOL_IDS) {
    if (!toolIdWasStored(raw, id)) {
      config.permissions.default[id] = 'full';
      config.enabled[id] = true;
    }
  }
  for (const id of BRAIN_DESTRUCTIVE_TOOL_IDS) {
    if (!toolIdWasStored(raw, id)) {
      config.permissions.default[id] = 'ask';
      config.enabled[id] = true;
    }
  }
}

export function syncEnabledFromPermissions(config: ToolConfig): void {
  for (const tool of BUILT_IN_TOOLS) {
    const raw = config.permissions.default[tool.id];
    const mode: ToolPermissionMode = isToolPermissionMode(raw)
      ? raw
      : config.enabled[tool.id] === true
        ? 'ask'
        : 'off';
    config.permissions.default[tool.id] = mode;
    config.enabled[tool.id] = mode !== 'off';
  }
}

export function getToolPermissionForId(
  config: ToolConfig,
  id: string,
): ToolPermissionMode {
  const raw = config.permissions.default[id];
  if (isToolPermissionMode(raw)) return raw;
  if (id.startsWith('mcp__') || id.startsWith('plugin__')) return 'ask';
  if (
    id === 'web_search_ddg' ||
    id === 'web_search_tavily' ||
    id === 'web_search_searxng'
  ) {
    return getToolPermissionForId(config, 'web_search');
  }
  const tool = BUILT_IN_TOOLS.find((t) => t.id === id);
  if (!tool) return 'off';
  return config.enabled[id] === true ? 'ask' : 'off';
}

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
    enabled?: unknown;
    keys?: unknown;
    permissions?: unknown;
    toolCache?: unknown;
    toolOutput?: unknown;
    lazyTools?: unknown;
    webSearchProvider?: unknown;
  };
  if (stored.enabled && typeof stored.enabled === 'object') {
    const enabledMap = stored.enabled as Record<string, unknown>;
    for (const tool of BUILT_IN_TOOLS) {
      const value = enabledMap[tool.id];
      if (typeof value === 'boolean') {
        config.enabled[tool.id] = value;
      }
    }
  }

  let hadPermissionsInFile = false;
  if (stored.permissions && typeof stored.permissions === 'object') {
    hadPermissionsInFile =
      isLegacyFlatPermissions(stored.permissions) ||
      (typeof (stored.permissions as Record<string, unknown>).default === 'object' &&
        (stored.permissions as Record<string, unknown>).default !== null);
    config.permissions = normalizePermissionsFromStored(
      stored.permissions,
      config.permissions.default,
    );
  }

  if (!hadPermissionsInFile) {
    for (const tool of BUILT_IN_TOOLS) {
      config.permissions.default[tool.id] = defaultPermissionForBuiltIn(
        tool.id,
        config.enabled[tool.id] === true,
      );
    }
  } else {
    for (const tool of BUILT_IN_TOOLS) {
      if (!isToolPermissionMode(config.permissions.default[tool.id])) {
        config.permissions.default[tool.id] = defaultPermissionForBuiltIn(
          tool.id,
          config.enabled[tool.id] === true,
        );
      }
    }
  }

  backfillBrainTools(config, raw);

  syncEnabledFromPermissions(config);

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
  syncEnabledFromPermissions(config);
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

/** Update local tool server availability and refresh server-only rows. */
export function setLocalServerAvailable(available: boolean): void {
  localServerAvailable = available;
  refreshServerToolDisabledState();
}

/** Whether the dev tool API (`/api/tools/ping`) is reachable. */
export function isLocalServerAvailable(): boolean {
  return localServerAvailable;
}

/** Test-only: override the local server availability flag. */
export function setLocalServerAvailableForTests(available: boolean): void {
  localServerAvailable = available;
}

/** True when a tool id is enabled in config (defaults applied). */
export function isToolEnabled(id: string): boolean {
  return getToolPermissionForId(loadToolConfig(), id) !== 'off';
}

/** Sync one tool row's permission select and segmented control to `mode`. */
function syncToolRowPermissionUi(row: HTMLElement, mode: ToolPermissionMode): void {
  const select = row.querySelector<HTMLSelectElement>('select.tool-permission-select');
  if (select) {
    select.value = mode;
  }

  const segments = row.querySelectorAll<HTMLButtonElement>('.tool-permission-segment');
  for (const segment of segments) {
    const active = segment.dataset.value === mode;
    segment.setAttribute('aria-checked', active ? 'true' : 'false');
  }
}

/** Toggle composer popover status panels when any notice is visible. */
function syncComposerToolsPopoverStatusVisibility(): void {
  for (const prefix of ['composerTools', 'chatAppTools'] as const) {
    const status = document.getElementById(`${prefix}Status`);
    const server = document.getElementById(`${prefix}ServerBanner`);
    const preview = document.getElementById(`${prefix}PreviewBanner`);
    if (!status) continue;
    const hasNotice =
      (server && !server.classList.contains('hidden')) ||
      (preview && !preview.classList.contains('hidden'));
    status.classList.toggle('hidden', !hasNotice);
  }
}

/** Apply disabled state to segmented permission controls on one row. */
function syncToolRowSegmentAvailability(
  row: HTMLElement,
  unavailable: boolean,
  title: string,
): void {
  const segments = row.querySelectorAll<HTMLButtonElement>('.tool-permission-segment');
  for (const segment of segments) {
    const isOff = segment.dataset.value === 'off';
    segment.disabled = unavailable && !isOff;
    if (unavailable && !isOff) {
      segment.setAttribute('title', title);
    } else {
      segment.removeAttribute('title');
    }
  }
}

// ── Drawer ───────────────────────────────────────────────────────────────────

/** Sync permission selects and Brave key field from config; dim server tools when offline. */
export function loadToolConfigIntoDrawer(
  root: ParentNode = document,
): void {
  if (typeof document === 'undefined') return;

  const config = loadToolConfig();

  const rows = root.querySelectorAll<HTMLElement>('[data-tool-id]');
  for (const row of rows) {
    const id = row.getAttribute('data-tool-id');
    if (!id) continue;
    syncToolRowPermissionUi(row, getToolPermissionForId(config, id));
  }

  const braveInput = document.getElementById('braveApiKey') as HTMLInputElement | null;
  if (braveInput) {
    braveInput.value = config.keys.braveApiKey;
  }

  const tavilyInput = document.getElementById('tavilyApiKey') as HTMLInputElement | null;
  if (tavilyInput) {
    tavilyInput.value = config.keys.tavilyApiKey;
  }

  setWebSearchProviderSelects(config.webSearchProvider);
  void syncWebSearchProviderFromSearchConfig();

  const cacheEnabled = config.toolCache?.enabled !== false;
  for (const id of [
    'settingsToolCacheEnabled',
    'composerToolsCacheEnabled',
    'chatAppToolsCacheEnabled',
    'desktopToolsCacheEnabled',
  ] as const) {
    const checkbox = document.getElementById(id) as HTMLInputElement | null;
    if (checkbox) {
      checkbox.checked = cacheEnabled;
    }
  }

  refreshServerToolDisabledState();
  syncToolSelectAllControls(root);
}

/** Tool ids that can be enabled right now (server tools only when npm start is up). */
export function getEligibleToolIds(ids: string[]): string[] {
  return ids.filter((id) => {
    const tool = BUILT_IN_TOOLS.find((entry) => entry.id === id);
    if (!tool) return false;
    if (tool.previewRequired) {
      return isMinnowElectronShell();
    }
    return !tool.serverRequired || localServerAvailable;
  });
}

/** Checked / indeterminate state for a bulk "select all" control over `ids`. */
export function getToolBulkCheckboxState(ids: string[]): {
  checked: boolean;
  indeterminate: boolean;
} {
  const config = loadToolConfig();
  const eligible = getEligibleToolIds(ids);
  if (eligible.length === 0) {
    return { checked: false, indeterminate: false };
  }

  const enabledCount = eligible.filter((id) => getToolPermissionForId(config, id) !== 'off')
    .length;
  if (enabledCount === 0) {
    return { checked: false, indeterminate: false };
  }
  if (enabledCount === eligible.length) {
    return { checked: true, indeterminate: false };
  }
  return { checked: false, indeterminate: true };
}

// ── Bulk ─────────────────────────────────────────────────────────────────────

/** Apply enabled flag to many tools, persist, and refresh list UI under `root`. */
export function setToolsEnabled(
  ids: string[],
  enabled: boolean,
  root: ParentNode = document,
): { applied: number; skipped: number } {
  const config = loadToolConfig();
  let applied = 0;
  let skipped = 0;

  for (const id of ids) {
    const tool = BUILT_IN_TOOLS.find((entry) => entry.id === id);
    if (!tool) continue;

    if (enabled && tool.previewRequired && !isMinnowElectronShell()) {
      skipped += 1;
      continue;
    }

    if (enabled && tool.serverRequired && !localServerAvailable) {
      skipped += 1;
      continue;
    }

    if (enabled) {
      if (getToolPermissionForId(config, id) !== 'off') continue;
    } else if (getToolPermissionForId(config, id) === 'off') {
      continue;
    }
    config.permissions.default[id] = enabled ? 'ask' : 'off';
    applied += 1;
  }

  if (applied > 0) {
    syncEnabledFromPermissions(config);
    saveToolConfig(config);
  }

  refreshAllToolListUis(root);

  if (enabled && skipped > 0) {
    setStatus('err', 'Open Minnow to use file and git tools.');
  }

  return { applied, skipped };
}

/** Pure: set every built-in catalog tool to `mode` and mirror `enabled`. */
export function applyAllBuiltInToolPermissions(
  config: ToolConfig,
  mode: ToolPermissionMode,
): ToolConfig {
  for (const tool of BUILT_IN_TOOLS) {
    config.permissions.default[tool.id] = mode;
  }
  syncEnabledFromPermissions(config);
  return config;
}

/** Pure: restore built-in permissions/enabled from defaults; keep keys and non-catalog ids. */
export function applyDefaultBuiltInPermissions(config: ToolConfig): ToolConfig {
  const defaults = buildDefaultToolConfig();
  for (const tool of BUILT_IN_TOOLS) {
    config.permissions.default[tool.id] = defaults.permissions.default[tool.id] ?? 'off';
    config.enabled[tool.id] = defaults.enabled[tool.id] ?? false;
  }
  syncEnabledFromPermissions(config);
  return config;
}

/** Refresh permission selects and bulk checkboxes on every mounted tool list. */
let refreshAllToolListUisScheduled = false;

function refreshAllToolListUisNow(): void {
  if (typeof document === 'undefined') return;

  loadToolConfigIntoDrawer(document);

  for (const listId of [
    'toolsList',
    'settingsToolsList',
    'composerToolsList',
    'chatAppToolsList',
    'desktopToolsList',
  ] as const) {
    const list = document.getElementById(listId);
    if (list) {
      syncToolSelectAllControls(list);
    }
  }
}

/** Queue a single UI refresh so change/click handlers can finish before DOM sync. */
export function refreshAllToolListUis(_root: ParentNode = document): void {
  if (typeof document === 'undefined') return;
  if (refreshAllToolListUisScheduled) return;
  refreshAllToolListUisScheduled = true;
  queueMicrotask(() => {
    refreshAllToolListUisScheduled = false;
    refreshAllToolListUisNow();
  });
}

/** Test helper: await the deferred {@link refreshAllToolListUis} pass. */
export async function flushToolListUiRefresh(): Promise<void> {
  await new Promise<void>((resolve) => queueMicrotask(resolve));
}

/** Set every built-in tool to `mode`, persist, and refresh all tool list UIs. */
export async function setAllBuiltInToolPermissions(
  mode: ToolPermissionMode,
  root: ParentNode = document,
): Promise<{ updated: number }> {
  const config = loadToolConfig();
  applyAllBuiltInToolPermissions(config, mode);
  await saveToolConfigAsync(config);
  refreshAllToolListUis(root);
  return { updated: BUILT_IN_TOOLS.length };
}

/** Restore built-in permissions to factory defaults, persist, and refresh lists. */
export async function resetBuiltInToolPermissionsToDefaults(
  root: ParentNode = document,
): Promise<void> {
  const config = loadToolConfig();
  applyDefaultBuiltInPermissions(config);
  await saveToolConfigAsync(config);
  refreshAllToolListUis(root);
}

/** True for MCP and plugin ids: persisted like built-ins, absent from the catalog. */
function isDynamicToolId(id: string): boolean {
  return id.startsWith('mcp__') || id.startsWith('plugin__');
}

/** Set one tool permission mode (built-in, MCP, or plugin) and refresh UI. */
export function setToolPermission(
  id: string,
  mode: ToolPermissionMode,
  root: ParentNode = document,
): void {
  const tool = BUILT_IN_TOOLS.find((entry) => entry.id === id);
  if (!tool && !isDynamicToolId(id)) return;

  if (tool && mode !== 'off' && tool.previewRequired && !isMinnowElectronShell()) {
    setStatus(
      'err',
      'Browser tools require the Minnow desktop app window (not a separate browser tab).',
    );
    refreshAllToolListUis(root);
    return;
  }

  if (tool && mode !== 'off' && tool.serverRequired && !localServerAvailable) {
    setStatus('err', 'Open Minnow to use file and git tools.');
    refreshAllToolListUis(root);
    return;
  }

  const config = loadToolConfig();
  config.permissions.default[id] = mode;
  syncEnabledFromPermissions(config);
  saveToolConfig(config);

  refreshAllToolListUis(root);
}

/** All built-in tool ids in a settings category. */
export function getToolIdsForCategory(category: ToolCategory): string[] {
  return BUILT_IN_TOOLS.filter((tool) => tool.category === category).map(
    (tool) => tool.id,
  );
}

/** Update global and per-category "select all" checkboxes under `root`. */
export function syncToolSelectAllControls(root: ParentNode = document): void {
  if (typeof document === 'undefined') return;

  const applyState = (checkbox: HTMLInputElement, ids: string[]) => {
    const { checked, indeterminate } = getToolBulkCheckboxState(ids);
    checkbox.checked = checked;
    checkbox.indeterminate = indeterminate;
  };

  const global = root.querySelector<HTMLInputElement>(
    'input[type="checkbox"][data-select-all="global"]',
  );
  if (global) {
    applyState(global, BUILT_IN_TOOLS.map((tool) => tool.id));
  }

  const categoryBoxes = root.querySelectorAll<HTMLInputElement>(
    'input[type="checkbox"][data-select-all-category]',
  );
  for (const checkbox of categoryBoxes) {
    const category = checkbox.getAttribute('data-select-all-category');
    if (!category) continue;
    applyState(checkbox, getToolIdsForCategory(category as ToolCategory));
  }
}

// ── Toggle ───────────────────────────────────────────────────────────────────

/** Flip enabled state for one tool, persist, and update drawer UI. */
export function onToolToggle(id: string): void {
  if (typeof document === 'undefined') return;

  const config = loadToolConfig();
  const tool = BUILT_IN_TOOLS.find((entry) => entry.id === id);
  if (!tool) return;

  const currentlyOn = getToolPermissionForId(config, id) !== 'off';
  const nextMode: ToolPermissionMode = currentlyOn ? 'off' : 'ask';
  setToolPermission(id, nextMode, document);
}

/** Disable server-required tool rows when the local tool server is down. */
export function refreshServerToolDisabledState(): void {
  if (typeof document === 'undefined') return;

  const serverUnavailable = !localServerAvailable;
  const previewUnavailable = !isMinnowElectronShell();

  const banner = document.getElementById('toolsServerBanner');
  if (banner) {
    banner.classList.toggle('hidden', !serverUnavailable);
  }

  const settingsBanner = document.getElementById('settingsToolsServerBanner');
  if (settingsBanner) {
    settingsBanner.classList.toggle('hidden', !serverUnavailable);
  }

  const composerBanner = document.getElementById('composerToolsServerBanner');
  if (composerBanner) {
    composerBanner.classList.toggle('hidden', !serverUnavailable);
  }

  const composerPreviewBanner = document.getElementById('composerToolsPreviewBanner');
  if (composerPreviewBanner) {
    composerPreviewBanner.classList.toggle('hidden', !previewUnavailable);
  }

  const chatAppBanner = document.getElementById('chatAppToolsServerBanner');
  if (chatAppBanner) {
    chatAppBanner.classList.toggle('hidden', !serverUnavailable);
  }

  const chatAppPreviewBanner = document.getElementById('chatAppToolsPreviewBanner');
  if (chatAppPreviewBanner) {
    chatAppPreviewBanner.classList.toggle('hidden', !previewUnavailable);
  }

  const desktopBanner = document.getElementById('desktopToolsServerBanner');
  if (desktopBanner) {
    desktopBanner.classList.toggle('hidden', !serverUnavailable);
  }

  const desktopPreviewBanner = document.getElementById('desktopToolsPreviewBanner');
  if (desktopPreviewBanner) {
    desktopPreviewBanner.classList.toggle('hidden', !previewUnavailable);
  }

  const previewBanner = document.getElementById('toolsPreviewBanner');
  if (previewBanner) {
    previewBanner.classList.toggle('hidden', !previewUnavailable);
  }

  const settingsPreviewBanner = document.getElementById('settingsToolsPreviewBanner');
  if (settingsPreviewBanner) {
    settingsPreviewBanner.classList.toggle('hidden', !previewUnavailable);
  }

  const serverRows = document.querySelectorAll<HTMLElement>(
    '.tool-row[data-server-required], [data-tool-id][data-server-required]',
  );

  for (const row of serverRows) {
    row.classList.toggle('is-server-unavailable', serverUnavailable);
    const select = row.querySelector<HTMLSelectElement>('select.tool-permission-select');
    if (select) {
      select.disabled = serverUnavailable;
      if (serverUnavailable) {
        select.setAttribute(
          'title',
          'Requires Minnow running locally — open or restart the app',
        );
      } else {
        select.removeAttribute('title');
      }
    }
    if (serverUnavailable) {
      syncToolRowSegmentAvailability(
        row,
        true,
        'Requires Minnow running locally — open or restart the app',
      );
    }
  }

  const previewRows = document.querySelectorAll<HTMLElement>(
    '.tool-row[data-preview-required], [data-tool-id][data-preview-required]',
  );

  for (const row of previewRows) {
    row.classList.toggle('is-preview-unavailable', previewUnavailable);
    const select = row.querySelector<HTMLSelectElement>('select.tool-permission-select');
    if (select) {
      if (previewUnavailable) {
        select.disabled = true;
        select.setAttribute(
          'title',
          'Requires the Minnow desktop app window, not a separate browser tab',
        );
      } else if (!row.hasAttribute('data-server-required') || !serverUnavailable) {
        select.disabled = false;
        select.removeAttribute('title');
      }
    }
    if (previewUnavailable) {
      syncToolRowSegmentAvailability(
        row,
        true,
        'Requires the Minnow desktop app window, not a separate browser tab',
      );
    } else if (!row.hasAttribute('data-server-required') || !serverUnavailable) {
      syncToolRowSegmentAvailability(row, false, '');
    }
  }

  for (const row of serverRows) {
    if (!serverUnavailable) {
      const previewOnly =
        row.hasAttribute('data-preview-required') && previewUnavailable;
      if (!previewOnly) {
        syncToolRowSegmentAvailability(row, false, '');
      }
    }
  }

  syncComposerToolsPopoverStatusVisibility();
  syncToolSelectAllControls(document);
}

/** Web search provider `<select>` ids (drawer + composer popovers). */
const WEB_SEARCH_PROVIDER_SELECT_IDS = [
  'webSearchProvider',
  'composerToolsWebSearchProvider',
  'chatAppToolsWebSearchProvider',
  'desktopToolsWebSearchProvider',
] as const;

/** Composer/drawer provider values that map to search.json. */
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
    (document.getElementById('composerToolsWebSearchProvider') as HTMLSelectElement | null) ??
    (document.getElementById('chatAppToolsWebSearchProvider') as HTMLSelectElement | null) ??
    (document.getElementById('desktopToolsWebSearchProvider') as HTMLSelectElement | null);
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

/** Persist session tool-cache toggle from settings or composer popover. */
export function saveToolCacheFromUi(): void {
  const checkbox =
    (document.getElementById('settingsToolCacheEnabled') as HTMLInputElement | null) ??
    (document.getElementById('composerToolsCacheEnabled') as HTMLInputElement | null) ??
    (document.getElementById('chatAppToolsCacheEnabled') as HTMLInputElement | null);
  if (!checkbox) return;

  const config = loadToolConfig();
  config.toolCache = { enabled: checkbox.checked };
  saveToolConfig(config);
  loadToolConfigIntoDrawer(document);
}

/** @deprecated Use {@link saveWebSearchSettingsFromDrawer}. */
export function saveBraveApiKeyFromDrawer(): void {
  saveWebSearchSettingsFromDrawer();
}
