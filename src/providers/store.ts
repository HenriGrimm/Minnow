/**
 * Client access to ~/.minnow provider registry via /api/providers.
 */

import { isServerStorageMode } from '../config/storage-mode';
import { parseServerBaseUrl, serverUrl } from '../ui/status';
import type { ProviderPricing } from '../usage/types';
import type {
  ApiKind,
  AuthStyle,
  ProviderListResponse,
  ProviderPublic,
} from './types';

/** Body for POST /api/providers. */
export interface CreateProviderPayload {
  id: string;
  label: string;
  baseUrl: string;
  apiKind?: ApiKind;
  authStyle?: AuthStyle;
  enabled?: boolean;
  modelsPath?: string;
  chatCompletionsPath?: string;
  messagesPath?: string;
  autoApi?: boolean;
  modelApiOverrides?: Record<string, ApiKind> | null;
  constrainedToolCalls?: boolean | null;
  pricing?: ProviderPricing | null;
}

/** Body for PUT /api/providers/:id (id is not mutable). */
export interface UpdateProviderPayload {
  label?: string;
  baseUrl?: string;
  apiKind?: ApiKind;
  authStyle?: AuthStyle;
  enabled?: boolean;
  modelsPath?: string;
  chatCompletionsPath?: string;
  messagesPath?: string;
  autoApi?: boolean;
  modelApiOverrides?: Record<string, ApiKind> | null;
  constrainedToolCalls?: boolean | null;
  pricing?: ProviderPricing | null;
}

const PROVIDERS_TIMEOUT_MS = 5_000;

let cachedList: ProviderListResponse | null = null;
let cachedAt: number | null = null;
let providersAvailable = false;
let providersInFlight: Promise<ProviderListResponse> | null = null;

const PROVIDERS_CACHE_TTL_MS = 30_000;

// ── Fallback ─────────────────────────────────────────────────────────────────

/** Whether /api/providers was reachable (npm start). */
export function isProvidersApiAvailable(): boolean {
  return providersAvailable;
}

/** Vite-only fallback: direct LM Studio from settings URL field. */
export function getViteOnlyFallbackProvider(): ProviderPublic {
  const raw = serverUrl() || 'http://localhost:1234';
  const baseUrl = parseServerBaseUrl(raw) || 'http://localhost:1234';
  return {
    id: 'vite-fallback',
    label: 'LM Studio (local)',
    baseUrl,
    apiKind: 'lm-studio-v0',
    enabled: true,
    hasApiKey: false,
    hasBearer: false,
  };
}

// ── List ─────────────────────────────────────────────────────────────────────

