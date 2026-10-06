/**
 * Pure unit tests for planLlamaLaunch. No mock.module — the planner has no I/O.
 *
 * Expected ctx values below are locked from the algorithm (snap-to-ladder after
 * maxContextForBudget snap:'none'). If they move, the launch defaults users will
 * see in Phase 1c moved with them.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_CONTEXT_TOKENS } from '../../server/models/default-context-tokens.js';
import {
  CONTEXT_LADDER,
  launchBudgetBytes,
  planLlamaLaunch,
  PREFERRED_CONTEXT_TOKENS,
  snapContextToLadder,
} from '../../src/models/launch-plan.mjs';
import { estimateRunMemory, GIB, weightsBytesFor } from '../../src/models/memory-model.mjs';
import { resolveGeometry } from '../../src/models/model-geometry.mjs';

/** Llama-like 8B GQA, header-quality geometry. */
const DENSE_8B = {
  nLayers: 32,
  nKvHeads: 8,
  headDim: 128,
  nEmbd: 4096,
  nVocab: 128256,
  nExperts: 0,
  swaWindow: 0,
  swaPeriod: 1,
  source: 'gguf',
};

/** Gemma-style SWA: 1 full-attn layer in 6, 1024-token window. Same KV heads as DENSE_8B. */
const GEMMA_SWA = {
  nLayers: 48,
  nKvHeads: 8,
  headDim: 256,
  nEmbd: 4096,
  nVocab: 128256,
  nExperts: 0,
  swaWindow: 1024,
  swaPeriod: 6,
  source: 'gguf',
};

const MOE_30B_A3B = resolveGeometry({ architecture: 'qwen3_moe', paramsB: 30, activeParamsB: 3 });

const WEIGHTS_8B_Q4_KM = weightsBytesFor(8, 'Q4_K_M');
const WEIGHTS_8B_Q6_K = weightsBytesFor(8, 'Q6_K');
const WEIGHTS_30B_Q4_KM = weightsBytesFor(30, 'Q4_K_M');

/** Typical Llama-3.1 header; large enough that parallel=4 still keeps total -c ≤ trainCtx. */
const TRAIN_CTX = 131072;

const VRAM_GBS = [6, 8, 12, 24, 96];

function cudaHw(gpuVramGb) {
  return { gpuVramGb, availableRamGb: 32, totalRamGb: 64, backend: 'cuda' };
}

function planCuda(geometry, weightsBytes, gpuVramGb, extra = {}) {
  return planLlamaLaunch({
    geometry,
    weightsBytes,
    trainCtx: TRAIN_CTX,
    hardware: cudaHw(gpuVramGb),
    variant: 'cuda-12.4',
    ...extra,
  });
}

function estimatePlan(geometry, weightsBytes, plan, variant) {
  const cpu = variant === 'cpu';
  let backend = 'cuda';
  if (cpu) backend = 'cpu';
  else if (variant.includes('metal')) backend = 'metal';
  else if (variant.includes('vulkan')) backend = 'vulkan';
  return estimateRunMemory({
    geometry,
    weightsBytes,
    ctx: plan.ctx,
    cacheType: plan.cache_type,
    backend,
    nGpuLayers: cpu ? 0 : undefined,
  });
}

// ── launch-plan constants ────────────────────────────────────────────────────

describe('launch-plan constants', () => {
  it('keeps the deprecated 125k export unchanged so Discover ranking does not move', () => {
    assert.equal(DEFAULT_CONTEXT_TOKENS, 125000);
    assert.equal(PREFERRED_CONTEXT_TOKENS, 32768);
  });

  it('exports the locked context ladder including non-power-of-two rungs', () => {
    assert.deepEqual(CONTEXT_LADDER, [
      4096, 6144, 8192, 12288, 16384, 24576, 32768, 49152, 65536, 98304, 131072, 196608, 262144,
    ]);
  });
});

// ── launchBudgetBytes ────────────────────────────────────────────────────────

