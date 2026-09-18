import type { LlamaServeSettings } from '../../models/api-client';
import { specNeedsDraftModel } from '../../models/spec-decode.mjs';
import {
  CONTEXT_LADDER,
  planLlamaLaunch,
  type LaunchHardware,
  type LlamaLaunchPlan,
} from '../../models/launch-plan.mjs';
import { geometryFromGgufMetadata, resolveGeometry } from '../../models/model-geometry.mjs';
import type { GgufGeometryFacts } from '../../models/serve-memory-estimate';
import type { HardwareSnapshot } from '../../models/types';

const LADDER_MAX = CONTEXT_LADDER[CONTEXT_LADDER.length - 1];

/** Inspector slider floor. Same as the planner's lowest rung. */
export const CONTEXT_SLIDER_MIN = CONTEXT_LADDER[0];

export const CONTEXT_SLIDER_STEP = 1024;

/** Values the Load tab shows before the user overrides them. */
export interface DisplayedLaunch {
  ctxPerSlot: number;
  /** Total `-c` (`ctxPerSlot * parallel`). */
  ctx: number;
  /** `null` means GPU auto — llama.cpp sizes the split. `0` is CPU. */
  n_gpu_layers: number | null;
  cache_type: string;
  parallel: number;
  trainCtx: number | null;
  plan: LlamaLaunchPlan;
}

/** Slider ceiling: trained context when the header has it, else the last ladder rung, never above 262144. */
export function contextSliderMax(trainCtx?: number | null): number {
  const trained = Number(trainCtx) > 0 ? Math.trunc(Number(trainCtx)) : LADDER_MAX;
  return Math.min(trained, LADDER_MAX);
}

/** Snap a per-slot context onto the inspector slider grid. */
export function snapCtxPerSlot(tokens: number, maxTokens: number): number {
  const max = Math.max(1, Math.trunc(Number(maxTokens) || 0));
  const min = Math.min(CONTEXT_SLIDER_MIN, max);
  if (!Number.isFinite(tokens)) return min;
  if (tokens <= min) return min;
  if (tokens >= max) return max;
  const stepped =
    min + Math.floor((tokens - min) / CONTEXT_SLIDER_STEP) * CONTEXT_SLIDER_STEP;
  return Math.min(max, Math.max(min, stepped));
}

/** Payload for `loadModel`. */
export function settingsForDraft(draft: LlamaServeSettings | undefined): LlamaServeSettings {
  if (!draft) return {};
  if (draft.fit_mode !== 'manual') {
    const out: LlamaServeSettings = {};
    if (draft.batch_size != null) out.batch_size = draft.batch_size;
    if (draft.ubatch_size != null) out.ubatch_size = draft.ubatch_size;
    if (draft.parallel != null) out.parallel = draft.parallel;
    if (draft.extra_args) out.extra_args = draft.extra_args;
    if (draft.env) out.env = draft.env;
    if (draft.device) out.device = draft.device;
    if (draft.split_mode) out.split_mode = draft.split_mode;
    if (draft.tensor_split) out.tensor_split = draft.tensor_split;
    if (draft.main_gpu != null) out.main_gpu = draft.main_gpu;
    if (draft.n_cpu_moe != null) out.n_cpu_moe = draft.n_cpu_moe;
    if (draft.threads != null) out.threads = draft.threads;
    if (draft.ctx_checkpoints != null) out.ctx_checkpoints = draft.ctx_checkpoints;
    if (draft.rope_freq_base != null) out.rope_freq_base = draft.rope_freq_base;
    if (draft.rope_freq_scale != null) out.rope_freq_scale = draft.rope_freq_scale;
    if (draft.seed != null) out.seed = draft.seed;
    if (draft.idle_ttl_ms != null) out.idle_ttl_ms = draft.idle_ttl_ms;
    if (typeof draft.kv_unified === 'boolean') out.kv_unified = draft.kv_unified;
    if (draft.kv_offload === false) out.kv_offload = false;
    if (typeof draft.context_shift === 'boolean') out.context_shift = draft.context_shift;
    if (draft.swa_full === true) out.swa_full = true;
    if (draft.flash_attn) out.flash_attn = draft.flash_attn;
    if (draft.reasoning_budget_message) {
      out.reasoning_budget_message = draft.reasoning_budget_message;
    }
    if (draft.spec_type && draft.spec_type !== 'none') {
      out.spec_type = draft.spec_type;
      if (draft.spec_draft_model) out.spec_draft_model = draft.spec_draft_model;
      if (draft.spec_draft_ngl != null) out.spec_draft_ngl = draft.spec_draft_ngl;
      if (draft.spec_draft_n_max != null) out.spec_draft_n_max = draft.spec_draft_n_max;
      if (draft.spec_draft_n_min != null) out.spec_draft_n_min = draft.spec_draft_n_min;
      if (draft.spec_draft_p_min != null) out.spec_draft_p_min = draft.spec_draft_p_min;
    }
    if (draft.no_mmap === true) out.no_mmap = true;
    if (draft.no_mmproj === true) out.no_mmproj = true;
    if (draft.mlock === true) out.mlock = true;
    if (draft.chat_template) out.chat_template = draft.chat_template;
    if (draft.chat_template_file) out.chat_template_file = draft.chat_template_file;
    return out;
  }
  return { ...draft };
}

