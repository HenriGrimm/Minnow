import {
  estimateRunMemory,
  GIB,
  maxContextForBudget,
} from './memory-model.mjs';
import { GEOMETRY_UNCERTAINTY } from './model-geometry.mjs';

export const PREFERRED_CONTEXT_TOKENS = 32_768;

export const CONTEXT_LADDER = [
  4096, 6144, 8192, 12288, 16384, 24576, 32768, 49152, 65536, 98304, 131072, 196608, 262144,
];

/** KV types we will consider, in quality order. Quantized KV is a last resort. */
const CACHE_DEGRADE = ['f16', 'q8_0', 'q4_0'];

/** Lowest rung we will plan. Below this the graph still needs a micro-batch of scratch. */
const MIN_LADDER = CONTEXT_LADDER[0];

/** Ceiling used when the GGUF header did not report trainCtx. */
const MISSING_TRAIN_CTX = 8192;

/**
 * @typedef {object} LaunchHardware
 * @property {number} [gpuVramGb]
 * @property {number} [selectedGpuVramGb]
 * @property {number} [availableRamGb]
 * @property {number} [totalRamGb]
 * @property {string} [backend]
 */

/**
 * @typedef {object} LaunchRequested
 * @property {number} [ctx] Upper cap on per-slot context (does not raise the plan).
 * @property {'f16' | 'q8_0' | 'q4_0'} [cache_type] Starting KV type; planner may degrade.
 */

/**
 * @typedef {object} LaunchPlanInput
 * @property {import('./model-geometry.d.mts').ModelGeometry} geometry
 * @property {number} weightsBytes
 * @property {number} [trainCtx]
 * @property {LaunchHardware} hardware
 * @property {string} [variant] llama.cpp variant id (`cuda-12.4`, `vulkan`, `cpu`, …).
 * @property {number} [parallel]
 * @property {LaunchRequested} [requested]
 */

/**
 * @typedef {object} LaunchPlanClampedFrom
 * @property {number} [ctx]
 * @property {string} [cache_type]
 */

/**
 * @typedef {object} LlamaLaunchPlan
 * @property {number} ctx Total tokens for `-c` (`ctxPerSlot * parallel`).
 * @property {number} ctxPerSlot
 * @property {number | null} n_gpu_layers `null` on GPU auto (leave `-ngl` unset); `0` on CPU.
 * @property {'f16' | 'q8_0' | 'q4_0'} cache_type
 * @property {string} [cache_type_k] Resolved `--cache-type-k`, stamped on by
 *   buildLlamaServerLaunch once manual overrides are folded in.
 * @property {string} [cache_type_v] Resolved `--cache-type-v`.
 * @property {boolean} [swa_full] `--swa-full` was requested; sizing drops the SWA saving.
 * @property {string} [spec_type] `--spec-type` the launch asked for, when not `none`.
 * @property {string} [spec_draft_model] `--spec-draft-model` path, when one was set.
 * @property {number} [draftWeightsBytes] Draft model size on disk.
 * @property {number} [specContextBytes] llama-server's own post-load speculative-context figure.
 * @property {'on' | 'auto'} flash_attn
 * @property {boolean} fits
 * @property {number} estimateGb
 * @property {string} reason
 * @property {LaunchPlanClampedFrom | null} clampedFrom
 */

/** @param {string | null | undefined} variant */
export function isCpuLlamaVariant(variant) {
  const v = String(variant ?? 'cpu').toLowerCase();
  return v === 'cpu' || v.startsWith('cpu-');
}

/**
 * Flash attention: CUDA/Metal/ROCm want it on (llama.cpp `--flash-attn auto` on CUDA has
 * historically picked a path that OOMs or is slower). Vulkan and CPU keep `auto`.
 * @param {string | null | undefined} variant
 * @returns {'on' | 'auto'}
 */
export function flashAttnForVariant(variant) {
  const v = String(variant ?? '').toLowerCase();
  if (v.includes('cuda') || v.includes('metal') || v.includes('rocm')) return 'on';
  return 'auto';
}

