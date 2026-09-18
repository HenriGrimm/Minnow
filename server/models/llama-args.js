import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getMinnowHome } from '../config/home.js';
import { estimateRunMemory, GIB } from '../../src/models/memory-model.mjs';
import { geometryFromGgufMetadata, resolveGeometry } from '../../src/models/model-geometry.mjs';
import { normalizeExtraArgs } from '../../src/models/argv-tokenize.mjs';
import { SPEC_TYPES } from '../../src/models/spec-decode.mjs';
import {
  CONTEXT_LADDER,
  flashAttnForVariant,
  isCpuLlamaVariant,
  launchBudgetBytes,
  planLlamaLaunch,
  PREFERRED_CONTEXT_TOKENS,
} from '../../src/models/launch-plan.mjs';
import {
  joinDeviceList,
  joinTensorSplit,
  parseTensorSplit,
  resolveLaunchDevices,
  selectedGpuVramGb,
  synthesizeLlamaDevices,
} from '../../src/models/llama-devices.mjs';
import { computeServeProfiles } from './profiles.js';

/** @typedef {import('./llama-variant.js').LlamaVariant} LlamaVariant */
/** @typedef {import('../../src/models/launch-plan.d.mts').LlamaLaunchPlan} LlamaLaunchPlan */

const LEGACY_OFFLOAD_ALL = 999;

const FIT_PLANNER_OVERBUDGET_RATIO = 1.25;

// ── Offload ──────────────────────────────────────────────────────────────────

/**
 * @param {number} nGpuLayers
 * @param {Record<string, unknown> | null | undefined} ggufMeta
 * @returns {number}
 */
function fullOffloadNGpuLayers(nGpuLayers, ggufMeta) {
  const nLayers = Number(ggufMeta?.nLayers);
  if (!Number.isFinite(nLayers) || nLayers <= 0) return nGpuLayers;
  return nGpuLayers >= nLayers ? nLayers + 1 : nGpuLayers;
}


// ── Config ───────────────────────────────────────────────────────────────────

/**
 * @typedef {object} LlamaServeSettings
 * @property {number} [ctx]
 * @property {number} [n_gpu_layers]
 * @property {string} [cache_type]
 * @property {number} [n_cpu_moe]
 * @property {number} [batch_size]
 * @property {number} [ubatch_size]
 * @property {number} [parallel]
 * @property {number} [threads]
 * @property {boolean} [kv_unified]
 * @property {boolean} [kv_offload]
 * @property {number} [ctx_checkpoints]
 * @property {string} [reasoning_budget_message]
 * @property {number} [rope_freq_base]
 * @property {number} [rope_freq_scale]
 * @property {number} [seed]
 * @property {'on' | 'off' | 'auto'} [flash_attn]
 * @property {string} [cache_type_k]
 * @property {string} [cache_type_v]
 * @property {boolean} [context_shift]
 * @property {boolean} [swa_full]
 * @property {number} [idle_ttl_ms]
 * @property {string} [spec_type]
 * @property {string} [spec_draft_model]
 * @property {number} [spec_draft_ngl]
 * @property {number} [spec_draft_n_max]
 * @property {number} [spec_draft_n_min]
 * @property {number} [spec_draft_p_min]
 * @property {string} [split_mode]
 * @property {string} [tensor_split]
 * @property {number} [main_gpu]
 * @property {string} [device]
 * @property {boolean} [fit]
 * @property {'auto' | 'manual'} [fit_mode]
 * @property {boolean} [no_warmup]
 * @property {boolean} [skip_jinja]
 * @property {boolean} [no_mmap]
 * @property {boolean} [no_mmproj]
 * @property {boolean} [mlock]
 * @property {string} [chat_template]
 * @property {string} [chat_template_file]
 * @property {string[] | string} [extra_args]
 * @property {Record<string, string>} [env]
 */

/**
 * @typedef {object} LlamaServerLaunch
 * @property {string[]} args
 * @property {LlamaLaunchPlan} plan
 * @property {string | null} warning
 * @property {LlamaServeSettings} settings
 */

export function getLlamaCppConfigPath() {
  return path.join(getMinnowHome(), 'llama-cpp.json');
}

/**
 * @returns {Promise<{ variant?: LlamaVariant, defaults?: LlamaServeSettings }>}
 */
