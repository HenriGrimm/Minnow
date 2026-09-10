/**
 * Proxy upstream models (and load/unload) with server-side auth injection.
 */

import { FAKE_PROVIDER_ID } from '../orchestrate/board-testing/fake-model-ids.js';
import { getFakeModelStatus } from '../orchestrate/board-testing/fake-model-host.js';
import { getProviderRuntime, LLAMA_CPP_LOCAL_ID, MLX_LM_LOCAL_ID } from './store.js';
import { normalizeModelsResponse, enrichLmStudioModelsWithV1Reasoning } from './paths.js';
import {
  enrichOpenCodeModelsFromModelsDev,
  isOpenCodeProviderBaseUrl,
} from './models-dev-context.js';
import { normalizeOpenCodeZenRelativePath } from './opencode-zen.js';
import {
  mergeOpenCodeIdentityHeaders,
  OPENCODE_SESSION_CATALOG,
} from './opencode-identity.js';
import { validateProviderId } from './validate.js';
import { resolveModelApi } from '../generations/resolve-model-api.js';
import { NON_AGENT_FALLBACK_ROLES } from '../generations/store.js';
import { enrichMlxLmModelsWithCachedContext } from '../models/mlx-context-length.js';
import { enrichLlamaCppModelsFromProps } from '../models/llama-cpp-modalities.js';
import { MODEL_LOAD_TIMEOUT_MS } from '../models/timeouts.js';
import { serveMatchesModelId } from '../models/admit-serve.js';
import {
  findLiveLlamaCppServeForModel,
  getLastTtlEviction,
  startServe,
  touchServeLastUsedAt,
} from '../models/serve.js';

const MODELS_TIMEOUT_MS = 15_000;

const UNREACHABLE_NET_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNRESET',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/**
 * True when the models catalog host is down (LM Studio not running, etc.).
 * HTTP 4xx/5xx from a live upstream are not unreachable.
 * @param {unknown} err
 */
export function isUpstreamCatalogUnreachable(err) {
  if (!err) return false;
  const name = err instanceof Error ? err.name : '';
  if (name === 'AbortError' || name === 'TimeoutError') return true;
  const message = err instanceof Error ? err.message : String(err);
  if (/aborted|timeout/i.test(message) && !message.startsWith('Upstream models HTTP')) {
    return true;
  }
  if (message === 'fetch failed' || /fetch failed/i.test(message)) return true;
  /** @type {unknown} */
  let cursor = err;
  for (let i = 0; i < 4 && cursor && typeof cursor === 'object'; i++) {
    const code = 'code' in cursor ? String(/** @type {{ code?: unknown }} */ (cursor).code ?? '') : '';
    if (UNREACHABLE_NET_CODES.has(code)) return true;
    cursor = 'cause' in cursor ? /** @type {{ cause?: unknown }} */ (cursor).cause : undefined;
  }
  return false;
}

/**
 * @param {string} id
 * Fake board-testing provider is registered but returns no models until the host starts.
 * A local runtime that is simply not up returns an empty catalog (not HTTP 500).
 */