function passThroughFrom(draft: LlamaServeSettings | undefined): LlamaServeSettings {
  return settingsForDraft(
    draft?.fit_mode === 'manual' ? { ...draft, fit_mode: 'auto' } : draft,
  );
}

/** Copy the currently displayed (planned) values and mark the draft manual. */
export function ensureManualDraft(
  draft: LlamaServeSettings | undefined,
  displayed: DisplayedLaunch,
): LlamaServeSettings {
  if (draft?.fit_mode === 'manual') return { ...draft };
  const parallel = Math.max(1, draft?.parallel ?? displayed.parallel);
  const next: LlamaServeSettings = {
    ...passThroughFrom(draft),
    fit_mode: 'manual',
    ctx: displayed.ctx,
    cache_type: displayed.cache_type,
    parallel,
  };
  if (displayed.n_gpu_layers != null) next.n_gpu_layers = displayed.n_gpu_layers;
  return next;
}

/** First (or later) touch of the per-slot context slider. Stores total `-c`. */
export function applyCtxPerSlotTouch(
  draft: LlamaServeSettings | undefined,
  displayed: DisplayedLaunch,
  ctxPerSlot: number,
): LlamaServeSettings {
  const next = ensureManualDraft(draft, displayed);
  const parallel = Math.max(1, next.parallel ?? displayed.parallel);
  next.ctx = ctxPerSlot * parallel;
  next.parallel = parallel;
  return next;
}

/** First (or later) touch of GPU layers. Moving the slider writes a count, never Auto. */
export function applyGpuLayersTouch(
  draft: LlamaServeSettings | undefined,
  displayed: DisplayedLaunch,
  nGpuLayers: number,
): LlamaServeSettings {
  const next = ensureManualDraft(draft, displayed);
  next.n_gpu_layers = nGpuLayers;
  return next;
}

/** Restore GPU Auto: drop `n_gpu_layers` so llama.cpp `--fit` owns the split. */
export function applyGpuLayersAuto(
  draft: LlamaServeSettings | undefined,
  displayed: DisplayedLaunch,
): LlamaServeSettings {
  const next: LlamaServeSettings = { ...(draft ?? {}) };
  delete next.n_gpu_layers;

  if (next.fit_mode !== 'manual') {
    return passThroughFrom(next);
  }

  const ctxMatchesPlan = next.ctx == null || next.ctx === displayed.plan.ctx;
  const cacheMatchesPlan = !next.cache_type || next.cache_type === displayed.plan.cache_type;
  if (ctxMatchesPlan && cacheMatchesPlan) {
    const restored = passThroughFrom({ ...next, fit_mode: 'auto' });
    if (restored.parallel === 1) delete restored.parallel;
    return restored;
  }

  return next;
}

export function applyCacheTypeTouch(
  draft: LlamaServeSettings | undefined,
  displayed: DisplayedLaunch,
  cacheType: string,
): LlamaServeSettings {
  const next = ensureManualDraft(draft, displayed);
  next.cache_type = cacheType;
  // Shared KV type owns both sides. Leftover K-only / V-only overrides are the crawl.
  delete next.cache_type_k;
  delete next.cache_type_v;
  return next;
}

/**
 * Pinning K or V independently is a cache-type choice, so it leaves auto the same way the shared KV select does.
 * Mixed K/V types fragment the CUDA flash-attn graph, so a one-sided change writes both sides.
 */
export function applyCacheTypeSideTouch(
  draft: LlamaServeSettings | undefined,
  displayed: DisplayedLaunch,
  _side: 'k' | 'v',
  cacheType: string | undefined,
): LlamaServeSettings {
  const next = ensureManualDraft(draft, displayed);
  if (cacheType) {
    next.cache_type_k = cacheType;
    next.cache_type_v = cacheType;
    if (cacheType === 'f16' || cacheType === 'q8_0' || cacheType === 'q4_0') {
      next.cache_type = cacheType;
    }
  } else {
    delete next.cache_type_k;
    delete next.cache_type_v;
  }
  return next;
}