export async function readLlamaCppConfig() {
  try {
    const raw = await fsp.readFile(getLlamaCppConfigPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * @param {Record<string, unknown>} patch
 */
export async function writeLlamaCppConfig(patch) {
  const prev = await readLlamaCppConfig();
  const next = { ...prev, ...patch };
  await fsp.mkdir(path.dirname(getLlamaCppConfigPath()), { recursive: true });
  await fsp.writeFile(getLlamaCppConfigPath(), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

// ── Geometry ─────────────────────────────────────────────────────────────────

/**
 * @param {...LlamaServeSettings | null | undefined} layers
 * @returns {LlamaServeSettings}
 */
function mergeSettings(...layers) {
  /** @type {LlamaServeSettings} */
  const out = {};
  for (const layer of layers) {
    if (!layer || typeof layer !== 'object') continue;
    for (const [key, value] of Object.entries(layer)) {
      if (value !== undefined && value !== null) {
        out[/** @type {keyof LlamaServeSettings} */ (key)] = value;
      }
    }
  }
  return out;
}

/**
 * @param {Record<string, unknown> | null | undefined} hardware
 * @param {string} variant
 */
function fitTargetMib(hardware, variant) {
  const selected = Number(hardware?.selectedGpuVramGb) || 0;
  const gpuVramGb = selected > 0 ? selected : Number(hardware?.gpuVramGb) || 0;
  if (!isCpuLlamaVariant(variant) && gpuVramGb > 0) {
    const reserveGib = Math.max(0.9, gpuVramGb * 0.08);
    return Math.max(1, Math.round(reserveGib * 1024));
  }
  return 1024;
}

/** @param {object} opts */
function resolveWeightsBytes(opts) {
  if (Number(opts.weightsBytes) > 0) return Number(opts.weightsBytes);
  const gb = Number(opts.modelMeta?.serveWeightsGb);
  if (gb > 0) return gb * GIB;
  return 0;
}

/** @param {Record<string, unknown> | null | undefined} ggufMeta */
function resolveTrainCtx(ggufMeta) {
  const n = Number(ggufMeta?.trainCtx);
  return n > 0 ? Math.trunc(n) : undefined;
}

/** @param {number} bytes */
function gbLabel(bytes) {
  return Math.round((bytes / GIB) * 10) / 10;
}

/**
 * @param {Record<string, unknown>} modelMeta
 * @param {Record<string, unknown> | null | undefined} ggufMeta
 */
function resolveLaunchGeometry(modelMeta, ggufMeta) {
  const exact = ggufMeta ? geometryFromGgufMetadata(ggufMeta) : null;
  if (exact) return exact;
  return resolveGeometry({
    architecture: modelMeta.architecture ?? modelMeta.arch,
    name: modelMeta.name,
    paramsB: modelMeta.parameters_raw ?? modelMeta.params_b ?? modelMeta.paramsB,
    activeParamsB: modelMeta.active_parameters,
  });
}

/**
 * @param {LlamaServeSettings} merged
 * @returns {LlamaServeSettings}
 */
function effectiveLlamaSettings(merged) {
  /** @type {LlamaServeSettings} */
  const out = {
    fit_mode: merged.fit_mode === 'manual' ? 'manual' : 'auto',
  };
  if (merged.ctx != null) out.ctx = merged.ctx;
  if (merged.cache_type) out.cache_type = merged.cache_type;
  if (merged.parallel != null) out.parallel = merged.parallel;
  if (merged.fit != null) out.fit = merged.fit;
  if (merged.n_gpu_layers != null && merged.n_gpu_layers !== LEGACY_OFFLOAD_ALL) {
    out.n_gpu_layers = merged.n_gpu_layers;
  }
  if (merged.no_mmap === true) out.no_mmap = true;
  if (merged.no_mmproj === true) out.no_mmproj = true;
  if (merged.mlock === true) out.mlock = true;
  if (merged.batch_size != null) out.batch_size = merged.batch_size;
  if (merged.ubatch_size != null) out.ubatch_size = merged.ubatch_size;
  if (merged.n_cpu_moe != null) out.n_cpu_moe = merged.n_cpu_moe;
  if (merged.threads != null) out.threads = merged.threads;
  if (typeof merged.kv_unified === 'boolean') out.kv_unified = merged.kv_unified;
  if (merged.kv_offload === false) out.kv_offload = false;
  if (merged.ctx_checkpoints != null) out.ctx_checkpoints = merged.ctx_checkpoints;
  if (merged.context_shift != null) out.context_shift = merged.context_shift;
  if (merged.swa_full === true) out.swa_full = true;
  if (merged.rope_freq_base != null) out.rope_freq_base = merged.rope_freq_base;
  if (merged.rope_freq_scale != null) out.rope_freq_scale = merged.rope_freq_scale;
  if (merged.seed != null) out.seed = merged.seed;
  if (merged.flash_attn) out.flash_attn = merged.flash_attn;
  if (merged.cache_type_k) out.cache_type_k = merged.cache_type_k;
  if (merged.cache_type_v) out.cache_type_v = merged.cache_type_v;
  if (merged.idle_ttl_ms != null) out.idle_ttl_ms = merged.idle_ttl_ms;
  if (SPEC_TYPES.has(String(merged.spec_type)) && merged.spec_type !== 'none') {
    out.spec_type = merged.spec_type;
    if (merged.spec_draft_model) out.spec_draft_model = merged.spec_draft_model;
    if (merged.spec_draft_ngl != null) out.spec_draft_ngl = merged.spec_draft_ngl;
    if (merged.spec_draft_n_max != null) out.spec_draft_n_max = merged.spec_draft_n_max;
    if (merged.spec_draft_n_min != null) out.spec_draft_n_min = merged.spec_draft_n_min;
    if (merged.spec_draft_p_min != null) out.spec_draft_p_min = merged.spec_draft_p_min;
  }
  if (typeof merged.reasoning_budget_message === 'string' && merged.reasoning_budget_message.trim()) {
    out.reasoning_budget_message = merged.reasoning_budget_message.trim();
  }
  if (typeof merged.chat_template === 'string' && merged.chat_template.trim()) {
    out.chat_template = merged.chat_template.trim();
  }
  if (typeof merged.chat_template_file === 'string' && merged.chat_template_file.trim()) {
    out.chat_template_file = merged.chat_template_file.trim();
  }
  if (typeof merged.device === 'string' && merged.device.trim()) {
    out.device = merged.device.trim();
  }
  if (merged.split_mode === 'none' || merged.split_mode === 'layer' || merged.split_mode === 'tensor') {
    out.split_mode = merged.split_mode;
  }
  if (typeof merged.tensor_split === 'string' && merged.tensor_split.trim()) {
    out.tensor_split = merged.tensor_split.trim();
  }
  if (merged.main_gpu != null) out.main_gpu = merged.main_gpu;
  return out;
}

/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
function finiteInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
function positiveInt(value) {
  const n = finiteInt(value);
  return n != null && n > 0 ? n : undefined;
}

/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
function positiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * @param {unknown} manual
 * @param {unknown} planned
 * @returns {string}
 */
function resolveCacheType(manual, planned) {
  if (typeof manual === 'string' && manual.trim()) return manual.trim();
  if (typeof planned === 'string' && planned.trim()) return planned.trim();
  return 'f16';
}

/**
 * Mixed `--cache-type-k` / `--cache-type-v` fragments the CUDA flash-attn graph
 * (f16 K + q8_0 V dropped Qwen3.8 prefill from ~2000 tok/s to ~120). Keep them
 * identical. `--fit` will also quantize only V when the flags are omitted, so
 * callers always emit both even for f16.
 *
 * Forks with `asymmetricKv` (turbo3 documents `-ctk q8_0 -ctv turbo3` as the safe
 * config for small models) keep the pair as set.
 *
 * @param {LlamaServeSettings} merged
 * @param {{ asymmetricKv?: boolean }} [engine]
 * @returns {{ type: string, typeK: string, typeV: string, coerced: boolean, fromK: string, fromV: string }}
 */
export function pairKvCacheTypes(merged, engine = {}) {
  const shared = resolveCacheType(undefined, merged.cache_type);
  const kSet = typeof merged.cache_type_k === 'string' && Boolean(merged.cache_type_k.trim());
  const vSet = typeof merged.cache_type_v === 'string' && Boolean(merged.cache_type_v.trim());
  const fromK = kSet ? String(merged.cache_type_k).trim() : shared;
  const fromV = vSet ? String(merged.cache_type_v).trim() : shared;
  if (fromK === fromV) return { type: fromK, typeK: fromK, typeV: fromV, coerced: false, fromK, fromV };
  if (engine.asymmetricKv) return { type: fromV, typeK: fromK, typeV: fromV, coerced: false, fromK, fromV };
  // One-sided inspector override (Match KV + q8_0 V) is the usual crawl. Prefer
  // the explicit side; if both are explicit, prefer V (quantize-V is the ask).
  const type = vSet && !kSet ? fromV : kSet && !vSet ? fromK : fromV;
  return { type, typeK: type, typeV: type, coerced: true, fromK, fromV };
}

/**
 * @param {string | null} existing
 * @param {string | null | undefined} next
 * @returns {string | null}
 */
function joinWarning(existing, next) {
  if (!next) return existing;
  if (!existing) return next;
  return `${existing} ${next}`;
}

/**
 * @returns {number}
 */
function cpuThreadCount() {
  const n = os.availableParallelism?.() ?? os.cpus()?.length ?? 0;
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

/**
 * @param {object} opts
 * @param {string} variant
 * @param {number} parallel
 * @returns {LlamaLaunchPlan}
 */
function planOrPreferredFallback(opts, variant, parallel) {
  const hardware = opts.hardware && typeof opts.hardware === 'object' ? opts.hardware : {};
  const geometry = resolveLaunchGeometry(opts.modelMeta ?? {}, opts.ggufMeta ?? null);
  const weightsBytes = resolveWeightsBytes(opts);
  const trainCtx = resolveTrainCtx(opts.ggufMeta);
  const budget = launchBudgetBytes(hardware, variant);

  if (!(budget > 0)) {
    return {
      ctx: PREFERRED_CONTEXT_TOKENS,
      ctxPerSlot: PREFERRED_CONTEXT_TOKENS,
      n_gpu_layers: isCpuLlamaVariant(variant) ? 0 : null,
      cache_type: 'f16',
      flash_attn: flashAttnForVariant(variant),
      fits: false,
      estimateGb: 0,
      reason: 'Hardware snapshot missing; using preferred context with --fit on.',
      clampedFrom: null,
    };
  }

  return planLlamaLaunch({
    geometry,
    weightsBytes,
    trainCtx,
    hardware,
    variant,
    parallel,
  });
}

/**
 * @param {LlamaServeSettings} merged
 * @param {LlamaLaunchPlan} plan
 */
function applyAutoPlan(merged, plan) {
  merged.ctx = plan.ctx;
  if (plan.n_gpu_layers == null) {
    delete merged.n_gpu_layers;
  } else {
    merged.n_gpu_layers = plan.n_gpu_layers;
  }
  merged.cache_type = plan.cache_type;
  merged.fit = plan.n_gpu_layers == null;
  merged.fit_mode = 'auto';
}

/**
 * @param {LlamaServeSettings} merged
 */
function applyManualFit(merged) {
  merged.fit_mode = 'manual';
  if (merged.n_gpu_layers != null) {
    merged.fit = false;
  } else {
    merged.fit = true;
  }
}

/**
 * @param {object} opts
 * @param {string} variant
 * @param {LlamaServeSettings} merged
 * @param {LlamaLaunchPlan} plan
 * @returns {string | null}
 */
function manualOverBudgetWarning(opts, variant, merged, plan) {
  const hardware = opts.hardware && typeof opts.hardware === 'object' ? opts.hardware : {};
  const budgetBytes = launchBudgetBytes(hardware, variant);
  if (!(budgetBytes > 0)) return null;

  const geometry = resolveLaunchGeometry(opts.modelMeta ?? {}, opts.ggufMeta ?? null);
  const weightsBytes = resolveWeightsBytes(opts);
  const kv = pairKvCacheTypes({
    ...merged,
    cache_type: merged.cache_type || plan.cache_type,
  });
  const estimate = estimateRunMemory({
    geometry,
    weightsBytes,
    ctx: Number(merged.ctx) > 0 ? Number(merged.ctx) : plan.ctx,
    cacheType: { k: kv.type, v: kv.type },
    swaFull: merged.swa_full === true,
    draftWeightsBytes: Number(opts.draftWeightsBytes) || 0,
    nGpuLayers: merged.n_gpu_layers == null ? undefined : merged.n_gpu_layers,
    backend: typeof hardware.backend === 'string' ? hardware.backend : undefined,
  });

  if (estimate.totalBytes <= budgetBytes * FIT_PLANNER_OVERBUDGET_RATIO) return null;

  return `warning: you overrode the fit planner; estimate ~${estimate.totalGb} GB vs ~${gbLabel(budgetBytes)} GB budget`;
}

// ── Launch ───────────────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {string} opts.modelPath
 * @param {number} opts.port
 * @param {string} [opts.profileKey]
 * @param {Record<string, unknown>} [opts.hardware]
 * @param {Record<string, unknown>} [opts.modelMeta]
 * @param {LlamaServeSettings} [opts.settings]
 * @param {LlamaServeSettings} [opts.defaults]
 * @param {LlamaVariant} [opts.variant]
 * @param {string} [opts.mmprojPath]
 * @param {Record<string, unknown> | null} [opts.ggufMeta]
 * @param {number} [opts.weightsBytes]
 * @param {number} [opts.draftWeightsBytes]
 * @param {string} [opts.libraryId]
 * @param {Array<{ id: string, name?: string, memoryMiB?: number }>} [opts.llamaDevices]
 * @param {boolean} [opts.asymmetricKv] Active engine runs mixed K/V types natively.
 * @returns {LlamaServerLaunch}
 */
export function buildLlamaServerLaunch(opts) {
  const {
    modelPath,
    port,
    profileKey = 'balanced',
    hardware,
    modelMeta = {},
    settings,
    defaults,
    variant = 'cpu',
    mmprojPath,
    ggufMeta,
    libraryId,
    llamaDevices,
    asymmetricKv = false,
  } = opts;

  /** @type {LlamaServeSettings} */
  let profileSettings = {};

  if (hardware && typeof hardware === 'object') {
    const profiles = computeServeProfiles(hardware, modelMeta, {
      serveWeightsGb: modelMeta.serveWeightsGb,
      serveQuant: modelMeta.serveQuant,
      ggufMeta: ggufMeta ?? null,
    });
    const profile = profiles.find((p) => p.key === profileKey) || profiles[1] || profiles[0];
    if (profile) {
      profileSettings = {
        ctx: profile.ctx,
        n_gpu_layers: profile.n_gpu_layers,
        cache_type: profile.cache_type,
        n_cpu_moe: profile.n_cpu_moe,
      };
    }
  }

  const merged = mergeSettings(profileSettings, defaults, settings);
  const extraArgs = normalizeExtraArgs(merged.extra_args);
  const extraHasFlag = (flag) =>
    extraArgs.some((token) => token === flag || token.startsWith(`${flag}=`));
  const extraHasDevice = extraHasFlag('--device') || extraHasFlag('-dev');
  const inventory =
    Array.isArray(llamaDevices) && llamaDevices.length
      ? llamaDevices
      : synthesizeLlamaDevices(hardware, variant);
  const resolvedDevices = resolveLaunchDevices({
    requestedDevice: merged.device,
    inventory,
    extraHasDevice,
  });
  const launchHardware =
    hardware && typeof hardware === 'object' ? { ...hardware } : {};
  if (resolvedDevices.emit && resolvedDevices.ids.length) {
    merged.device = joinDeviceList(resolvedDevices.ids);
    const selectedVram = selectedGpuVramGb(inventory, resolvedDevices.ids);
    if (selectedVram > 0) launchHardware.selectedGpuVramGb = selectedVram;
  }

  const fitMode = merged.fit_mode === 'manual' ? 'manual' : 'auto';
  const parallel = Math.max(1, Math.trunc(Number(merged.parallel) || 1));
  const planOpts = { ...opts, hardware: launchHardware };
  const plan = planOrPreferredFallback(planOpts, variant, parallel);

  let warning = null;
  if (fitMode === 'manual') {
    const userSetNgl = settings?.n_gpu_layers != null || defaults?.n_gpu_layers != null;
    if (!userSetNgl && merged.n_gpu_layers === LEGACY_OFFLOAD_ALL) {
      delete merged.n_gpu_layers;
    }
    applyManualFit(merged);
    warning = manualOverBudgetWarning(planOpts, variant, merged, plan);
  } else {
    applyAutoPlan(merged, plan);
  }
  if (merged.split_mode === 'tensor') {
    merged.fit = false;
  }

  const skipJinja = merged.skip_jinja === true || extraHasFlag('--no-jinja');
  const forwardedExtra = extraArgs.filter((token) => {
    if (token === '--no-jinja') return false;
    if (skipJinja && token === '--jinja') return false;
    return true;
  });

  const args = [
    '-m',
    modelPath,
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
  ];

  const aliasId = typeof libraryId === 'string' ? libraryId.trim() : '';
  if (aliasId && !extraHasFlag('--alias')) {
    args.push('--alias', aliasId);
  }

  if (!skipJinja && !extraHasFlag('--jinja')) {
    args.push('--jinja');
  }

  // Vision off: the sibling projector is never attached (`--no-mmproj` in extra_args counts too).
  const skipMmproj = merged.no_mmproj === true || extraHasFlag('--no-mmproj');
  if (mmprojPath && !skipMmproj && !extraHasFlag('--mmproj')) {
    args.push('--mmproj', mmprojPath);
  }

  if (merged.ctx != null) {
    args.push('-c', String(merged.ctx));
  }

  if (merged.n_gpu_layers != null) {
    args.push('-ngl', String(fullOffloadNGpuLayers(merged.n_gpu_layers, ggufMeta)));
  }

  const kvPair = pairKvCacheTypes(merged, { asymmetricKv });
  const cacheTypeK = kvPair.typeK;
  const cacheTypeV = kvPair.typeV;
  merged.cache_type = kvPair.type;
  merged.cache_type_k = cacheTypeK;
  merged.cache_type_v = cacheTypeV;
  if (kvPair.coerced) {
    warning = joinWarning(
      warning,
      `warning: K cache ${kvPair.fromK} and V cache ${kvPair.fromV} differ; mixed types collapse prompt processing onto the CPU. Using ${kvPair.type} for both.`,
    );
  }
  // Always emit both, including f16: omitting them lets `--fit` quantize only V.
  if (!extraHasFlag('--cache-type-k')) {
    args.push('--cache-type-k', cacheTypeK);
  }
  if (!extraHasFlag('--cache-type-v')) {
    args.push('--cache-type-v', cacheTypeV);
  }

  if (merged.n_cpu_moe != null && merged.n_cpu_moe > 0) {
    args.push('--n-cpu-moe', String(merged.n_cpu_moe));
  }

  if (merged.batch_size != null) {
    args.push('-b', String(merged.batch_size));
  }

  if (merged.ubatch_size != null) {
    args.push('-ub', String(merged.ubatch_size));
  }

  if (!extraHasFlag('--parallel')) {
    args.push('--parallel', String(parallel));
  }

  if (resolvedDevices.emit && !extraHasDevice) {
    args.push('--device', joinDeviceList(resolvedDevices.ids));
  }

  const selectedCount = resolvedDevices.emit ? resolvedDevices.ids.length : 0;
  const splitMode =
    merged.split_mode === 'none' || merged.split_mode === 'layer' || merged.split_mode === 'tensor'
      ? merged.split_mode
      : selectedCount >= 2
        ? 'layer'
        : '';
  if (splitMode && selectedCount >= 2 && !extraHasFlag('--split-mode') && !extraHasFlag('-sm')) {
    args.push('--split-mode', splitMode);
    merged.split_mode = splitMode;
  }

  const tensorParts = parseTensorSplit(merged.tensor_split);
  if (
    tensorParts.length &&
    selectedCount >= 2 &&
    tensorParts.length === selectedCount &&
    !extraHasFlag('--tensor-split') &&
    !extraHasFlag('-ts')
  ) {
    args.push('--tensor-split', joinTensorSplit(tensorParts));
    merged.tensor_split = joinTensorSplit(tensorParts);
  } else if (tensorParts.length && selectedCount >= 2 && tensorParts.length !== selectedCount) {
    warning = joinWarning(
      warning,
      `warning: --tensor-split has ${tensorParts.length} parts but ${selectedCount} devices; omitting the flag.`,
    );
    delete merged.tensor_split;
  }

  if (merged.main_gpu != null && !extraHasFlag('--main-gpu') && !extraHasFlag('-mg')) {
    args.push('--main-gpu', String(merged.main_gpu));
  }

  if (typeof merged.kv_unified === 'boolean' && !extraHasFlag('--kv-unified') && !extraHasFlag('--no-kv-unified')) {
    args.push(merged.kv_unified ? '--kv-unified' : '--no-kv-unified');
  }

  if (merged.kv_offload === false && !extraHasFlag('--no-kv-offload')) {
    args.push('--no-kv-offload');
  }

  const ctxCheckpoints = positiveInt(merged.ctx_checkpoints);
  if (ctxCheckpoints != null && !extraHasFlag('-ctxcp') && !extraHasFlag('--ctx-checkpoints')) {
    args.push('-ctxcp', String(ctxCheckpoints));
  }

  if (merged.context_shift != null && !extraHasFlag('--context-shift') && !extraHasFlag('--no-context-shift')) {
    args.push(merged.context_shift ? '--context-shift' : '--no-context-shift');
  }

  if (merged.swa_full === true && !extraHasFlag('--swa-full')) {
    args.push('--swa-full');
  }

  const ropeFreqBase = positiveNumber(merged.rope_freq_base);
  if (ropeFreqBase != null && !extraHasFlag('--rope-freq-base')) {
    args.push('--rope-freq-base', String(ropeFreqBase));
  }

  const ropeFreqScale = positiveNumber(merged.rope_freq_scale);
  if (ropeFreqScale != null && !extraHasFlag('--rope-freq-scale')) {
    args.push('--rope-freq-scale', String(ropeFreqScale));
  }

  const seed = finiteInt(merged.seed);
  if (seed != null && !extraHasFlag('-s') && !extraHasFlag('--seed')) {
    args.push('-s', String(seed));
  }

  const reasoningBudgetMessage =
    typeof merged.reasoning_budget_message === 'string'
      ? merged.reasoning_budget_message.trim()
      : '';
  if (reasoningBudgetMessage && !extraHasFlag('--reasoning-budget-message')) {
    args.push('--reasoning-budget-message', reasoningBudgetMessage);
  }

  const specType = SPEC_TYPES.has(String(merged.spec_type)) ? String(merged.spec_type) : '';
  if (specType && specType !== 'none' && !extraHasFlag('--spec-type')) {
    args.push('--spec-type', specType);

    const draftModel =
      typeof merged.spec_draft_model === 'string' ? merged.spec_draft_model.trim() : '';
    if (draftModel && !extraHasFlag('--spec-draft-model') && !extraHasFlag('-md')) {
      args.push('--spec-draft-model', draftModel);
    }
    const draftNgl = finiteInt(merged.spec_draft_ngl);
    if (draftNgl != null && draftNgl >= 0 && !extraHasFlag('--spec-draft-ngl')) {
      args.push('--spec-draft-ngl', String(draftNgl));
    }
    const draftNMax = finiteInt(merged.spec_draft_n_max);
    if (draftNMax != null && draftNMax > 0 && !extraHasFlag('--spec-draft-n-max')) {
      args.push('--spec-draft-n-max', String(draftNMax));
    }
    const draftNMin = finiteInt(merged.spec_draft_n_min);
    if (draftNMin != null && draftNMin >= 0 && !extraHasFlag('--spec-draft-n-min')) {
      args.push('--spec-draft-n-min', String(draftNMin));
    }
    const draftPMin = Number(merged.spec_draft_p_min);
    if (Number.isFinite(draftPMin) && draftPMin >= 0 && !extraHasFlag('--spec-draft-p-min')) {
      args.push('--spec-draft-p-min', String(draftPMin));
    }
  }

  if (merged.fit === true) {
    args.push('--fit', 'on');
    if (!extraHasFlag('--fit-ctx')) {
      args.push('--fit-ctx', String(CONTEXT_LADDER[0]));
    }
    if (!extraHasFlag('--fit-target')) {
      args.push('--fit-target', String(fitTargetMib(launchHardware, variant)));
    }
  } else if (merged.fit === false) {
    args.push('--fit', 'off');
  }

  const flashAttn =
    merged.flash_attn === 'on' || merged.flash_attn === 'off' || merged.flash_attn === 'auto'
      ? merged.flash_attn
      : plan.flash_attn;
  if (!extraHasFlag('--flash-attn') && !extraHasFlag('-fa')) {
    args.push('--flash-attn', flashAttn);
  }

  if (merged.no_warmup === true) {
    args.push('--no-warmup');
  }

  if (!extraHasFlag('--slots') && !extraHasFlag('--no-slots')) {
    args.push('--slots');
  }

  if (!extraHasFlag('-lv') && !extraHasFlag('--verbosity') && !extraHasFlag('--log-verbosity') && !extraHasFlag('-v') && !extraHasFlag('--verbose')) {
    args.push('-lv', '4');
  }

  if (!extraHasFlag('--cont-batching') && !extraHasFlag('--no-cont-batching')) {
    args.push('--cont-batching');
  }

  if (!extraHasFlag('--cache-reuse')) {
    args.push('--cache-reuse', '256');
  }

  const nLayers = Number(ggufMeta?.nLayers);
  const ngl = merged.n_gpu_layers;
  const threadsKnownPartialOffload =
    ngl != null && Number.isFinite(nLayers) && nLayers > 0 && ngl < nLayers;
  const manualThreads = positiveInt(merged.threads);
  if (!extraHasFlag('-t') && !extraHasFlag('--threads')) {
    const threads = manualThreads ?? (threadsKnownPartialOffload ? cpuThreadCount() : 0);
    if (threads > 0) args.push('-t', String(threads));
  }

  if (merged.no_mmap === true && !extraHasFlag('--no-mmap')) {
    args.push('--no-mmap');
  }
  if (merged.mlock === true && !extraHasFlag('--mlock')) {
    args.push('--mlock');
  }

  const chatTemplate =
    typeof merged.chat_template === 'string' ? merged.chat_template.trim() : '';
  if (chatTemplate && !extraHasFlag('--chat-template')) {
    args.push('--chat-template', chatTemplate);
  }
  const chatTemplateFile =
    typeof merged.chat_template_file === 'string' ? merged.chat_template_file.trim() : '';
  if (chatTemplateFile && !extraHasFlag('--chat-template-file')) {
    args.push('--chat-template-file', chatTemplateFile);
  }


  for (const token of forwardedExtra) {
    if (typeof token === 'string' && token.trim()) {
      args.push(token.trim());
    }
  }

  plan.cache_type_k = cacheTypeK;
  plan.cache_type_v = cacheTypeV;
  if (merged.swa_full === true) plan.swa_full = true;
  if (specType && specType !== 'none') {
    plan.spec_type = specType;
    if (merged.spec_draft_model) plan.spec_draft_model = merged.spec_draft_model;
  }

  return {
    args,
    plan,
    warning,
    settings: effectiveLlamaSettings(merged),
  };
}

/**
 * @param {object} opts
 * @param {string} opts.modelPath
 * @param {number} opts.port
 * @param {string} [opts.profileKey]
 * @param {Record<string, unknown>} [opts.hardware]
 * @param {Record<string, unknown>} [opts.modelMeta]
 * @param {LlamaServeSettings} [opts.settings]
 * @param {LlamaServeSettings} [opts.defaults]
 * @param {LlamaVariant} [opts.variant]
 * @param {string} [opts.mmprojPath]
 * @param {Record<string, unknown> | null} [opts.ggufMeta]
 * @param {number} [opts.weightsBytes]
 * @param {string} [opts.libraryId]
 * @returns {string[]}
 */
export function buildLlamaServerArgs(opts) {
  return buildLlamaServerLaunch(opts).args;
}

/**
 * @param {LlamaServeSettings | null | undefined} settings
 * @param {LlamaServeSettings | null | undefined} defaults
 */
export function warnIfReasoningBudgetCliFlag(settings, defaults) {
  const extras = [
    ...normalizeExtraArgs(defaults?.extra_args),
    ...normalizeExtraArgs(settings?.extra_args),
  ];
  if (extras.some((token) => typeof token === 'string' && /--reasoning-budget\b/.test(token))) {
    console.warn(
      '[llama-cpp] --reasoning-budget in serve extra_args disables per-request thinking_budget_tokens',
    );
  }
}

/**
 * @param {string} modelPath
 * @returns {Promise<string | null>}
 */
export async function findSiblingMmproj(modelPath) {
  if (!modelPath || typeof modelPath !== 'string') return null;
  const dir = path.dirname(modelPath);
  let names;
  try {
    names = await fsp.readdir(dir);
  } catch {
    return null;
  }
  const hits = names.filter((name) => {
    const n = name.toLowerCase();
    return n.endsWith('.gguf') && n.includes('mmproj');
  });
  if (!hits.length) return null;
  const preferred = hits.find((name) => /mmproj-f16\.gguf$/i.test(name));
  return path.join(dir, preferred ?? hits.sort((a, b) => a.localeCompare(b))[0]);
}

// ── Spawn env ────────────────────────────────────────────────────────────────

/**
 * @param {string} binaryPath
 * @param {LlamaServeSettings} [settings]
 * @param {NodeJS.ProcessEnv} [baseEnv]
 * @param {(binaryPath: string, baseEnv?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv} buildBaseEnv
 */
export function buildLlamaServerSpawnEnv(binaryPath, settings, baseEnv, buildBaseEnv) {
  const env = buildBaseEnv(binaryPath, baseEnv);
  if (settings?.env && typeof settings.env === 'object') {
    Object.assign(env, settings.env);
  }
  return env;
}
