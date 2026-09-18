/**
 * Inspector launch-draft helpers (Phase 1c).
 *
 * Load must send `{}` until a ctx / GPU / KV control is touched so the server
 * planner owns those fields. Hardcoded display fixtures — do not call
 * planLlamaLaunch here; that module already has its own golden tests.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CONTEXT_LADDER, type LlamaLaunchPlan } from '../../src/models/launch-plan.mjs';
import { llamaSettingsFromLaunchPrefs, estimateLoadDurationMs } from '../../src/config/library-launch-meta.ts';
import {
  applyGpuLayersAuto,
  applyGpuLayersTouch,
  applyCacheTypeTouch,
  applyCacheTypeSideTouch,
  contextSliderMax,
  CONTEXT_SLIDER_STEP,
  ensureManualDraft,
  launchValidationError,
  settingsForDraft,
  snapCtxPerSlot,
  type DisplayedLaunch,
} from '../../src/ui/models/inspector-launch.ts';

/** Static auto-mode display (12 GB CUDA 8B at preferred 32k). */
const PLAN: LlamaLaunchPlan = {
  ctx: 32768,
  ctxPerSlot: 32768,
  n_gpu_layers: null,
  cache_type: 'f16',
  flash_attn: 'on',
  fits: true,
  estimateGb: 8,
  reason: 'fixture',
  clampedFrom: null,
};

const DISPLAYED: DisplayedLaunch = {
  ctxPerSlot: 32768,
  ctx: 32768,
  n_gpu_layers: null,
  cache_type: 'f16',
  parallel: 1,
  trainCtx: 131072,
  plan: PLAN,
};