describe('launchBudgetBytes', () => {
  it('reserves 0.9 GiB on small NVIDIA cards because 8% of 6 GB is not enough WDDM headroom', () => {
    assert.equal(launchBudgetBytes(cudaHw(6), 'cuda-12.4'), 6 * GIB - 0.9 * GIB);
    assert.equal(launchBudgetBytes(cudaHw(8), 'cuda-12.4'), 8 * GIB - 0.9 * GIB);
  });

  it('switches to 8% reserve once that exceeds 0.9 GiB', () => {
    assert.equal(launchBudgetBytes(cudaHw(12), 'cuda-12.4'), 12 * GIB - 12 * GIB * 0.08);
    assert.equal(launchBudgetBytes(cudaHw(24), 'cuda-12.4'), 24 * GIB - 24 * GIB * 0.08);
    assert.equal(launchBudgetBytes(cudaHw(96), 'cuda-12.4'), 96 * GIB - 96 * GIB * 0.08);
  });

  it('uses a RAM fraction on CPU so the OS and the Minnow UI keep a working set', () => {
    const hw = { gpuVramGb: 0, availableRamGb: 32, totalRamGb: 64, backend: 'cpu_x86' };
    assert.equal(launchBudgetBytes(hw, 'cpu'), Math.min(32 * 0.7, 64 * 0.55) * GIB);
  });
});

// ── snapContextToLadder ──────────────────────────────────────────────────────

describe('snapContextToLadder', () => {
  it('picks the largest rung that still fits, including non-pot values', () => {
    assert.equal(snapContextToLadder(4096), 4096);
    assert.equal(snapContextToLadder(5000), 4096);
    assert.equal(snapContextToLadder(6144), 6144);
    assert.equal(snapContextToLadder(12000), 8192);
    assert.equal(snapContextToLadder(12288), 12288);
    assert.equal(snapContextToLadder(32768), 32768);
    assert.equal(snapContextToLadder(40000), 32768);
  });

  it('returns 0 below the first rung so the planner can degrade cache type', () => {
    assert.equal(snapContextToLadder(4095), 0);
    assert.equal(snapContextToLadder(0), 0);
  });
});

// ── planLlamaLaunch 8B dense ─────────────────────────────────────────────────

describe('planLlamaLaunch 8B dense × VRAM', () => {
  // Locked 2026-08-16 from planLlamaLaunch + weightsBytesFor(8, 'Q4_K_M').
  const EXPECTED = {
    6: { ctxPerSlot: 4096, cache_type: 'q4_0', fits: false },
    8: { ctxPerSlot: 12288, cache_type: 'f16', fits: true },
    12: { ctxPerSlot: 32768, cache_type: 'f16', fits: true },
    24: { ctxPerSlot: 32768, cache_type: 'f16', fits: true },
    96: { ctxPerSlot: 32768, cache_type: 'f16', fits: true },
  };

  it('matches the locked ctx table and stays on the ladder', () => {
    for (const vram of VRAM_GBS) {
      const plan = planCuda(DENSE_8B, WEIGHTS_8B_Q4_KM, vram);
      const expected = EXPECTED[vram];
      assert.equal(plan.ctxPerSlot, expected.ctxPerSlot, `${vram}GB ctxPerSlot`);
      assert.equal(plan.ctx, expected.ctxPerSlot, `${vram}GB ctx at parallel=1`);
      assert.equal(plan.cache_type, expected.cache_type, `${vram}GB cache_type`);
      assert.equal(plan.fits, expected.fits, `${vram}GB fits`);
      assert.equal(CONTEXT_LADDER.includes(plan.ctxPerSlot), true);
      assert.equal(plan.ctx <= TRAIN_CTX, true);
      assert.equal(plan.ctxPerSlot <= TRAIN_CTX, true);
    }
  });

  it('is monotonic: more VRAM never yields less context', () => {
    let prev = 0;
    for (const vram of VRAM_GBS) {
      const plan = planCuda(DENSE_8B, WEIGHTS_8B_Q4_KM, vram);
      assert.ok(plan.ctx >= prev, `${vram}GB ctx ${plan.ctx} < previous ${prev}`);
      prev = plan.ctx;
    }
  });

  it('uses a non-power-of-two ladder rung at 8 GB, which power2 snap would have killed', () => {
    // 8 GB fits 12288 at f16. maxContextForBudget's default power2 snap would have
    // reported 8192 and the 12288 rung would be dead.
    assert.equal(planCuda(DENSE_8B, WEIGHTS_8B_Q4_KM, 8).ctxPerSlot, 12288);
  });

  it('defaults to f16 KV when the card has room', () => {
    assert.equal(planCuda(DENSE_8B, WEIGHTS_8B_Q4_KM, 12).cache_type, 'f16');
    assert.equal(planCuda(DENSE_8B, WEIGHTS_8B_Q4_KM, 24).cache_type, 'f16');
  });

  it('does not fit 6 GB even after KV degradation — estimate may exceed budget when fits is false', () => {
    const plan = planCuda(DENSE_8B, WEIGHTS_8B_Q4_KM, 6);
    assert.equal(plan.fits, false);
    assert.equal(plan.cache_type, 'q4_0');
    const est = estimatePlan(DENSE_8B, WEIGHTS_8B_Q4_KM, plan, 'cuda-12.4');
    const budget = launchBudgetBytes(cudaHw(6), 'cuda-12.4');
    assert.ok(est.totalBytes > budget);
    assert.match(plan.reason, /exceed/);
  });
});

