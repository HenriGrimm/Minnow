import { isLocalServeProviderId } from '../../src/models/engine-ids.mjs';
import path from 'node:path';
import { isCpuLlamaVariant, launchBudgetBytes } from '../../src/models/launch-plan.mjs';
import { estimateRunMemory, GIB } from '../../src/models/memory-model.mjs';

export const SERVE_IDLE_TTL_MS = 20 * 60 * 1000;

/**
 * @param {string | null | undefined} variant
 */
function backendFromVariant(variant) {
  const v = String(variant ?? '').toLowerCase();
  if (v.includes('cuda')) return 'cuda';
  if (v.includes('metal')) return 'metal';
  if (v.includes('rocm') || v.includes('hip')) return 'rocm';
  if (v.includes('vulkan')) return 'vulkan';
  if (v.includes('sycl')) return 'sycl';
  return 'cpu';
}

/**
 * @param {{ userModelsMax?: unknown, budgetGb: number, isCpu: boolean }} opts
 * @returns {number}
 */
export function resolveModelsMax(opts) {
  const raw = opts.userModelsMax;
  const parsed =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string'
        ? Number.parseInt(raw, 10)
        : Number.NaN;
  if (Number.isInteger(parsed) && parsed >= 1) return parsed;

  if (opts.isCpu) {
    return 1;
  }

  const gb = Number(opts.budgetGb) || 0;
  if (gb > 32) return 3;
  if (gb >= 16) return 2;
  return 1;
}

/**
 * @param {{ hardware?: object, variant?: string, userModelsMax?: unknown }} opts
 */
export function resolveResidencyLimits(opts) {
  const hardware = opts.hardware && typeof opts.hardware === 'object' ? opts.hardware : {};
  const variant = opts.variant ?? 'cpu';
  const isCpu = isCpuLlamaVariant(variant);
  const budgetBytes = launchBudgetBytes(hardware, variant);
  const budgetGb = isCpu
    ? budgetBytes / GIB
    : Number(hardware.gpuVramGb) > 0
      ? Number(hardware.gpuVramGb)
      : budgetBytes / GIB;
  const modelsMax = resolveModelsMax({
    userModelsMax: opts.userModelsMax,
    budgetGb,
    isCpu,
  });
  return { modelsMax, budgetBytes, budgetGb, isCpu };
}

/**
 * @param {object | null | undefined} plan
 * @returns {number}
 */
export function estimatePlanMemoryBytes(plan) {
  if (!plan || typeof plan !== 'object') return 0;
  const isCpu = isCpuLlamaVariant(plan.variant);
  if (plan.geometry && typeof plan.geometry === 'object') {
    const est = estimateRunMemory({
      geometry: plan.geometry,
      weightsBytes: Number(plan.weightsBytes) || 0,
      ctx: Number(plan.ctx) || 0,
      cacheType: {
        k: typeof plan.cache_type_k === 'string' ? plan.cache_type_k : plan.cache_type,
        v: typeof plan.cache_type_v === 'string' ? plan.cache_type_v : plan.cache_type,
      },
      nGpuLayers: plan.n_gpu_layers == null ? undefined : Number(plan.n_gpu_layers),
      backend: backendFromVariant(plan.variant),
      swaFull: plan.swa_full === true,
      draftWeightsBytes:
        (Number(plan.draftWeightsBytes) || 0) + (Number(plan.specContextBytes) || 0),
    });
    return isCpu ? est.ramBytes : est.vramBytes;
  }
  if (Number(plan.estimateGb) > 0) return Number(plan.estimateGb) * GIB;
  return 0;
}

/**
 * @param {{ residents: Array<{ id: string, lastUsedAt?: number, estimateBytes?: number }>, incomingEstimateBytes: number, incomingId?: string, modelsMax: number, budgetBytes: number, }} opts
 * @returns {Array<{ id: string, lastUsedAt?: number, estimateBytes?: number }>}
 */
export function pickEvictions(opts) {
  const incomingId = opts.incomingId;
  const remaining = opts.residents.filter((row) => row.id !== incomingId);
  const incomingBytes = Number(opts.incomingEstimateBytes) || 0;
  const modelsMax = Math.max(1, Number(opts.modelsMax) || 1);
  const budgetBytes = Number(opts.budgetBytes);
  const hasBudget = Number.isFinite(budgetBytes) && budgetBytes > 0;
  const evicted = [];

  const overLimit = () => {
    const used = remaining.reduce((sum, row) => sum + (Number(row.estimateBytes) || 0), 0);
    const overCap = remaining.length >= modelsMax;
    const overBudget = hasBudget && used + incomingBytes > budgetBytes;
    return overCap || overBudget;
  };

  while (remaining.length > 0 && overLimit()) {
    let victimIdx = 0;
    for (let i = 1; i < remaining.length; i += 1) {
      const t = remaining[i].lastUsedAt ?? 0;
      const vt = remaining[victimIdx].lastUsedAt ?? 0;
      if (t < vt) victimIdx = i;
    }
    evicted.push(remaining[victimIdx]);
    remaining.splice(victimIdx, 1);
  }
  return evicted;
}

/**
 * @param {{ libraryId?: string, modelLabel?: string, modelPath?: string }} row
 * @param {string | null | undefined} modelId
 */
export function serveMatchesModelId(row, modelId) {
  const id = String(modelId ?? '').trim();
  if (!id || !row) return false;
  const normalizedPath = String(row.modelPath || '').replace(/\\/g, '/');
  const base = path.basename(normalizedPath);
  const stem = base.replace(/\.gguf$/i, '');
  const needles = [row.libraryId, row.modelLabel, row.modelPath, base, stem].filter(
    (value) => typeof value === 'string' && value.trim(),
  );
  const idLower = id.toLowerCase();
  return needles.some((needle) => needle === id || needle.toLowerCase() === idLower);
}

/**
 * True when a pending/streaming generation is bound to this serve.
 * Parent router states (`minnow-router` without routerAttempt) are ignored.
 * @param {object | null | undefined} serve
 * @param {object[]} generations
 */
export function serveHasInFlightGenerations(serve, generations) {
  if (!serve || !Array.isArray(generations)) return false;
  return generations.some((state) => {
    if (state.status !== 'pending' && state.status !== 'streaming') return false;
    if (state.providerId === 'minnow-router' && !state.routerAttempt) return false;
    const pid = state.chosenProviderId || state.providerId;
    if (!isLocalServeProviderId(pid)) return false;
    const mid = typeof state.chosenModelId === 'string' ? state.chosenModelId.trim() : '';
    if (!mid) return true;
    return serveMatchesModelId(serve, mid);
  });
}