describe('inspector-launch draft helpers', () => {
  it('settingsForDraft keeps vision-off in auto and manual drafts', () => {
    assert.deepEqual(settingsForDraft({ no_mmproj: true }), { no_mmproj: true });
    assert.equal(settingsForDraft({ fit_mode: 'manual', no_mmproj: true }).no_mmproj, true);
    assert.deepEqual(settingsForDraft({ no_mmproj: false }), {});
  });

  it('settingsForDraft(undefined) is {} so Load does not materialize 125k/999', () => {
    assert.deepEqual(settingsForDraft(undefined), {});
  });

  it('auto draft with only parallel still omits ctx and n_gpu_layers', () => {
    const payload = settingsForDraft({ parallel: 4 });
    assert.deepEqual(payload, { parallel: 4 });
    assert.equal(payload.ctx, undefined);
    assert.equal(payload.n_gpu_layers, undefined);
    assert.equal(payload.fit_mode, undefined);
    assert.equal(payload.cache_type, undefined);
  });

  it('ensureManualDraft sets fit_mode manual and copies the displayed ctx', () => {
    const next = ensureManualDraft(undefined, DISPLAYED);
    assert.equal(next.fit_mode, 'manual');
    assert.equal(next.ctx, DISPLAYED.ctx);
    assert.equal(next.cache_type, DISPLAYED.cache_type);
    assert.equal(next.parallel, DISPLAYED.parallel);
    // GPU auto is null — do not write n_gpu_layers so the server keeps --fit on
    // until the user actually moves the layers slider.
    assert.equal(next.n_gpu_layers, undefined);
  });

  it('applyGpuLayersAuto restores unset ngl and collapses a GPU-only touch to planner auto', () => {
    const touched = applyGpuLayersTouch(undefined, DISPLAYED, 12);
    assert.equal(touched.n_gpu_layers, 12);
    assert.equal(touched.fit_mode, 'manual');
    const restored = applyGpuLayersAuto(touched, DISPLAYED);
    assert.equal(restored.n_gpu_layers, undefined);
    assert.equal(restored.fit_mode, undefined);
    assert.equal(restored.ctx, undefined);
    assert.deepEqual(settingsForDraft(restored), {});
  });

  it('applyGpuLayersAuto keeps a custom parallel slot count when collapsing GPU auto', () => {
    const restored = applyGpuLayersAuto(
      applyGpuLayersTouch({ parallel: 4 }, DISPLAYED, 12),
      DISPLAYED,
    );
    assert.equal(restored.n_gpu_layers, undefined);
    assert.equal(restored.parallel, 4);
    assert.deepEqual(settingsForDraft(restored), { parallel: 4 });
  });

  it('applyGpuLayersAuto keeps a custom context while restoring GPU auto', () => {
    const restored = applyGpuLayersAuto(
      {
        fit_mode: 'manual',
        ctx: 8192,
        n_gpu_layers: 12,
        cache_type: 'f16',
      },
      DISPLAYED,
    );
    assert.equal(restored.fit_mode, 'manual');
    assert.equal(restored.ctx, 8192);
    assert.equal(restored.n_gpu_layers, undefined);
    assert.equal(restored.cache_type, 'f16');
    assert.equal(settingsForDraft(restored).n_gpu_layers, undefined);
  });

  it('estimateLoadDurationMs scales monotonically with file size', () => {
    assert.equal(estimateLoadDurationMs(2_000_000_000, 10_000, 1_000_000_000), 20_000);
    assert.equal(estimateLoadDurationMs(1_000_000_000, 10_000, 1_000_000_000), 10_000);
    assert.equal(estimateLoadDurationMs(0, 10_000, 1_000_000_000), null);
  });

  it('saved manual launch prefs round-trip through settingsForDraft', () => {
    const saved = {
      fit_mode: 'manual' as const,
      ctx: 8192,
      n_gpu_layers: 12,
      cache_type: 'q8_0',
      parallel: 2,
      lastLoadMs: 5000,
      lastWeightsBytes: 1_000_000_000,
    };
    const draft = llamaSettingsFromLaunchPrefs(saved);
    assert.ok(draft);
    assert.equal((draft as { lastLoadMs?: number }).lastLoadMs, undefined);
    assert.deepEqual(settingsForDraft(draft), {
      fit_mode: 'manual',
      ctx: 8192,
      n_gpu_layers: 12,
      cache_type: 'q8_0',
      parallel: 2,
    });
  });

  it('blocks a draft-model spec mode with no draft model, and nothing else', () => {
    assert.equal(launchValidationError(undefined), null);
    assert.equal(launchValidationError({ spec_type: 'none' }), null);
    // MTP and the ngram families need no second model.
    assert.equal(launchValidationError({ spec_type: 'draft-mtp' }, true), null);
    assert.equal(launchValidationError({ spec_type: 'ngram-simple' }), null);

    const missing = launchValidationError({ spec_type: 'draft-simple' });
    assert.match(String(missing), /second, smaller model/);
    assert.equal(
      launchValidationError({ spec_type: 'draft-simple', spec_draft_model: '/tmp/d.gguf' }),
      null,
    );
    // Whitespace is not a path.
    assert.ok(launchValidationError({ spec_type: 'draft-eagle3', spec_draft_model: '   ' }));
  });

  it('blocks draft-mtp only once the header says the heads are absent', () => {
    // null = header still loading. Guessing here would lock a user out of a working mode.
    assert.equal(launchValidationError({ spec_type: 'draft-mtp' }, null), null);
    assert.equal(launchValidationError({ spec_type: 'draft-mtp' }, true), null);
    assert.match(
      String(launchValidationError({ spec_type: 'draft-mtp' }, false)),
      /no multi-token-prediction heads/,
    );
  });

  it('carries speculative settings through an auto draft without leaving auto', () => {
    const payload = settingsForDraft({
      spec_type: 'draft-mtp',
      spec_draft_n_max: 5,
      spec_draft_p_min: 0.4,
    });
    assert.equal(payload.fit_mode, undefined);
    assert.equal(payload.spec_type, 'draft-mtp');
    assert.equal(payload.spec_draft_n_max, 5);
    assert.equal(payload.spec_draft_p_min, 0.4);
    // `none` is the absence of the flag, not a value to send.
    assert.equal(settingsForDraft({ spec_type: 'none' }).spec_type, undefined);
  });

  it('carries device split fields through an auto draft', () => {
    const payload = settingsForDraft({
      device: 'CUDA1,CUDA0',
      split_mode: 'layer',
      tensor_split: '5,5',
      parallel: 1,
    });
    assert.equal(payload.fit_mode, undefined);
    assert.equal(payload.device, 'CUDA1,CUDA0');
    assert.equal(payload.split_mode, 'layer');
    assert.equal(payload.tensor_split, '5,5');
  });

  it('snapCtxPerSlot and contextSliderMax never exceed trainCtx', () => {
    assert.equal(contextSliderMax(8192), 8192);
    assert.equal(contextSliderMax(131072), 131072);
    // Missing header → last ladder rung, not an unbounded slider.
    assert.equal(contextSliderMax(null), CONTEXT_LADDER[CONTEXT_LADDER.length - 1]);
    assert.equal(contextSliderMax(undefined), CONTEXT_LADDER[CONTEXT_LADDER.length - 1]);
    // 20k requested but trained context is 8k → snap to 8192, not 16384.
    assert.equal(snapCtxPerSlot(20000, 8192), 8192);
    // 5k under an 8k cap → floor onto the 1k slider grid (4096).
    assert.equal(snapCtxPerSlot(5000, 8192), 4096);
    assert.equal(snapCtxPerSlot(32768, 131072), 32768);
    // Manual slider is 1024-token steps, not the 13-rung auto-planning ladder.
    assert.equal(CONTEXT_SLIDER_STEP, 1024);
    assert.equal(snapCtxPerSlot(40000, 131072), 39936);
    // Far-right max is always legal, even when trainCtx is not step-aligned.
    assert.equal(snapCtxPerSlot(10000, 10000), 10000);
  });

  it('applyCacheTypeTouch clears one-sided K/V overrides', () => {
    const next = applyCacheTypeTouch(
      { fit_mode: 'manual', ctx: 32768, cache_type: 'f16', cache_type_v: 'q8_0' },
      DISPLAYED,
      'q8_0',
    );
    assert.equal(next.cache_type, 'q8_0');
    assert.equal(next.cache_type_k, undefined);
    assert.equal(next.cache_type_v, undefined);
  });

  it('applyCacheTypeSideTouch writes the same type on both K and V', () => {
    const fromV = applyCacheTypeSideTouch(undefined, DISPLAYED, 'v', 'q8_0');
    assert.equal(fromV.fit_mode, 'manual');
    assert.equal(fromV.cache_type_k, 'q8_0');
    assert.equal(fromV.cache_type_v, 'q8_0');
    assert.equal(fromV.cache_type, 'q8_0');

    const cleared = applyCacheTypeSideTouch(fromV, DISPLAYED, 'k', undefined);
    assert.equal(cleared.cache_type_k, undefined);
    assert.equal(cleared.cache_type_v, undefined);
  });
});