// ── planLlamaLaunch 30B-A3B MoE ──────────────────────────────────────────────

describe('planLlamaLaunch 30B-A3B MoE × VRAM', () => {
  it('resolved the shipped Qwen3-MoE 30B geometry (family source, expert bank present)', () => {
    assert.equal(MOE_30B_A3B.source, 'family');
    assert.equal(MOE_30B_A3B.nLayers, 48);
    assert.equal(MOE_30B_A3B.nExperts, 128);
  });

  // 17.1 GiB Q4_K_M weights cannot land on 6/8/12 GB cards; 24 GB reaches the 32k preferred cap.
  const EXPECTED = {
    6: { ctxPerSlot: 4096, cache_type: 'q4_0', fits: false },
    8: { ctxPerSlot: 4096, cache_type: 'q4_0', fits: false },
    12: { ctxPerSlot: 4096, cache_type: 'q4_0', fits: false },
    24: { ctxPerSlot: 32768, cache_type: 'f16', fits: true },
    96: { ctxPerSlot: 32768, cache_type: 'f16', fits: true },
  };

  it('matches the locked MoE ctx table', () => {
    let prev = 0;
    for (const vram of VRAM_GBS) {
      const plan = planCuda(MOE_30B_A3B, WEIGHTS_30B_Q4_KM, vram);
      const expected = EXPECTED[vram];
      assert.equal(plan.ctxPerSlot, expected.ctxPerSlot, `${vram}GB`);
      assert.equal(plan.cache_type, expected.cache_type, `${vram}GB cache`);
      assert.equal(plan.fits, expected.fits, `${vram}GB fits`);
      assert.equal(CONTEXT_LADDER.includes(plan.ctxPerSlot), true);
      assert.ok(plan.ctx >= prev);
      assert.ok(plan.ctxPerSlot <= TRAIN_CTX);
      prev = plan.ctx;
    }
  });
});

// ── planLlamaLaunch Gemma-style ──────────────────────────────────────────────

describe('planLlamaLaunch Gemma-style SWA × VRAM', () => {
  // Same 8B Q4_K_M file size as the dense fixture so the extra context at 8 GB is SWA, not weights.
  const EXPECTED = {
    6: { ctxPerSlot: 4096, cache_type: 'q4_0', fits: false },
    8: { ctxPerSlot: 16384, cache_type: 'f16', fits: true },
    12: { ctxPerSlot: 32768, cache_type: 'f16', fits: true },
    24: { ctxPerSlot: 32768, cache_type: 'f16', fits: true },
    96: { ctxPerSlot: 32768, cache_type: 'f16', fits: true },
  };

  it('matches the locked SWA ctx table and never plans less context than dense 8B at the same VRAM', () => {
    let prev = 0;
    for (const vram of VRAM_GBS) {
      const plan = planCuda(GEMMA_SWA, WEIGHTS_8B_Q4_KM, vram);
      const dense = planCuda(DENSE_8B, WEIGHTS_8B_Q4_KM, vram);
      const expected = EXPECTED[vram];
      assert.equal(plan.ctxPerSlot, expected.ctxPerSlot, `${vram}GB`);
      assert.equal(plan.cache_type, expected.cache_type);
      assert.equal(plan.fits, expected.fits);
      assert.ok(plan.ctx >= dense.ctx, `SWA ${vram}GB ${plan.ctx} < dense ${dense.ctx}`);
      assert.ok(plan.ctx >= prev);
      prev = plan.ctx;
    }
  });
});