/** Parallel / batch / extra_args do not leave auto. */
export function applyPassThroughTouch(
  draft: LlamaServeSettings | undefined,
  displayed: DisplayedLaunch,
  patch: LlamaServeSettings,
): LlamaServeSettings {
  if (draft?.fit_mode === 'manual' && patch.parallel != null) {
    const prevParallel = Math.max(1, draft.parallel ?? displayed.parallel);
    const perSlot = Math.max(1, Math.round((draft.ctx ?? displayed.ctx) / prevParallel));
    return {
      ...draft,
      ...patch,
      parallel: patch.parallel,
      ctx: perSlot * Math.max(1, patch.parallel),
    };
  }
  if (draft?.fit_mode === 'manual') return { ...draft, ...patch };
  return { ...passThroughFrom(draft), ...patch };
}

/** Why this draft cannot be launched, or `null` when it can. */
export function launchValidationError(
  draft: LlamaServeSettings | undefined,
  mtpCapable: boolean | null = null,
): string | null {
  const specType = draft?.spec_type;
  if (!specType || specType === 'none') return null;

  if (specNeedsDraftModel(specType, draft?.spec_draft_model)) {
    return `${specType} drafts tokens with a second, smaller model. Choose a draft GGUF, or set speculative decoding to none.`;
  }

  if (specType === 'draft-mtp' && mtpCapable === false) {
    return 'These weights carry no multi-token-prediction heads, so draft-mtp cannot start. Use a draft model instead, or set speculative decoding to none.';
  }

  return null;
}

export function isManualDraft(draft: LlamaServeSettings | undefined): boolean {
  return draft?.fit_mode === 'manual';
}

/** Client-side plan for slider starting positions. */
export function inspectorLaunchPlan(input: {
  gguf: GgufGeometryFacts | null;
  arch?: string | null;
  name?: string | null;
  paramsB?: number | null;
  sizeBytes: number;
  hardware: HardwareSnapshot | null;
  variant?: string | null;
  parallel?: number;
}): LlamaLaunchPlan {
  const geometry =
    (input.gguf ? geometryFromGgufMetadata(input.gguf) : null) ??
    resolveGeometry({
      architecture: input.arch ?? undefined,
      name: input.name ?? undefined,
      paramsB: input.paramsB ?? undefined,
    });
  const variant = input.variant || input.hardware?.backend || 'cpu';
  const hw = input.hardware;
  const hardware: LaunchHardware = {
    gpuVramGb: hw?.gpuVramGb,
    availableRamGb: hw?.availableRamGb,
    totalRamGb: hw?.totalRamGb,
    backend: hw?.backend,
  };
  const trainCtx = Number(input.gguf?.trainCtx) > 0 ? Number(input.gguf?.trainCtx) : undefined;
  const weightsBytes = Math.max(0, input.sizeBytes || 0);
  const parallel = Math.max(1, Math.trunc(Number(input.parallel) || 1));

  return planLlamaLaunch({
    geometry,
    weightsBytes,
    trainCtx,
    hardware,
    variant,
    parallel,
  });
}

/** Merge a draft (or the empty auto state) with the client plan for rendering. */
export function displayedLaunchFrom(
  draft: LlamaServeSettings | undefined,
  plan: LlamaLaunchPlan,
  trainCtx: number | null,
): DisplayedLaunch {
  const parallel = Math.max(1, draft?.parallel ?? 1);
  if (draft?.fit_mode !== 'manual') {
    return {
      ctxPerSlot: plan.ctxPerSlot,
      ctx: plan.ctx,
      n_gpu_layers: plan.n_gpu_layers,
      cache_type: plan.cache_type,
      parallel,
      trainCtx,
      plan,
    };
  }
  const perSlot = snapCtxPerSlot(
    Math.round((Number(draft.ctx) || plan.ctx) / Math.max(1, draft.parallel ?? parallel)),
    contextSliderMax(trainCtx),
  );
  return {
    ctxPerSlot: perSlot,
    ctx: perSlot * Math.max(1, draft.parallel ?? parallel),
    n_gpu_layers: draft.n_gpu_layers ?? null,
    cache_type: draft.cache_type ?? plan.cache_type,
    parallel: Math.max(1, draft.parallel ?? parallel),
    trainCtx,
    plan,
  };
}
