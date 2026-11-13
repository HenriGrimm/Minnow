/**
 * Detect whether file-backed config (/api/config) is available.
 */

const CONFIG_PING_TIMEOUT_MS = 2500;
const CONFIG_PING_ATTEMPTS = 3;
const CONFIG_PING_RETRY_DELAY_MS = 200;

export type StorageMode = 'server' | 'localStorage';

let storageMode: StorageMode = 'localStorage';
/** When true, detectConfigServer returns the pinned mode without network probes. */
let storageModePinnedForTests = false;

/** Current persistence mode (set after detectConfigServer). */
export function getStorageMode(): StorageMode {
  return storageMode;
}

/** Override storage mode (unit / headless tests). Pass null to clear the pin. */
export function setStorageModeForTests(mode: StorageMode | null): void {
  if (mode === null) {
    storageMode = 'localStorage';
    storageModePinnedForTests = false;
    return;
  }
  storageMode = mode;
  storageModePinnedForTests = true;
}

/** Whether reads/writes should use ~/.minnow via the API. */
export function isServerStorageMode(): boolean {
  return storageMode === 'server';
}

/** Type-safe check for StorageMode probe results (strings are truthy — never use `!mode`). */
export function isConfigServerMode(mode: StorageMode): boolean {
  return mode === 'server';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Single GET /api/config/ping attempt with abort timeout. */
async function pingConfigServerOnce(): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG_PING_TIMEOUT_MS);

  try {
    const res = await fetch('/api/config/ping', {
      method: 'GET',
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { ok?: boolean };
    return data.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Probe the config API with short retries (startup can be slow on Windows). */
async function probeConfigServer(): Promise<StorageMode> {
  for (let attempt = 0; attempt < CONFIG_PING_ATTEMPTS; attempt++) {
    if (await pingConfigServerOnce()) {
      return 'server';
    }
    if (attempt < CONFIG_PING_ATTEMPTS - 1) {
      await sleep(CONFIG_PING_RETRY_DELAY_MS);
    }
  }
  return 'localStorage';
}

/**
 * Ping /api/config/ping; authoritative for Step 02 persistence.
 * Successful server mode is cached; localStorage is re-probed on later calls.
 */
export async function detectConfigServer(): Promise<StorageMode> {
  if (storageModePinnedForTests) {
    return storageMode;
  }
  if (storageMode === 'server') {
    return storageMode;
  }

  storageMode = await probeConfigServer();
  return storageMode;
}

let configMetaRequest: Promise<Record<string, unknown> | null> | undefined;

/** Share a single GET among concurrent settings readers, without caching its result. */
export function readConfigMeta(): Promise<Record<string, unknown> | null> {
  configMetaRequest ??= fetch('/api/config/meta', { cache: 'no-store' })
    .then(async (response) => response.ok ? await response.json() as Record<string, unknown> : null)
    .finally(() => { configMetaRequest = undefined; });
  return configMetaRequest;
}

/** Show or hide the settings banner for Vite-only mode. */
export function refreshConfigStorageBanner(): void {
  if (typeof document === 'undefined') return;
  const banner = document.getElementById('configStorageBanner');
  if (!banner) return;
  banner.classList.toggle('hidden', storageMode === 'server');
}
