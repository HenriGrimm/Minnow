/**
 * Injectable base URL for headless CLI — rewrites relative /api/* fetch calls.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultMinnowLocalOrigin } from '../config/minnow-port.ts';

let headlessBaseUrl = defaultMinnowLocalOrigin();
let restoreFetch: (() => void) | null = null;
let headlessWorkspace = '';

/** Resolve ~/.minnow (or MINNOW_HOME override) without importing server/* from src/. */
function resolveMinnowHome(): string {
  const override = process.env.MINNOW_HOME?.trim() || process.env.SPEEDCHAT_HOME?.trim();
  return override ? path.resolve(override) : path.join(os.homedir(), '.minnow');
}

/** Read the session token a running server wrote to disk at boot. Empty string if absent. */
export function readSessionTokenFile(): string {
  try {
    return fs.readFileSync(path.join(resolveMinnowHome(), 'session-token'), 'utf8').trim();
  } catch {
    return '';
  }
}

/** --token flag > MINNOW_TOKEN env > the token file a running server wrote at boot. */
export function resolveHeadlessToken(explicitToken?: string | null): string {
  return explicitToken?.trim() || process.env.MINNOW_TOKEN?.trim() || readSessionTokenFile();
}

/** Normalize base URL (no trailing slash). */
export function normalizeBaseUrl(url: string): string {
  return url.replace(/\/$/, '');
}

/** Current headless API origin. */
export function getHeadlessBaseUrl(): string {
  return headlessBaseUrl;
}

/** Resolve an API path against the headless base URL. */
export function headlessApiUrl(path: string): string {
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${headlessBaseUrl}${p}`;
}

/**
 * Stamp the credential and — when the run targets a specific folder — the
 * workspace, so the server scopes the request instead of the CLI repointing
 * everyone's workspace with a global `PUT /api/workspace`.
 */
function withMinnowHeaders(init: RequestInit | undefined, token: string): RequestInit | undefined {
  if (!token && !headlessWorkspace) return init;
  const headers = new Headers(init?.headers);
  if (token) headers.set('X-Minnow-Token', token);
  if (headlessWorkspace) headers.set('X-Minnow-Workspace', headlessWorkspace);
  return { ...init, headers };
}

function isTransientFetchError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.message.includes('fetch failed')) return true;
  const cause = error.cause;
  if (!cause || typeof cause !== 'object') return false;
  const code = 'code' in cause ? String((cause as { code?: unknown }).code) : '';
  return code === 'UND_ERR_SOCKET' || code === 'ECONNRESET' || code === 'ECONNREFUSED';
}

async function fetchWithTransientRetry(
  fetchImpl: typeof fetch,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const maxAttempts = process.env.MINNOW_TEST === '1' ? 5 : 1;
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await fetchImpl(input, init);
    } catch (error) {
      lastError = error;
      if (!isTransientFetchError(error) || attempt === maxAttempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
  throw lastError;
}

/** The workspace every headless request is scoped to, or `''` for the global. */
export function getHeadlessWorkspace(): string {
  return headlessWorkspace;
}

/** Patch global fetch so `/api/...` hits the dev server (returns restore fn). */
export function installHeadlessFetch(baseUrl: string, token = '', workspacePath = ''): () => void {
  if (restoreFetch) {
    restoreFetch();
    restoreFetch = null;
  }
  headlessBaseUrl = normalizeBaseUrl(baseUrl);
  headlessWorkspace = workspacePath;
  const apiOrigin = new URL(headlessBaseUrl).origin;
  const nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl = input instanceof Request ? input.url : String(input);
    const url = rawUrl.startsWith('/api/') ? headlessApiUrl(rawUrl) : rawUrl;
    const parsed = new URL(url);
    if (parsed.origin === apiOrigin && parsed.pathname.startsWith('/api/')) {
      const requestInit = input instanceof Request
        ? { ...init, headers: init?.headers ?? input.headers }
        : init;
      return fetchWithTransientRetry(
        nativeFetch,
        input instanceof Request ? input : url,
        withMinnowHeaders(requestInit, token),
      );
    }
    return nativeFetch(input, init);
  }) as typeof fetch;
  restoreFetch = () => {
    globalThis.fetch = nativeFetch;
    restoreFetch = null;
  };
  return restoreFetch;
}

/** Minimal localStorage for Node (config loaders mirror to localStorage). */
export function installHeadlessLocalStorage(): void {
  if (typeof globalThis.localStorage !== 'undefined') return;
  const store = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    key(index: number) {
      return [...store.keys()][index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
    writable: true,
  });
}
