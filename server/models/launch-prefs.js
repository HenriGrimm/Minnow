import { getModelsConfig, patchModelsConfig } from './models-config.js';
import { normalizeExtraArgs } from '../../src/models/argv-tokenize.mjs';
import { KV_TYPE_BYTES } from '../../src/models/memory-model.mjs';
import { SPEC_TYPES } from '../../src/models/spec-decode.mjs';

const LAUNCH_SETTING_KEYS = [
  'fit_mode',
  'ctx',
  'n_gpu_layers',
  'cache_type',
  'parallel',
  'batch_size',
  'ubatch_size',
  'n_cpu_moe',
  'threads',
  'kv_unified',
  'kv_offload',
  'ctx_checkpoints',
  'context_shift',
  'swa_full',
  'rope_freq_base',
  'rope_freq_scale',
  'seed',
  'flash_attn',
  'cache_type_k',
  'cache_type_v',
  'reasoning_budget_message',
  'idle_ttl_ms',
  'spec_type',
  'spec_draft_model',
  'spec_draft_ngl',
  'spec_draft_n_max',
  'spec_draft_n_min',
  'spec_draft_p_min',
  'extra_args',
  'env',
  'no_mmap',
  'no_mmproj',
  'mlock',
  'chat_template',
  'chat_template_file',
  'device',
  'split_mode',
  'tensor_split',
  'main_gpu',
];

const PROGRESS_KEYS = ['lastLoadMs', 'lastWeightsBytes'];

/**
 * @typedef {object} LibraryLaunchSettings
 * @property {'auto' | 'manual'} [fit_mode]
 * @property {number} [ctx]
 * @property {number} [n_gpu_layers]
 * @property {string} [cache_type]
 * @property {number} [parallel]
 * @property {number} [batch_size]
 * @property {number} [ubatch_size]
 * @property {number} [n_cpu_moe]
 * @property {number} [threads]
 * @property {boolean} [kv_unified]
 * @property {boolean} [kv_offload]
 * @property {number} [ctx_checkpoints]
 * @property {boolean} [context_shift]
 * @property {boolean} [swa_full]
 * @property {number} [rope_freq_base]
 * @property {number} [rope_freq_scale]
 * @property {number} [seed]
 * @property {'on' | 'off' | 'auto'} [flash_attn]
 * @property {string} [cache_type_k]
 * @property {string} [cache_type_v]
 * @property {string} [reasoning_budget_message]
 * @property {number} [idle_ttl_ms]
 * @property {string} [spec_type]
 * @property {string} [spec_draft_model]
 * @property {number} [spec_draft_ngl]
 * @property {number} [spec_draft_n_max]
 * @property {number} [spec_draft_n_min]
 * @property {number} [spec_draft_p_min]
 * @property {string[]} [extra_args]
 * @property {Record<string, string>} [env]
 * @property {boolean} [no_mmap]
 * @property {boolean} [no_mmproj]
 * @property {boolean} [mlock]
 * @property {string} [chat_template]
 * @property {string} [chat_template_file]
 * @property {string} [device]
 * @property {string} [split_mode]
 * @property {string} [tensor_split]
 * @property {number} [main_gpu]
 * @property {number} [lastLoadMs]
 * @property {number} [lastWeightsBytes]
 */

/**
 * @typedef {object} ModelsLaunchBlock
 * @property {Record<string, LibraryLaunchSettings>} byLibraryId
 */

/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
function finiteInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  return Math.trunc(n);
}