/**
 * Backend id for estimateRunMemory overhead tables, derived from the variant string so a
 * test fixture does not have to invent a matching `hardware.backend`.
 * @param {string | null | undefined} variant
 */
function backendForVariant(variant) {
  const v = String(variant ?? '').toLowerCase();
  if (v.includes('cuda')) return 'cuda';
  if (v.includes('metal')) return 'metal';
  if (v.includes('rocm') || v.includes('hip')) return 'rocm';
  if (v.includes('vulkan')) return 'vulkan';
  if (v.includes('sycl')) return 'sycl';
  return 'cpu';
}

/**
 * Bytes the run is allowed to consume. GPU cards keep a WDDM/UI reserve; CPU runs must
 * leave RAM for the OS and the Minnow renderer.
 * @param {LaunchHardware | null | undefined} hardware
 * @param {string | null | undefined} variant
 */
export function launchBudgetBytes(hardware, variant) {
  const selected = Number(hardware?.selectedGpuVramGb) || 0;
  const gpuVramGb = selected > 0 ? selected : Number(hardware?.gpuVramGb) || 0;
  if (!isCpuLlamaVariant(variant) && gpuVramGb > 0) {
    const vram = gpuVramGb * GIB;
    const reserve = Math.max(0.9 * GIB, vram * 0.08);
    return Math.max(0, vram - reserve);
  }
  const available = Number(hardware?.availableRamGb) || 0;
  const total = Number(hardware?.totalRamGb) || 0;
  return Math.min(available * 0.7, total * 0.55) * GIB;
}

/**
 * Largest ladder rung ≤ n, or 0 when n is below the first rung.
 * @param {number} n
 */
export function snapContextToLadder(n) {
  const tokens = Math.trunc(Number(n) || 0);
  let best = 0;
  for (const rung of CONTEXT_LADDER) {
    if (rung <= tokens) best = rung;
  }
  return best;
}

/** Next lower ladder rung, or 0. */
function lowerLadderRung(ctxPerSlot) {
  const idx = CONTEXT_LADDER.lastIndexOf(ctxPerSlot);
  if (idx <= 0) return 0;
  return CONTEXT_LADDER[idx - 1];
}

/** @param {number} bytes */
function budgetGbLabel(bytes) {
  return Math.round((bytes / GIB) * 10) / 10;
}

/**
 * Auto-mode launch plan. `requested.ctx` is an upper cap only — it never raises context
 * above `min(trainCtx || 8192, PREFERRED_CONTEXT_TOKENS)`. `requested.cache_type` is a
 * starting KV type (still degrades under pressure); omit it to start at f16.
 *
 * @param {LaunchPlanInput} input
 * @returns {LlamaLaunchPlan}
 */