async function fetchProvidersList(): Promise<ProviderListResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDERS_TIMEOUT_MS);
  try {
    const res = await fetch('/api/providers', {
      method: 'GET',
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const data = (await res.json()) as ProviderListResponse;
    if (!Array.isArray(data.providers)) throw new Error('Invalid provider registry');
    providersAvailable = true;
    cachedList = data;
    cachedAt = Date.now();
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/** Load provider list from server or synthesize fallback. */
export async function listProviders(): Promise<ProviderListResponse> {
  if (!isServerStorageMode()) {
    const provider = getViteOnlyFallbackProvider();
    return { providers: [provider], activeProviderId: provider.id };
  }

  if (cachedList && cachedAt !== null && Date.now() - cachedAt < PROVIDERS_CACHE_TTL_MS) {
    return cachedList;
  }

  if (!providersInFlight) {
    providersInFlight = (async () => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try { return await fetchProvidersList(); } catch {
          if (cachedList) return cachedList;
        }
      }
      providersAvailable = false;
      throw new Error('Could not load providers from the host. Check the connection and retry.');
    })().finally(() => { providersInFlight = null; });
  }
  return providersInFlight;
}

export interface ResolveProviderOptions {
  /**
   * Reject an explicit id that matches no enabled provider instead of falling
   * back. Use on request paths that have already resolved a real registry id —
   * silently substituting another provider sends the turn to the wrong backend.
   */
  strict?: boolean;
}

/** Thrown by `resolveProvider` in strict mode when the requested id is not usable. */
export class UnknownProviderError extends Error {
  readonly providerId: string;

  constructor(providerId: string) {
    super(`Provider "${providerId}" is not available — check Settings → Providers.`);
    this.name = 'UnknownProviderError';
    this.providerId = providerId;
  }
}

// ── Resolve ──────────────────────────────────────────────────────────────────

/**
 * Resolve which provider record to use for chat, benchmarks, and generations.
 * Ignores persisted `activeProviderId` — routing is driven by explicit `chat.providerId`
 * or the first enabled provider in registry order.
 *
 * A requested id that misses is a routing bug (e.g. the synthetic `minnow-library`
 * key reaching a send path unmapped), so the fallback warns rather than swapping
 * backends behind the caller's back.
 */
export async function resolveProvider(
  chatProviderId?: string,
  options?: ResolveProviderOptions,
): Promise<ProviderPublic> {
  if (chatProviderId === 'minnow-router') return { id: 'minnow-router', label: 'Model pool', baseUrl: '', apiKind: 'openai-v1', enabled: true, hasApiKey: false, hasBearer: false, supportsModelLoadUnload: false };
  const { providers } = await listProviders();
  const enabled = providers.filter((p) => p.enabled !== false);
  const want = chatProviderId?.trim();
  if (want) {
    const found = enabled.find((p) => p.id === want);
    if (found) return found;
    if (options?.strict) {
      throw new UnknownProviderError(want);
    }
    console.warn(
      `[providers] no enabled provider "${want}" — falling back to "${enabled[0]?.id ?? 'vite-fallback'}"`,
    );
  }
  if (enabled.length > 0) return enabled[0];
  return getViteOnlyFallbackProvider();
}

/** @deprecated Use resolveProvider — kept for call-site compatibility; no longer reads activeProviderId. */
export async function getActiveProvider(
  chatProviderId?: string,
  options?: ResolveProviderOptions,
): Promise<ProviderPublic> {
  return resolveProvider(chatProviderId, options);
}

/** POST set-active on server; no-op in Vite-only mode. */
export async function setActiveProvider(id: string): Promise<void> {
  if (!isServerStorageMode() || !providersAvailable) {
    return;
  }

  const res = await fetch(`/api/providers/${encodeURIComponent(id)}/set-active`, {
    method: 'POST',
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new Error(`Failed to set active provider: HTTP ${res.status}`);
  }
  cachedList = null;
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

/** PUT /api/providers/:id — update profile fields (not secrets). */
export async function updateProvider(
  id: string,
  payload: UpdateProviderPayload,
): Promise<{ ok: true; provider: ProviderPublic } | { ok: false; error: string }> {
  if (!isServerStorageMode()) {
    return { ok: false, error: 'Provider settings need Minnow running locally.' };
  }
  try {
    const res = await fetch(`/api/providers/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      cache: 'no-store',
    });
    const body = (await res.json()) as ProviderPublic & { error?: string };
    if (!res.ok) {
      return { ok: false, error: body.error ?? `Failed to update provider (HTTP ${res.status})` };
    }
    invalidateProviderCache();
    providersAvailable = true;
    return { ok: true, provider: body };
  } catch {
    return { ok: false, error: 'Network error. Open or restart Minnow and try again.' };
  }
}

/** POST /api/providers — register a new LLM backend. */
export async function createProvider(
  payload: CreateProviderPayload,
): Promise<{ ok: true; provider: ProviderPublic } | { ok: false; error: string }> {
  if (!isServerStorageMode()) {
    return { ok: false, error: 'Provider settings need Minnow running locally.' };
  }
  try {
    const res = await fetch('/api/providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      cache: 'no-store',
    });
    const body = (await res.json()) as ProviderPublic & { error?: string };
    if (!res.ok) {
      return { ok: false, error: body.error ?? `Failed to add provider (HTTP ${res.status})` };
    }
    invalidateProviderCache();
    providersAvailable = true;
    return { ok: true, provider: body };
  } catch {
    return { ok: false, error: 'Network error. Open or restart Minnow and try again.' };
  }
}

/** DELETE /api/providers/:id (409 when last provider). */
export async function deleteProvider(
  id: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!isServerStorageMode() || !providersAvailable) {
    return { ok: false, error: 'Provider settings need Minnow running locally.' };
  }
  try {
    const res = await fetch(`/api/providers/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      cache: 'no-store',
    });
    if (res.status === 204) {
      invalidateProviderCache();
      return { ok: true };
    }
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return {
      ok: false,
      error: body.error ?? `Failed to remove provider (HTTP ${res.status})`,
    };
  } catch {
    return { ok: false, error: 'Network error. Open or restart Minnow and try again.' };
  }
}

/** PUT /api/providers/:id/secrets — API key / bearer (never echoed on GET). */
export async function updateProviderSecrets(
  id: string,
  secrets: { apiKey?: string; bearerToken?: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!isServerStorageMode() || !providersAvailable) {
    return { ok: false, error: 'Provider settings need Minnow running locally.' };
  }
  try {
    const res = await fetch(`/api/providers/${encodeURIComponent(id)}/secrets`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(secrets),
      cache: 'no-store',
    });
    const body = (await res.json()) as { ok?: boolean; error?: string };
    if (!res.ok) {
      return { ok: false, error: body.error ?? `Failed to save secrets (HTTP ${res.status})` };
    }
    invalidateProviderCache();
    return { ok: true };
  } catch {
    return { ok: false, error: 'Network error. Open or restart Minnow and try again.' };
  }
}

/** Clear cached list after external changes. */
export function invalidateProviderCache(): void {
  cachedList = null;
  cachedAt = null;
}

/** Last cached list (if any). */
export function getCachedProviderList(): ProviderListResponse | null {
  return cachedList;
}
