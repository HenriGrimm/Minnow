import crypto from 'node:crypto';
import { resolveHfTokenAsync, nextHfPage, hfErrorMessage } from './hf-client.js';
import { isMlxSupported, MLX_UNSUPPORTED_MESSAGE } from '../servers/mlx-lm.js';
import { validateRepoId } from './validate.js';

// mlx-lm cannot load vision checkpoints; those belong to mlx-vlm.
const MLX_UNSERVABLE_PIPELINE_TAGS = new Set(['image-text-to-text', 'image-to-text', 'visual-question-answering']);
// llama.cpp loads multimodal GGUFs text-only (or with a sibling mmproj), and most current
// official GGUF repos are tagged image-text-to-text / any-to-any or not tagged at all, so
// GGUF search keeps every chat-shaped tag and only drops clearly non-chat pipelines.
const GGUF_SERVABLE_PIPELINE_TAGS = new Set([
  '',
  'text-generation',
  'text2text-generation',
  'image-text-to-text',
  'any-to-any',
  'conversational',
]);

/** @param {string} format @param {string} pipelineTag */
function isServable(format, pipelineTag) {
  return format === 'mlx'
    ? !MLX_UNSERVABLE_PIPELINE_TAGS.has(pipelineTag)
    : GGUF_SERVABLE_PIPELINE_TAGS.has(pipelineTag);
}

const CACHE_TTL_MS = 60_000;
const MAX_LIMIT = 48;
const DEFAULT_LIMIT = 24;

/** @type {Map<string, { at: number, value: object }>} */
const cache = new Map();

let fetchImpl = (...args) => fetch(...args);

/** @param {typeof fetch} fn */
export function setHfSearchFetchForTests(fn) {
  fetchImpl = fn;
}

export function resetHfSearchForTests() {
  fetchImpl = (...args) => fetch(...args);
  cache.clear();
}

const DTYPE_BYTES = {
  F64: 8,
  I64: 8,
  U64: 8,
  F32: 4,
  I32: 4,
  U32: 4,
  BF16: 2,
  F16: 2,
  I16: 2,
  U16: 2,
  F8_E4M3: 1,
  F8_E5M2: 1,
  I8: 1,
  U8: 1,
  BOOL: 1,
};

/**
 * @param {Record<string, any> | undefined} safetensors
 * @returns {number | null}
 */
function tensorBytes(safetensors) {
  const parameters = safetensors?.parameters;
  if (!parameters || typeof parameters !== 'object') return null;
  let bytes = 0;
  let matched = false;
  for (const [dtype, count] of Object.entries(parameters)) {
    const n = Number(count);
    const width = DTYPE_BYTES[String(dtype).toUpperCase()];
    if (!Number.isFinite(n) || n <= 0 || width == null) continue;
    bytes += n * width;
    matched = true;
  }
  return matched ? Math.round(bytes) : null;
}

/**
 * @param {string} name
 * @returns {number | null}
 */
function inferParamsFromName(name) {
  const match = /(?:^|[^a-z0-9])(\d+(?:\.\d+)?)\s*b(?:[^a-z0-9]|$)/i.exec(name);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 && value < 2000 ? value : null;
}

/**
 * @param {Record<string, unknown> | undefined} config
 * @param {string} format
 * @param {string} repoId
 */
function resolveQuant(config, format, repoId) {
  if (format !== 'mlx') return '';

  const quantization = config?.quantization;
  const quantConfig = config?.quantization_config;
  const bits =
    quantization && typeof quantization === 'object' && Number.isFinite(Number(quantization.bits))
      ? Number(quantization.bits)
      : quantConfig &&
          typeof quantConfig === 'object' &&
          Number.isFinite(Number(quantConfig.bits))
        ? Number(quantConfig.bits)
        : NaN;
  if (Number.isFinite(bits) && bits > 0) return `mlx-${bits}bit`;

  const named = /(\d+)\s*bit/i.exec(repoId);
  return named ? `mlx-${named[1]}bit` : '';
}

/**
 * @param {Record<string, unknown> | undefined} config
 * @param {string} repoId
 */
function resolveArch(config, repoId) {
  if (typeof config?.model_type === 'string' && config.model_type) return config.model_type;
  const architectures = config?.architectures;
  if (Array.isArray(architectures) && typeof architectures[0] === 'string') {
    return architectures[0];
  }
  const tail = repoId.split('/').pop() ?? repoId;
  return tail.split(/[-_.]/)[0] ?? '';
}

