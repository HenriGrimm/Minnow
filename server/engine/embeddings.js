/**
 * Pluggable memory embedder: local transformers.js first, provider /v1/embeddings optional.
 */

import path from 'node:path';
import { getMinnowHome } from '../config/home.js';
import { getProviderRuntime } from '../providers/store.js';
import { getDefaultPaths } from '../providers/paths.js';
import { runWithDeadline } from '../../src/lib/async-deadline.mjs';

/** Default local model (384-d MiniLM). */
export const DEFAULT_EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';

/** Default embeddings subsection in memory config. */
export const DEFAULT_EMBEDDINGS_CONFIG = {
  enabled: true,
  backend: 'local',
  modelId: DEFAULT_EMBEDDING_MODEL,
  providerId: '',
  blendWeight: 0.5,
  queryTimeoutMs: 3000,
  reindexNeeded: false,
};

/** Cached local pipeline promise keyed by model id. */
const localPipelineCache = new Map();

/**
 * Resolve on-disk cache directory for local embedding models.
 */
export function getEmbeddingsModelDir() {
  return path.join(getMinnowHome(), 'models', 'embeddings');
}

/** Minimum warmup timeout — first model download can take several minutes. */
export const EMBEDDINGS_WARMUP_TIMEOUT_MS = 300_000;

/**
 * Apply Windows-friendly Hugging Face cache settings before model download.
 * transformers.js reads `env.cacheDir`; TRANSFORMERS_CACHE alone is not enough.
 * @returns {string} Resolved cache directory under ~/.minnow/models/embeddings/
 */
export function applyEmbeddingsEnv() {
  const cacheDir = getEmbeddingsModelDir();
  process.env.TRANSFORMERS_CACHE = cacheDir;
  if (process.platform === 'win32') {
    process.env.HF_HUB_DISABLE_SYMLINKS = '1';
  }
  return cacheDir;
}

/**
 * Configure @xenova/transformers to cache models under ~/.minnow/models/embeddings/.
 */
export async function configureTransformersCache() {
  const cacheDir = applyEmbeddingsEnv();
  const { env } = await import('@xenova/transformers');
  env.cacheDir = cacheDir;
  env.useFSCache = true;
  return cacheDir;
}

/**
 * Reject a promise after timeoutMs.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} timeoutMs
 * @param {string} [message]
 */
export function withTimeout(promise, timeoutMs, message = 'Embedding request timed out') {
  const ms = Number(timeoutMs);
  if (!Number.isFinite(ms) || ms <= 0) return promise;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

/**
 * Embed texts with timeout wrapper.
 * @param {{ embed: (texts: string[]) => Promise<number[][]>, id: string, dim: number, backend: string }} embedder
 * @param {string[]} texts
 * @param {number} timeoutMs
 */
export async function embedTexts(embedder, texts, timeoutMs, { signal } = {}) {
  const list = Array.isArray(texts) ? texts.map((t) => String(t ?? '')) : [''];
  return runWithDeadline(querySignal => embedder.embed(list, { signal: querySignal }), { timeoutMs, signal });
}

/**
 * Create a local transformers.js embedder.
 * @param {{ modelId?: string }} config
 */
export async function createLocalEmbedder(config = {}) {
  const modelId = String(config.modelId ?? DEFAULT_EMBEDDING_MODEL).trim() || DEFAULT_EMBEDDING_MODEL;

  let pipelinePromise = localPipelineCache.get(modelId);
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      await configureTransformersCache();
      const { pipeline } = await import('@xenova/transformers');
      return pipeline('feature-extraction', modelId);
    })();
    localPipelineCache.set(modelId, pipelinePromise);
    pipelinePromise.catch(() => {
      if (localPipelineCache.get(modelId) === pipelinePromise) localPipelineCache.delete(modelId);
    });
  }

  const extractor = await pipelinePromise;

  return {
    id: modelId,
    backend: 'local',
    dim: 384,
    async embed(texts, { signal } = {}) {
      const out = [];
      for (const text of texts) {
        signal?.throwIfAborted();
        const result = await extractor(text, { pooling: 'mean', normalize: true });
        signal?.throwIfAborted();
        out.push(Array.from(result.data));
      }
      return out;
    },
  };
}

/**
 * Create a provider-backed OpenAI-compatible embeddings client.
 * @param {{ modelId?: string, providerId?: string, embeddingsPath?: string }} config
 */
export async function createProviderEmbedder(config = {}) {
  const providerId = String(config.providerId ?? '').trim();
  if (!providerId) {
    throw new Error('Provider embeddings backend requires providerId');
  }

  const runtime = await getProviderRuntime(providerId);
  const paths = getDefaultPaths(runtime.profile.apiKind, runtime.profile);
  const embeddingsPath =
    typeof runtime.profile.embeddingsPath === 'string' && runtime.profile.embeddingsPath.trim()
      ? runtime.profile.embeddingsPath.trim()
      : typeof config.embeddingsPath === 'string' && config.embeddingsPath.trim()
        ? config.embeddingsPath.trim()
        : paths.embeddingsPath ?? '/v1/embeddings';

  const modelId = String(config.modelId ?? 'text-embedding-3-small').trim() || 'text-embedding-3-small';
  const url = `${runtime.profile.baseUrl}${embeddingsPath}`;

  return {
    id: modelId,
    backend: 'provider',
    dim: 0,
    async embed(texts, { signal } = {}) {
      const res = await fetch(url, {
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...runtime.headers,
        },
        body: JSON.stringify({
          model: modelId,
          input: texts,
        }),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Embeddings HTTP ${res.status}: ${text.slice(0, 200)}`);
      }

      const json = await res.json();
      const rows = Array.isArray(json?.data) ? json.data : [];
      rows.sort((a, b) => Number(a?.index ?? 0) - Number(b?.index ?? 0));
      const vectors = rows.map((row) => {
        const embedding = Array.isArray(row?.embedding) ? row.embedding : [];
        return embedding;
      });
      if (vectors[0]?.length) {
        this.dim = vectors[0].length;
      }
      return vectors;
    },
  };
}

/**
 * Resolve embedder for the active memory embeddings config.
 * @param {object} memoryConfig
 */
export async function getEmbedder(memoryConfig) {
  const emb = {
    ...DEFAULT_EMBEDDINGS_CONFIG,
    ...(memoryConfig?.embeddings && typeof memoryConfig.embeddings === 'object'
      ? memoryConfig.embeddings
      : {}),
  };

  if (emb.backend === 'provider') {
    return createProviderEmbedder(emb);
  }
  return createLocalEmbedder(emb);
}

/** Reset cached local pipelines (tests). */
export function resetEmbeddingsCacheForTests() {
  localPipelineCache.clear();
}