// ── planLlamaLaunch budget ───────────────────────────────────────────────────

describe('planLlamaLaunch budget invariant', () => {
  it('keeps estimateRunMemory(plan) inside the launch budget whenever fits is true', () => {
    const cases = [
      [DENSE_8B, WEIGHTS_8B_Q4_KM],
      [MOE_30B_A3B, WEIGHTS_30B_Q4_KM],
      [GEMMA_SWA, WEIGHTS_8B_Q4_KM],
    ];
    for (const [geometry, weights] of cases) {
      for (const vram of VRAM_GBS) {
        const plan = planCuda(geometry, weights, vram);
        if (!plan.fits) continue;
        const est = estimatePlan(geometry, weights, plan, 'cuda-12.4');
        const budget = launchBudgetBytes(cudaHw(vram), 'cuda-12.4');
        assert.ok(
          est.totalBytes <= budget,
          `est ${est.totalBytes} > budget ${budget} at ${vram}GB`,
        );
      }
    }
  });
});

// ── planLlamaLaunch ceilings ─────────────────────────────────────────────────

describe('planLlamaLaunch ceilings and parallel', () => {
  it('sizes one shared context pool for unified KV regardless of parallel slots', () => {
    const single = planCuda(DENSE_8B, WEIGHTS_8B_Q4_KM, 24);
    const shared = planCuda(DENSE_8B, WEIGHTS_8B_Q4_KM, 24, { parallel: 3, kvUnified: true });
    assert.equal(shared.ctx, single.ctx);
    assert.equal(shared.ctxPerSlot, shared.ctx);
    assert.equal(shared.estimateGb, single.estimateGb);
    assert.match(shared.reason, /shared across slots/);
    const separate = planCuda(DENSE_8B, WEIGHTS_8B_Q4_KM, 24, { parallel: 3, kvUnified: false });
    assert.equal(separate.ctx, separate.ctxPerSlot * 3);
    assert.ok(separate.estimateGb > shared.estimateGb);
  });

  it('never plans above trainCtx=8192 even on a 96 GB card', () => {
    const plan = planLlamaLaunch({
      geometry: DENSE_8B,
      weightsBytes: WEIGHTS_8B_Q4_KM,
      trainCtx: 8192,
      hardware: cudaHw(96),
      variant: 'cuda-12.4',
    });
    assert.equal(plan.ctx, 8192);
    assert.equal(plan.ctxPerSlot, 8192);
    assert.equal(plan.fits, true);
    assert.deepEqual(plan.clampedFrom, { ctx: 32768 });
  });

  it('treats missing trainCtx as an 8192 ceiling on the target formula', () => {
    const plan = planLlamaLaunch({
      geometry: DENSE_8B,
      weightsBytes: WEIGHTS_8B_Q4_KM,
      hardware: cudaHw(96),
      variant: 'cuda-12.4',
    });
    assert.equal(plan.ctx, 8192);
    assert.equal(plan.ctxPerSlot, 8192);
  });

  it('treats requested.ctx as an upper cap, not a raise', () => {
    const capped = planCuda(DENSE_8B, WEIGHTS_8B_Q4_KM, 96, { requested: { ctx: 8192 } });
    assert.equal(capped.ctxPerSlot, 8192);
    const ignoredRaise = planCuda(DENSE_8B, WEIGHTS_8B_Q4_KM, 96, { requested: { ctx: 65536 } });
    assert.equal(ignoredRaise.ctxPerSlot, 32768);
  });

  it('emits ctx = ctxPerSlot * parallel so -c is the total cache, not one slot', () => {
    const plan = planCuda(DENSE_8B, WEIGHTS_8B_Q4_KM, 24, { parallel: 4 });
    assert.equal(plan.ctxPerSlot, 32768);
    assert.equal(plan.ctx, 131072);
    assert.equal(plan.ctx, plan.ctxPerSlot * 4);
    assert.ok(plan.ctxPerSlot <= TRAIN_CTX);
    const est = estimatePlan(DENSE_8B, WEIGHTS_8B_Q4_KM, plan, 'cuda-12.4');
    const budget = launchBudgetBytes(cudaHw(24), 'cuda-12.4');
    assert.equal(plan.fits, true);
    assert.ok(est.totalBytes <= budget);
  });
});