/**
 * @param {Record<string, any>} row
 * @param {string} format
 */
export function mapHubRow(row, format) {
  const repoId = String(row.id ?? row.modelId ?? '');
  const config = row.config && typeof row.config === 'object' ? row.config : undefined;
  const safetensors =
    row.safetensors && typeof row.safetensors === 'object' ? row.safetensors : undefined;

  const quant = resolveQuant(config, format, repoId);
  const named = inferParamsFromName(repoId);
  const declaredTotal = Number(safetensors?.total);
  const paramsB =
    named ??
    (!quant && Number.isFinite(declaredTotal) && declaredTotal > 0
      ? Number((declaredTotal / 1e9).toFixed(2))
      : null);

  const template = typeof config?.chat_template_jinja === 'string' ? config.chat_template_jinja : '';

  return {
    repoId,
    format,
    quant,
    arch: resolveArch(config, repoId),
    paramsB,
    sizeBytes: tensorBytes(safetensors),
    downloads: Number(row.downloads) || 0,
    likes: Number(row.likes) || 0,
    gated: Boolean(row.gated),
    toolCapable: /\btools?\b/.test(template),
    pipelineTag: typeof row.pipeline_tag === 'string' ? row.pipeline_tag : '',
  };
}

/**
 * @param {{ query?: string, format?: string, limit?: number, sort?: string }} options
 * @returns {Promise<{ results: object[], reason: string | null, hasToken: boolean }>}
 */
export async function searchHubModels(options = {}) {
  const format = options.format === 'mlx' ? 'mlx' : 'gguf';
  const query = typeof options.query === 'string' ? options.query.trim().slice(0, 120) : '';
  const requested = Number(options.limit);
  const limit = Number.isFinite(requested)
    ? Math.max(1, Math.min(MAX_LIMIT, Math.trunc(requested)))
    : DEFAULT_LIMIT;
  const sort = ['downloads', 'likes', 'lastModified'].includes(String(options.sort))
    ? String(options.sort)
    : 'downloads';

  const token = await resolveHfTokenAsync().catch(() => '');
  const hasToken = Boolean(token);

  if (format === 'mlx' && !isMlxSupported()) {
    return { results: [], reason: MLX_UNSUPPORTED_MESSAGE, hasToken };
  }

  const cursor = options.cursor ? nextHfPage(`<${options.cursor}>; rel="next"`, '/api/models') : null;
  const cacheKey = `${crypto.createHash('sha256').update(token).digest('hex')}:${format}:${sort}:${limit}:${query}:${cursor ?? ''}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return { ...cached.value, hasToken };
  }

  const url = new URL(cursor ?? 'https://huggingface.co/api/models');
  url.searchParams.append('filter', format);
  // The Hub's pipeline filter is a single tag, and GGUF repos spread across several.
  if (format === 'mlx') url.searchParams.append('filter', 'text-generation');
  const repoQuery = query.match(/^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/);
  if (query) url.searchParams.set('search', repoQuery ? repoQuery[2] : query);
  if (repoQuery) url.searchParams.set('author', repoQuery[1]);
  url.searchParams.set('sort', sort);
  url.searchParams.set('direction', '-1');
  url.searchParams.set('limit', String(limit));
  url.searchParams.delete('expand[]');
  for (const field of ['config', 'safetensors', 'downloads', 'likes', 'gated', 'tags', 'pipeline_tag']) {
    url.searchParams.append('expand[]', field);
  }

  const headers = { 'User-Agent': 'Minnow/1.0' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetchImpl(url.toString(), {
    headers,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(hfErrorMessage(res.status));
  }
  const data = await res.json();
  if (!Array.isArray(data)) {
    return { results: [], reason: null, hasToken };
  }

  const results = [];
  for (const row of data) {
    if (results.length >= limit) break;
    if (!row || typeof row !== 'object') continue;

    const rawId = String(row.id ?? row.modelId ?? '');
    try {
      validateRepoId(rawId);
    } catch {
      continue;
    }

    const pipelineTag = typeof row.pipeline_tag === 'string' ? row.pipeline_tag : '';
    if (!isServable(format, pipelineTag)) continue;

    results.push(mapHubRow(row, format));
  }

  const value = { results, reason: null, nextCursor: nextHfPage(res.headers?.get('link'), '/api/models') };
  cache.set(cacheKey, { at: Date.now(), value });
  if (cache.size > 64) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) cache.delete(oldest[0]);
  }

  return { ...value, hasToken };
}
