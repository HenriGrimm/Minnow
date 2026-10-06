import type { ModelGeometry } from './model-geometry.d.mts';

/**
 * Comfortable default context. Launch planning uses this instead of the deprecated
 * `DEFAULT_CONTEXT_TOKENS` (125000).
 */
export declare const PREFERRED_CONTEXT_TOKENS: 32768;

/**
 * Per-slot context sizes the planner will emit. Includes non-power-of-two rungs so a
 * card that fits 12k is not snapped to 8k.
 */
export declare const CONTEXT_LADDER: readonly number[];

/** Shape of `detectHardware()` fields the planner reads. */
export interface LaunchHardware {
  gpuVramGb?: number | null;
  /** Smallest selected card when `--device` pins a subset; wins over gpuVramGb for budgeting. */
  selectedGpuVramGb?: number | null;
  availableRamGb?: number | null;
  totalRamGb?: number | null;
  backend?: string | null;
}

/**
 * Optional caps for tests and (later) manual overrides.
 * `ctx` is an upper cap on per-slot context — it never raises the auto plan.
 * `cache_type` is a starting KV type; the planner may still degrade under pressure.
 */
export interface LaunchRequested {
  ctx?: number;
  cache_type?: 'f16' | 'q8_0' | 'q4_0';
}

export interface LaunchPlanInput {
  geometry: ModelGeometry;
  weightsBytes: number;
  /** GGUF `trainCtx`. Missing → 8192 ceiling on the target formula. Hard cap when set. */
  trainCtx?: number | null;
  hardware: LaunchHardware;
  /** llama.cpp variant id (`cuda-12.4`, `vulkan`, `metal`, `rocm`, `cpu`, …). */
  variant?: string;
  /** Slot count. Separate KV partitions multiply context by this count. Default 1. */
  parallel?: number;
  /** Slots share one context pool instead of fixed partitions. */
  kvUnified?: boolean;
  requested?: LaunchRequested;
}

export interface LaunchPlanClampedFrom {
  /** Per-slot tokens we would have wanted before trainCtx/budget reduced the plan. */
  ctx?: number;
  /** KV type we started from when degradation kicked in. */
  cache_type?: string;
}

export interface LlamaLaunchPlan {
  /** Total tokens for llama.cpp `-c` (one pool when KV is unified). */
  ctx: number;
  ctxPerSlot: number;
  /** `null` on GPU auto (leave `-ngl` unset). `0` on CPU. Never `999`. */
  n_gpu_layers: number | null;
  cache_type: 'f16' | 'q8_0' | 'q4_0';
  /** Resolved `--cache-type-k`, stamped on by buildLlamaServerLaunch. */
  cache_type_k?: string;
  /** Resolved `--cache-type-v`. */
  cache_type_v?: string;
  /** `--swa-full` was requested; sizing drops the sliding-window saving. */
  swa_full?: boolean;
  /** `--spec-type` the launch asked for, when not `none`. */
  spec_type?: string;
  /** `--spec-draft-model` path, when one was set. */
  spec_draft_model?: string;
  /** Draft model size on disk; a second set of weights on the same device budget. */
  draftWeightsBytes?: number;
  /** llama-server's own post-load figure for the speculative context, when it printed one. */
  specContextBytes?: number;
  flash_attn: 'on' | 'auto';
  fits: boolean;
  /** `estimateRunMemory(...).totalGb` at the planned ctx / cache / offload. */
  estimateGb: number;
  reason: string;
  clampedFrom: LaunchPlanClampedFrom | null;
}

export declare function isCpuLlamaVariant(variant?: string | null): boolean;
export declare function flashAttnForVariant(variant?: string | null): 'on' | 'auto';
export declare function launchBudgetBytes(
  hardware?: LaunchHardware | null,
  variant?: string | null,
): number;
export declare function snapContextToLadder(n: number): number;
export declare function planLlamaLaunch(input: LaunchPlanInput): LlamaLaunchPlan;