// ── planLlamaLaunch variant ──────────────────────────────────────────────────

describe('planLlamaLaunch variant policy', () => {
  it('leaves n_gpu_layers null on GPU auto so llama.cpp --fit can pick the split', () => {
    const plan = planCuda(DENSE_8B, WEIGHTS_8B_Q4_KM, 24);
    assert.equal(plan.n_gpu_layers, null);
    assert.notEqual(plan.n_gpu_layers, 999);
  });

  it('sets n_gpu_layers to 0 on CPU because there is no GPU split to fit', () => {
    const plan = planLlamaLaunch({
      geometry: DENSE_8B,
      weightsBytes: WEIGHTS_8B_Q4_KM,
      trainCtx: TRAIN_CTX,
      hardware: { gpuVramGb: 0, availableRamGb: 32, totalRamGb: 64, backend: 'cpu_x86' },
      variant: 'cpu',
    });
    assert.equal(plan.n_gpu_layers, 0);
    assert.equal(plan.flash_attn, 'auto');
    assert.equal(plan.fits, true);
    assert.equal(plan.ctxPerSlot, 32768);
    assert.equal(CONTEXT_LADDER.includes(plan.ctxPerSlot), true);
    const est = estimatePlan(DENSE_8B, WEIGHTS_8B_Q4_KM, plan, 'cpu');
    const budget = launchBudgetBytes(
      { gpuVramGb: 0, availableRamGb: 32, totalRamGb: 64 },
      'cpu',
    );
    assert.ok(est.totalBytes <= budget);
  });

  it('turns flash attention on for cuda/metal/rocm and leaves auto for vulkan/cpu', () => {
    const hw = cudaHw(24);
    assert.equal(planLlamaLaunch({ geometry: DENSE_8B, weightsBytes: WEIGHTS_8B_Q4_KM, trainCtx: TRAIN_CTX, hardware: hw, variant: 'cuda-12.4' }).flash_attn, 'on');
    assert.equal(planLlamaLaunch({ geometry: DENSE_8B, weightsBytes: WEIGHTS_8B_Q4_KM, trainCtx: TRAIN_CTX, hardware: hw, variant: 'cuda-13' }).flash_attn, 'on');
    assert.equal(planLlamaLaunch({ geometry: DENSE_8B, weightsBytes: WEIGHTS_8B_Q4_KM, trainCtx: TRAIN_CTX, hardware: hw, variant: 'metal' }).flash_attn, 'on');
    assert.equal(planLlamaLaunch({ geometry: DENSE_8B, weightsBytes: WEIGHTS_8B_Q4_KM, trainCtx: TRAIN_CTX, hardware: hw, variant: 'rocm' }).flash_attn, 'on');
    assert.equal(planLlamaLaunch({ geometry: DENSE_8B, weightsBytes: WEIGHTS_8B_Q4_KM, trainCtx: TRAIN_CTX, hardware: hw, variant: 'vulkan' }).flash_attn, 'auto');
    assert.equal(planLlamaLaunch({ geometry: DENSE_8B, weightsBytes: WEIGHTS_8B_Q4_KM, trainCtx: TRAIN_CTX, hardware: hw, variant: 'cpu' }).flash_attn, 'auto');
  });
});

// ── planLlamaLaunch KV ───────────────────────────────────────────────────────

describe('planLlamaLaunch KV degradation', () => {
  it('quantizes KV under pressure before giving up, and still fits when q4_0 saves enough', () => {
    // 8B Q6_K (~6.16 GiB weights) on 8 GB: f16 KV at 4096 does not fit; q4_0 does.
    const plan = planCuda(DENSE_8B, WEIGHTS_8B_Q6_K, 8);
    assert.equal(plan.fits, true);
    assert.equal(plan.cache_type, 'q4_0');
    assert.equal(plan.ctxPerSlot, 4096);
    assert.deepEqual(plan.clampedFrom, { ctx: 32768, cache_type: 'f16' });
    const est = estimatePlan(DENSE_8B, WEIGHTS_8B_Q6_K, plan, 'cuda-12.4');
    assert.ok(est.totalBytes <= launchBudgetBytes(cudaHw(8), 'cuda-12.4'));
  });
});