export async function proxyModels(id) {
  validateProviderId(id);
  if (id === FAKE_PROVIDER_ID && !getFakeModelStatus().running) {
    return { data: [] };
  }
  const { profile, headers, paths } = await getProviderRuntime(id);
  const baseUrl = typeof profile.baseUrl === 'string' ? profile.baseUrl.trim() : '';
  if (!baseUrl || !paths.modelsPath) {
    // Agent CLI and other registry rows without an HTTP upstream (empty baseUrl).
    return { data: [] };
  }
  const modelsPath = normalizeOpenCodeZenRelativePath(baseUrl, paths.modelsPath);
  const url = `${baseUrl}${modelsPath}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODELS_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: mergeOpenCodeIdentityHeaders(
        {
          Accept: 'application/json',
          ...headers,
        },
        { baseUrl: profile.baseUrl, sessionId: OPENCODE_SESSION_CATALOG },
      ),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Upstream models HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const json = await res.json();
    let normalized = normalizeModelsResponse(profile.apiKind, json);
    if (profile.apiKind === 'lm-studio-v0') {
      normalized = await enrichLmStudioModelsWithV1Reasoning(
        profile.baseUrl,
        headers,
        normalized,
      );
    }
    if (isOpenCodeProviderBaseUrl(profile.baseUrl)) {
      normalized = await enrichOpenCodeModelsFromModelsDev(normalized);
    }
    if (id === MLX_LM_LOCAL_ID) {
      normalized = await enrichMlxLmModelsWithCachedContext(normalized);
    }
    if (id === LLAMA_CPP_LOCAL_ID) {
      normalized = await enrichLlamaCppModelsFromProps(
        profile.baseUrl,
        headers,
        normalized,
      );
    }
    normalized = {
      data: normalized.data.map((row) => ({
        ...row,
        api: resolveModelApi({ profile }, row.id, row),
      })),
    };
    return normalized;
  } catch (err) {
    if (isUpstreamCatalogUnreachable(err)) {
      const message = err instanceof Error ? err.message : String(err);
      return { data: [], unreachable: true, error: message };
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {string} id
 * @param {object} body
 */
export async function proxyModelLoad(id, body) {
  validateProviderId(id);
  const runtime = await getProviderRuntime(id);
  if (!runtime.capabilities.supportsModelLoadUnload) {
    throw new Error('Provider does not support model load/unload');
  }
  const loadPath = runtime.paths.modelsLoadPath;
  if (!loadPath) {
    throw new Error('Provider does not support model load/unload');
  }

  const url = `${runtime.profile.baseUrl}${loadPath}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODEL_LOAD_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...runtime.headers,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Upstream load HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {string} id
 * @param {object} body
 */
export async function proxyModelUnload(id, body) {
  validateProviderId(id);
  const runtime = await getProviderRuntime(id);
  if (!runtime.capabilities.supportsModelLoadUnload) {
    throw new Error('Provider does not support model load/unload');
  }
  const unloadPath = runtime.paths.modelsUnloadPath;
  if (!unloadPath) {
    throw new Error('Provider does not support model load/unload');
  }

  const url = `${runtime.profile.baseUrl}${unloadPath}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODEL_LOAD_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...runtime.headers,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Upstream unload HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Background llama.cpp callers (benchmark, expander, titles, editor-completion,
 * context-summarize). Interactive chat is everything else that looks like a user turn.
 *
 * llama-server's own queue is FIFO with no priority — `--parallel` alone will not
 * unstarve the composer, so Minnow serializes these behind a semaphore of 1.
 */
const BACKGROUND_FALLBACK_ROLES = new Set([
  ...NON_AGENT_FALLBACK_ROLES,
  'context-summarize',
]);

/**
 * @param {{ persist?: boolean, chatId?: string | null, fallbackRole?: string | null }} input
 * @returns {'interactive' | 'background'}
 */
export function classifyLocalCompletionPriority(input) {
  if (input?.persist === true) return 'interactive';
  if (typeof input?.chatId === 'string' && input.chatId.trim()) return 'interactive';
  const role = typeof input?.fallbackRole === 'string' ? input.fallbackRole.trim() : '';
  if (!role) return 'background';
  if (BACKGROUND_FALLBACK_ROLES.has(role)) return 'background';
  return 'interactive';
}

/** llama.cpp FIFO has no priority — one background job at a time so chat can cut in. */
let backgroundActive = 0;
/** @type {Array<{ grant: () => void, fail: (err: Error) => void }>} */
const backgroundWaiters = [];

function releaseBackgroundSlot() {
  const next = backgroundWaiters.shift();
  if (next) {
    next.grant();
    return;
  }
  backgroundActive = Math.max(0, backgroundActive - 1);
}

/**
 * @param {AbortSignal} [signal]
 * @returns {Promise<() => void>}
 */
function acquireBackgroundSlot(signal) {
  const onceRelease = () => {
    if (onceRelease.done) return;
    onceRelease.done = true;
    releaseBackgroundSlot();
  };
  onceRelease.done = false;

  if (backgroundActive < 1) {
    backgroundActive = 1;
    return Promise.resolve(onceRelease);
  }

  return new Promise((resolve, reject) => {
    const waiter = {
      grant() {
        resolve(onceRelease);
      },
      fail(err) {
        reject(err);
      },
    };
    const onAbort = () => {
      const idx = backgroundWaiters.indexOf(waiter);
      if (idx >= 0) backgroundWaiters.splice(idx, 1);
      const reason = signal?.reason;
      reject(reason instanceof Error ? reason : new Error('Background completion cancelled'));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    backgroundWaiters.push(waiter);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function resetLocalCompletionAdmissionForTests() {
  backgroundActive = 0;
  const waiters = backgroundWaiters.splice(0, backgroundWaiters.length);
  for (const waiter of waiters) {
    waiter.fail(new Error('reset'));
  }
}

/**
 * JIT-reload the one most recently TTL-evicted llama.cpp model. User-stopped
 * models never land in that snapshot. Wait is bounded by MODEL_LOAD_TIMEOUT_MS
 * inside startServe's health probe.
 *
 * @param {string} modelId
 */
async function jitReloadTtlEvicted(modelId) {
  const snap = getLastTtlEviction();
  if (!snap || !serveMatchesModelId(snap, modelId)) return null;
  return startServe({
    modelPath: snap.modelPath,
    runtime: 'llama-cpp',
    modelLabel: snap.modelLabel,
    llama: snap.llamaSettings ?? undefined,
    libraryId: snap.libraryId || undefined,
    hardware: snap.hardware ?? undefined,
    weightsGb: snap.weightsBytes > 0 ? snap.weightsBytes / 1024 ** 3 : undefined,
  });
}

/**
 * Route a llama.cpp (or MLX) completion to the live serve that actually hosts
 * `modelId`. Two llama-server processes cannot share `profile.baseUrl`; Minnow
 * picks the port. Do **not** turn on llama-server router mode.
 *
 * Interactive callers skip the background semaphore. Background callers wait
 * for a slot of 1; the caller **must** invoke `release` in a `finally`.
 *
 * @param {{
 *   providerId: string,
 *   modelId: string,
 *   priority: 'interactive' | 'background',
 *   signal?: AbortSignal,
 * }} opts
 * @returns {Promise<{ baseUrl: string, release: () => void }>}
 */
export async function admitLocalCompletion(opts) {
  const providerId = opts.providerId;
  const modelId = opts.modelId;
  const noopRelease = () => {};

  if (providerId === MLX_LM_LOCAL_ID) {
    const runtime = await getProviderRuntime(providerId);
    return { baseUrl: runtime.profile.baseUrl, release: noopRelease };
  }

  if (providerId !== LLAMA_CPP_LOCAL_ID) {
    const runtime = await getProviderRuntime(providerId);
    return { baseUrl: runtime.profile.baseUrl, release: noopRelease };
  }

  let release = noopRelease;
  if (opts.priority === 'background') {
    release = await acquireBackgroundSlot(opts.signal);
  }

  try {
    let row = await findLiveLlamaCppServeForModel(modelId);
    if (!row) {
      row = await jitReloadTtlEvicted(modelId);
    }
    if (!row || !row.baseUrl) {
      throw new Error(
        modelId
          ? `No loaded llama.cpp serve matches model ${modelId}`
          : 'No loaded llama.cpp serve matches the completion model',
      );
    }
    if (row.id) await touchServeLastUsedAt(row.id);
    return { baseUrl: row.baseUrl, release };
  } catch (err) {
    release();
    throw err;
  }
}
