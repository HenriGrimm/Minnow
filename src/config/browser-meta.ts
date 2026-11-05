/**
 * Built-in preview browser settings from config.json → `browser` (navigation allowlist).
 */

export interface BrowserMeta {
  enabled: boolean;
  allowNavigate: boolean;
  allowedOriginPatterns: string[];
  /** When true, reopen persisted preview tabs on boot (default on). */
  restoreBrowserTabs: boolean;
  nativeAgentTabs?: boolean;
}

export const DEFAULT_BROWSER_META: BrowserMeta = {
  enabled: true,
  allowNavigate: true,
  allowedOriginPatterns: [
    'http://localhost:*',
    'http://127.0.0.1:*',
    'https://localhost:*',
  ],
  restoreBrowserTabs: true,
  nativeAgentTabs: false,
};

let cached: BrowserMeta | null = null;
let metaLoaded = false;
let loadPromise: Promise<BrowserMeta> | null = null;

/** Coerce API payload into a browser config block. */
export function normalizeBrowserMeta(raw: unknown): BrowserMeta {
  if (!raw || typeof raw !== 'object') {
    return {
      ...DEFAULT_BROWSER_META,
      allowedOriginPatterns: [...DEFAULT_BROWSER_META.allowedOriginPatterns],
    };
  }
  const row = raw as Record<string, unknown>;
  const base: BrowserMeta = {
    ...DEFAULT_BROWSER_META,
    allowedOriginPatterns: [...DEFAULT_BROWSER_META.allowedOriginPatterns],
  };
  if (typeof row.enabled === 'boolean') base.enabled = row.enabled;
  if (typeof row.allowNavigate === 'boolean') base.allowNavigate = row.allowNavigate;
  if (typeof row.restoreBrowserTabs === 'boolean') base.restoreBrowserTabs = row.restoreBrowserTabs;
  if (typeof row.nativeAgentTabs === 'boolean') base.nativeAgentTabs = row.nativeAgentTabs;
  if (Array.isArray(row.allowedOriginPatterns)) {
    base.allowedOriginPatterns = row.allowedOriginPatterns.filter(
      (p): p is string => typeof p === 'string' && p.trim().length > 0,
    );
  }
  return base;
}

/** Load browser prefs from GET /api/config/meta. */
export async function loadBrowserMeta(): Promise<BrowserMeta> {
  if (cached) return cached;
  if (loadPromise) return loadPromise;

  loadPromise = (async (): Promise<BrowserMeta> => {
    try {
      const res = await fetch('/api/config/meta', { cache: 'no-store' });
      if (!res.ok) {
        cached = normalizeBrowserMeta(null);
        return cached;
      }
      const meta = (await res.json()) as { browser?: unknown };
      cached = normalizeBrowserMeta(meta.browser);
      return cached;
    } catch {
      cached = normalizeBrowserMeta(null);
      return cached;
    } finally {
      metaLoaded = true;
      loadPromise = null;
    }
  })();

  return loadPromise;
}

/** Persist partial browser block via PUT /api/config/meta. */
export async function saveBrowserMeta(patch: Partial<BrowserMeta>): Promise<void> {
  const current = await loadBrowserMeta();
  const next: BrowserMeta = {
    enabled: patch.enabled ?? current.enabled,
    allowNavigate: patch.allowNavigate ?? current.allowNavigate,
    allowedOriginPatterns:
      patch.allowedOriginPatterns ?? [...current.allowedOriginPatterns],
    restoreBrowserTabs: patch.restoreBrowserTabs ?? current.restoreBrowserTabs,
    nativeAgentTabs: patch.nativeAgentTabs ?? current.nativeAgentTabs ?? false,
  };
  const response = await fetch('/api/config/meta', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ browser: next }),
  });
  if (!response.ok) throw new Error('Could not save browser settings');
  cached = next;
}

/** Cached value for settings UI (call loadBrowserMeta during init). */
export function getBrowserMetaCached(): BrowserMeta {
  return cached ?? normalizeBrowserMeta(null);
}

export function isBrowserMetaLoaded(): boolean {
  return metaLoaded;
}

export function invalidateBrowserMetaCache(): void {
  cached = null;
  metaLoaded = false;
  loadPromise = null;
}

export interface BrowserAllowlistCheckPayload {
  allowed: boolean;
  allowNavigate: boolean;
  suggestedPattern: string;
  origin: string;
}

export type BrowserAllowlistCheckFailureReason = 'auth' | 'network' | 'invalid' | 'http';

export type BrowserAllowlistCheckResult =
  | ({ success: true } & BrowserAllowlistCheckPayload)
  | { success: false; reason: BrowserAllowlistCheckFailureReason; status?: number };

/** Ask the server whether a URL may be navigated to (authoritative allowlist check). */
export async function checkBrowserNavigationAllowed(
  url: string,
): Promise<BrowserAllowlistCheckResult> {
  try {
    const res = await fetch(
      `/api/browser/allowlist/check?url=${encodeURIComponent(url)}`,
      { cache: 'no-store' },
    );
    if (res.status === 401 || res.status === 403) {
      return { success: false, reason: 'auth', status: res.status };
    }
    if (res.status === 400) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      const errText = typeof body.error === 'string' ? body.error.toLowerCase() : '';
      if (errText.includes('invalid')) {
        return { success: false, reason: 'invalid', status: 400 };
      }
      return { success: false, reason: 'http', status: 400 };
    }
    if (!res.ok) {
      return { success: false, reason: 'http', status: res.status };
    }
    const payload = (await res.json()) as BrowserAllowlistCheckPayload;
    return { success: true, ...payload };
  } catch {
    return { success: false, reason: 'network' };
  }
}

/** Grant once or persist pattern after user approval in the UI. */
export async function approveBrowserNavigation(
  url: string,
  mode: 'once' | 'persist',
): Promise<boolean> {
  try {
    const res = await fetch('/api/browser/allowlist/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, mode }),
    });
    if (!res.ok) return false;
    if (mode === 'persist') {
      invalidateBrowserMetaCache();
      await loadBrowserMeta();
    }
    return true;
  } catch {
    return false;
  }
}