/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
function nonNegativeInt(value) {
  const n = finiteInt(value);
  if (n == null || n < 0) return undefined;
  return n;
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function kvCacheType(value) {
  if (typeof value !== 'string') return undefined;
  const key = value.trim().toLowerCase();
  return Object.hasOwn(KV_TYPE_BYTES, key) ? key : undefined;
}

/**
 * @param {LibraryLaunchSettings | null | undefined} row
 * @returns {LibraryLaunchSettings | undefined}
 */
export function llamaSettingsFromLaunchRow(row) {
  if (!row || typeof row !== 'object') return undefined;
  const llama = normalizeLaunchSettings(row, { includeProgress: false });
  return Object.keys(llama).length > 0 ? llama : undefined;
}

/**
 * @param {unknown} raw
 * @param {{ includeProgress?: boolean }} [opts]
 * @returns {LibraryLaunchSettings}
 */
export function normalizeLaunchSettings(raw, opts = {}) {
  const includeProgress = opts.includeProgress !== false;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const src = /** @type {Record<string, unknown>} */ (raw);
  /** @type {LibraryLaunchSettings} */
  const out = {};

  if (src.fit_mode === 'auto' || src.fit_mode === 'manual') {
    out.fit_mode = src.fit_mode;
  }

  const ctx = finiteInt(src.ctx);
  if (ctx != null && ctx > 0) out.ctx = ctx;

  const ngl = finiteInt(src.n_gpu_layers);
  if (ngl != null && ngl >= 0) out.n_gpu_layers = ngl;

  if (typeof src.cache_type === 'string' && src.cache_type.trim()) {
    out.cache_type = src.cache_type.trim();
  }

  const parallel = finiteInt(src.parallel);
  if (parallel != null && parallel >= 1) out.parallel = parallel;

  const batch = finiteInt(src.batch_size);
  if (batch != null && batch > 0) out.batch_size = batch;

  const ubatch = finiteInt(src.ubatch_size);
  if (ubatch != null && ubatch > 0) out.ubatch_size = ubatch;

  const nCpuMoe = nonNegativeInt(src.n_cpu_moe);
  if (nCpuMoe != null) out.n_cpu_moe = nCpuMoe;

  const threads = finiteInt(src.threads);
  if (threads != null && threads > 0) out.threads = threads;

  const ctxCheckpoints = nonNegativeInt(src.ctx_checkpoints);
  if (ctxCheckpoints != null) out.ctx_checkpoints = ctxCheckpoints;

  const seed = finiteInt(src.seed);
  if (seed != null && seed >= -1) out.seed = seed;

  const ropeBase = Number(src.rope_freq_base);
  if (Number.isFinite(ropeBase) && ropeBase > 0) out.rope_freq_base = ropeBase;

  const ropeScale = Number(src.rope_freq_scale);
  if (Number.isFinite(ropeScale) && ropeScale > 0) out.rope_freq_scale = ropeScale;

  const idleTtl = nonNegativeInt(src.idle_ttl_ms);
  if (idleTtl != null) out.idle_ttl_ms = idleTtl;

  if (typeof src.kv_unified === 'boolean') out.kv_unified = src.kv_unified;
  if (typeof src.kv_offload === 'boolean') out.kv_offload = src.kv_offload;
  if (typeof src.context_shift === 'boolean') out.context_shift = src.context_shift;
  if (typeof src.swa_full === 'boolean') out.swa_full = src.swa_full;

  if (src.flash_attn === 'on' || src.flash_attn === 'off' || src.flash_attn === 'auto') {
    out.flash_attn = src.flash_attn;
  }

  const cacheTypeK = kvCacheType(src.cache_type_k);
  if (cacheTypeK) out.cache_type_k = cacheTypeK;
  const cacheTypeV = kvCacheType(src.cache_type_v);
  if (cacheTypeV) out.cache_type_v = cacheTypeV;

  if (
    typeof src.reasoning_budget_message === 'string' &&
    src.reasoning_budget_message.trim()
  ) {
    out.reasoning_budget_message = src.reasoning_budget_message.trim();
  }

  if (typeof src.spec_type === 'string' && SPEC_TYPES.has(src.spec_type.trim())) {
    out.spec_type = src.spec_type.trim();
  }
  if (typeof src.spec_draft_model === 'string' && src.spec_draft_model.trim()) {
    out.spec_draft_model = src.spec_draft_model.trim();
  }
  const specNgl = nonNegativeInt(src.spec_draft_ngl);
  if (specNgl != null) out.spec_draft_ngl = specNgl;
  const specNMax = finiteInt(src.spec_draft_n_max);
  if (specNMax != null && specNMax > 0) out.spec_draft_n_max = specNMax;
  const specNMin = nonNegativeInt(src.spec_draft_n_min);
  if (specNMin != null) out.spec_draft_n_min = specNMin;
  const specPMin = Number(src.spec_draft_p_min);
  if (Number.isFinite(specPMin) && specPMin >= 0 && specPMin <= 1) {
    out.spec_draft_p_min = specPMin;
  }

  if (typeof src.no_mmap === 'boolean') out.no_mmap = src.no_mmap;
  if (typeof src.no_mmproj === 'boolean') out.no_mmproj = src.no_mmproj;
  if (typeof src.mlock === 'boolean') out.mlock = src.mlock;

  if (typeof src.chat_template === 'string' && src.chat_template.trim()) {
    out.chat_template = src.chat_template.trim();
  }
  if (typeof src.chat_template_file === 'string' && src.chat_template_file.trim()) {
    out.chat_template_file = src.chat_template_file.trim();
  }

  if (typeof src.device === 'string' && src.device.trim()) {
    const device = src.device
      .split(',')
      .map((token) => token.trim())
      .filter(Boolean)
      .join(',');
    if (device) out.device = device;
  }
  if (src.split_mode === 'none' || src.split_mode === 'layer' || src.split_mode === 'tensor') {
    out.split_mode = src.split_mode;
  }
  if (typeof src.tensor_split === 'string' && src.tensor_split.trim()) {
    out.tensor_split = src.tensor_split.trim();
  }
  const mainGpu = finiteInt(src.main_gpu);
  if (mainGpu != null && mainGpu >= 0) out.main_gpu = mainGpu;

  const extra = normalizeExtraArgs(src.extra_args);
  if (extra.length) out.extra_args = extra;

  if (src.env && typeof src.env === 'object' && !Array.isArray(src.env)) {
    /** @type {Record<string, string>} */
    const env = {};
    for (const [key, value] of Object.entries(/** @type {Record<string, unknown>} */ (src.env))) {
      if (typeof key !== 'string' || !key.trim()) continue;
      if (typeof value !== 'string') continue;
      env[key] = value;
    }
    if (Object.keys(env).length) out.env = env;
  }

  if (includeProgress) {
    const lastLoadMs = nonNegativeInt(src.lastLoadMs);
    if (lastLoadMs != null) out.lastLoadMs = lastLoadMs;
    const lastWeightsBytes = nonNegativeInt(src.lastWeightsBytes);
    if (lastWeightsBytes != null) out.lastWeightsBytes = lastWeightsBytes;
  }

  return out;
}

/**
 * @param {...(Record<string, unknown> | null | undefined)} layers
 * @returns {LibraryLaunchSettings}
 */
export function mergeLaunchSettings(...layers) {
  /** @type {LibraryLaunchSettings} */
  const out = {};
  for (const layer of layers) {
    if (!layer || typeof layer !== 'object') continue;
    for (const [key, value] of Object.entries(layer)) {
      if (PROGRESS_KEYS.includes(key)) continue;
      if (value !== undefined && value !== null) {
        out[/** @type {keyof LibraryLaunchSettings} */ (key)] = value;
      }
    }
  }
  return out;
}

/**
 * @param {unknown} raw
 * @returns {ModelsLaunchBlock}
 */
export function normalizeLaunchBlock(raw) {
  const block = raw && typeof raw === 'object' ? /** @type {Record<string, unknown>} */ (raw) : {};
  const byLibraryId =
    block.byLibraryId && typeof block.byLibraryId === 'object'
      ? /** @type {Record<string, unknown>} */ (block.byLibraryId)
      : {};

  /** @type {Record<string, LibraryLaunchSettings>} */
  const cleanedById = {};
  for (const [libraryId, settings] of Object.entries(byLibraryId)) {
    if (typeof libraryId !== 'string' || !libraryId.trim()) continue;
    const normalized = normalizeLaunchSettings(settings, { includeProgress: true });
    if (Object.keys(normalized).length > 0) {
      cleanedById[libraryId] = normalized;
    }
  }

  return { byLibraryId: cleanedById };
}

/**
 * @returns {Promise<ModelsLaunchBlock>}
 */
export async function getLaunchPrefs() {
  const models = await getModelsConfig();
  return normalizeLaunchBlock(models.launch);
}

/**
 * @param {string} libraryId
 * @param {LibraryLaunchSettings | null} settings
 * @returns {Promise<ModelsLaunchBlock>}
 */
export async function setLibraryLaunchSettings(libraryId, settings) {
  const id = typeof libraryId === 'string' ? libraryId.trim() : '';
  if (!id) {
    throw new Error('libraryId is required');
  }

  const models = await getModelsConfig();
  const launch = normalizeLaunchBlock(models.launch);
  const existing = launch.byLibraryId[id];

  if (settings === null) {
    delete launch.byLibraryId[id];
    await patchModelsConfig({ launch });
    return launch;
  }

  const normalized = normalizeLaunchSettings(settings, { includeProgress: true });
  if (Object.keys(normalized).length === 0) {
    delete launch.byLibraryId[id];
    await patchModelsConfig({ launch });
    return launch;
  }

  /** @type {LibraryLaunchSettings} */
  const next = { ...normalized };
  if (existing) {
    if (next.lastLoadMs == null && existing.lastLoadMs != null) next.lastLoadMs = existing.lastLoadMs;
    if (next.lastWeightsBytes == null && existing.lastWeightsBytes != null) {
      next.lastWeightsBytes = existing.lastWeightsBytes;
    }
  }

  launch.byLibraryId[id] = next;
  await patchModelsConfig({ launch });
  return launch;
}

/**
 * @param {string} libraryId
 * @param {{ lastLoadMs: number, lastWeightsBytes: number }} prior
 * @returns {Promise<ModelsLaunchBlock>}
 */
export async function recordLaunchLoadPrior(libraryId, prior) {
  const id = typeof libraryId === 'string' ? libraryId.trim() : '';
  if (!id) {
    throw new Error('libraryId is required');
  }

  const models = await getModelsConfig();
  const launch = normalizeLaunchBlock(models.launch);
  const existing = launch.byLibraryId[id] ?? {};
  const lastLoadMs = nonNegativeInt(prior?.lastLoadMs);
  const lastWeightsBytes = nonNegativeInt(prior?.lastWeightsBytes);

  /** @type {LibraryLaunchSettings} */
  const next = { ...existing };
  if (lastLoadMs != null) next.lastLoadMs = lastLoadMs;
  if (lastWeightsBytes != null) next.lastWeightsBytes = lastWeightsBytes;

  if (Object.keys(next).length === 0) {
    return launch;
  }

  launch.byLibraryId[id] = next;
  await patchModelsConfig({ launch });
  return launch;
}

export { LAUNCH_SETTING_KEYS, PROGRESS_KEYS };