export function planLlamaLaunch(input) {
  const geometry = input.geometry;
  const weightsBytes = Math.max(0, Number(input.weightsBytes) || 0);
  const variant = input.variant ?? 'cpu';
  const hardware = input.hardware ?? {};
  const requested = input.requested ?? {};
  const parallel = Math.max(1, Math.trunc(Number(input.parallel) || 1));
  const cpu = isCpuLlamaVariant(variant);
  const n_gpu_layers = cpu ? 0 : null;
  const backend = backendForVariant(variant);
  const flash_attn = flashAttnForVariant(variant);

  const budgetBytes = launchBudgetBytes(hardware, variant);
  const uncertainty = GEOMETRY_UNCERTAINTY[geometry.source] ?? GEOMETRY_UNCERTAINTY.heuristic;
  const effectiveBudget = budgetBytes / uncertainty;

  const trainCeiling = Number(input.trainCtx) > 0 ? Math.trunc(Number(input.trainCtx)) : MISSING_TRAIN_CTX;
  let target = Math.min(trainCeiling, PREFERRED_CONTEXT_TOKENS);
  if (Number(requested.ctx) > 0) {
    target = Math.min(target, Math.trunc(Number(requested.ctx)));
  }

  const estimateAt = (ctx, cacheType) =>
    estimateRunMemory({
      geometry,
      weightsBytes,
      ctx,
      cacheType,
      backend,
      nGpuLayers: cpu ? 0 : undefined,
    });

  // A fork-only type (turbo3 …) is already the small end: plan it as-is, never swap it for q4_0.
  const forkType =
    typeof requested.cache_type === 'string' && /^turbo/i.test(requested.cache_type)
      ? requested.cache_type
      : null;
  const startType = forkType ?? (CACHE_DEGRADE.includes(requested.cache_type) ? requested.cache_type : 'f16');
  const typesToTry = forkType ? [forkType] : CACHE_DEGRADE.slice(CACHE_DEGRADE.indexOf(startType));

  /** Value we would have wanted before trainCtx/budget talked. */
  const unclampedWish =
    Number(requested.ctx) > 0
      ? Math.min(PREFERRED_CONTEXT_TOKENS, Math.trunc(Number(requested.ctx)))
      : PREFERRED_CONTEXT_TOKENS;

  /**
   * Fit total `-c` tokens (per-slot × parallel) so estimateRunMemory(plan.ctx) stays
   * inside the budget. llama.cpp sizes the KV cache to `-c`, not to per-slot context.
   * @param {string} cacheType
   */
  function fitPerSlot(cacheType) {
    const kvBudget = effectiveBudget - estimateAt(0, cacheType).totalBytes;
    const fittedTotal = maxContextForBudget(geometry, kvBudget, cacheType, {
      snap: 'none',
      minCtx: MIN_LADDER,
      maxCtx: target * parallel,
    });
    if (fittedTotal <= 0) return 0;

    let ctxPerSlot = snapContextToLadder(Math.min(Math.floor(fittedTotal / parallel), target, trainCeiling));
    while (ctxPerSlot >= MIN_LADDER && estimateAt(ctxPerSlot * parallel, cacheType).totalBytes > effectiveBudget) {
      ctxPerSlot = lowerLadderRung(ctxPerSlot);
    }
    return ctxPerSlot >= MIN_LADDER ? ctxPerSlot : 0;
  }

  let cache_type = typesToTry[0];
  let ctxPerSlot = 0;
  for (const type of typesToTry) {
    const fitted = fitPerSlot(type);
    if (fitted >= MIN_LADDER) {
      cache_type = type;
      ctxPerSlot = fitted;
      break;
    }
  }

  const fits = ctxPerSlot >= MIN_LADDER;
  if (!fits) {
    ctxPerSlot = snapContextToLadder(Math.min(MIN_LADDER, target, trainCeiling)) || Math.min(MIN_LADDER, trainCeiling);
    cache_type = typesToTry[typesToTry.length - 1];
  }

  const ctx = ctxPerSlot * parallel;
  const estimate = estimateAt(ctx, cache_type);
  const gb = budgetGbLabel(budgetBytes);

  /** @type {LaunchPlanClampedFrom} */
  const clampedFrom = {};
  if (ctxPerSlot < unclampedWish) clampedFrom.ctx = unclampedWish;
  if (cache_type !== 'f16' && startType === 'f16') clampedFrom.cache_type = 'f16';

  const reason = fits
    ? ctxPerSlot < unclampedWish
      ? `Fits ${ctxPerSlot} tokens/slot at ${cache_type} KV within ${gb} GB; clamped from ${unclampedWish}.`
      : `Fits ${ctxPerSlot} tokens/slot at ${cache_type} KV within ${gb} GB.`
    : `Weights plus ${MIN_LADDER}-token KV exceed the ${gb} GB budget even with ${cache_type} cache.`;

  return {
    ctx,
    ctxPerSlot,
    n_gpu_layers,
    cache_type,
    flash_attn,
    fits,
    estimateGb: estimate.totalGb,
    reason,
    clampedFrom: Object.keys(clampedFrom).length ? clampedFrom : null,
  };
}
