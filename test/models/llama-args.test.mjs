/**
 * llama-server CLI argument builder tests.
 *
 * Golden argv for Phase 1c: auto GPU uses --fit on / no -ngl / planner -c;
 * manual passes ctx/ngl through; legacy 125k/999 without fit_mode stays auto.
 */

import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import {
  buildLlamaServerArgs,
  buildLlamaServerLaunch,
  findSiblingMmproj,
} from '../../server/models/llama-args.js';
import { CONTEXT_LADDER } from '../../src/models/launch-plan.mjs';
import { weightsBytesFor } from '../../src/models/memory-model.mjs';

/** Same 8B GQA header launch-plan.test.mjs locked at 12 GB → 32768 f16. */
const GGUF_8B = {
  arch: 'llama',
  nLayers: 32,
  nKvHeads: 8,
  headDim: 128,
  nEmbd: 4096,
  nVocab: 128256,
  trainCtx: 131072,
};

const HW_12GB = { gpuVramGb: 12, availableRamGb: 32, totalRamGb: 64, backend: 'cuda' };
const WEIGHTS_8B_Q4_KM = weightsBytesFor(8, 'Q4_K_M');

function flagValue(args, flag) {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}

describe('llama args', () => {
  test('buildLlamaServerArgs forces ngl=0 on CPU variant', () => {
    const args = buildLlamaServerArgs({
      modelPath: '/tmp/model.gguf',
      port: 8085,
      variant: 'cpu',
      settings: { n_gpu_layers: 999, ctx: 4096 },
    });
    const nglIdx = args.indexOf('-ngl');
    assert.ok(nglIdx >= 0);
    assert.equal(args[nglIdx + 1], '0');
  });

  test('auto GPU with empty settings: --fit on, no -ngl, ladder -c, flash-attn on, fit-ctx, no swa-full', () => {
    const args = buildLlamaServerArgs({
      modelPath: '/tmp/model.gguf',
      port: 8085,
      variant: 'cuda-12.4',
      hardware: HW_12GB,
      modelMeta: { name: 'demo/8b', parameters_raw: 8, serveWeightsGb: WEIGHTS_8B_Q4_KM / 1024 ** 3 },
      weightsBytes: WEIGHTS_8B_Q4_KM,
      ggufMeta: GGUF_8B,
      settings: {},
    });

    assert.equal(flagValue(args, '--fit'), 'on');
    assert.equal(args.indexOf('-ngl'), -1);
    assert.equal(flagValue(args, '-c'), '32768');
    assert.equal(CONTEXT_LADDER.includes(Number(flagValue(args, '-c'))), true);
    assert.ok(Number(flagValue(args, '-c')) <= 32768);
    assert.equal(flagValue(args, '--flash-attn'), 'on');
    // Pin both sides including f16 so `--fit` cannot quantize only V.
    assert.equal(flagValue(args, '--cache-type-k'), 'f16');
    assert.equal(flagValue(args, '--cache-type-v'), 'f16');
    assert.equal(flagValue(args, '--fit-ctx'), '4096');
    // 12 GB reserve is max(0.9 GiB, 8% of 12) = 0.96 GiB → 983 MiB (--fit-target units are MiB).
    assert.equal(flagValue(args, '--fit-target'), '983');
    assert.equal(args.includes('--swa-full'), false);
    // Phase 4 LM-Studio-feel defaults. GPU auto leaves ngl unset → no `-t`.
    assert.equal(args.includes('--cont-batching'), true);
    assert.equal(flagValue(args, '--cache-reuse'), '256');
    assert.equal(flagValue(args, '--parallel'), '1');
    assert.equal(args.indexOf('-t'), -1);
    assert.equal(args.indexOf('--alias'), -1);
    assert.equal(args.includes('--no-mmap'), false);
    assert.equal(args.includes('--mlock'), false);
  });

  test('manual GPU passes ctx/ngl unclamped with --fit off and warns when over budget', () => {
    const launch = buildLlamaServerLaunch({
      modelPath: '/tmp/model.gguf',
      port: 8085,
      variant: 'cuda-12.4',
      hardware: HW_12GB,
      modelMeta: { name: 'demo/8b', parameters_raw: 8, serveWeightsGb: WEIGHTS_8B_Q4_KM / 1024 ** 3 },
      weightsBytes: WEIGHTS_8B_Q4_KM,
      ggufMeta: GGUF_8B,
      settings: { fit_mode: 'manual', ctx: 128000, n_gpu_layers: 32, cache_type: 'f16' },
    });
    const { args, warning } = launch;

    // nLayers + 1: llama.cpp spends one offload slot on the output layer.
    assert.equal(flagValue(args, '-ngl'), '33');
    assert.equal(flagValue(args, '-c'), '128000');
    assert.equal(flagValue(args, '--fit'), 'off');
    assert.ok(warning);
    assert.match(warning, /fit planner/);
    assert.match(warning, /warning: you overrode the fit planner/);
  });

  test('CPU auto: -ngl 0 and --flash-attn auto', () => {
    const args = buildLlamaServerArgs({
      modelPath: '/tmp/model.gguf',
      port: 8085,
      variant: 'cpu',
      hardware: { gpuVramGb: 0, availableRamGb: 32, totalRamGb: 64, backend: 'cpu' },
      modelMeta: { name: 'demo/8b', parameters_raw: 8 },
      weightsBytes: WEIGHTS_8B_Q4_KM,
      ggufMeta: GGUF_8B,
      settings: {},
    });
    assert.equal(flagValue(args, '-ngl'), '0');
    assert.equal(flagValue(args, '--flash-attn'), 'auto');
    // CPU auto is -ngl 0 with known nLayers → some layers stay on CPU, so `-t`.
    assert.equal(flagValue(args, '-t'), String(os.availableParallelism?.() ?? os.cpus().length));
  });

  test('legacy {ctx:125000, n_gpu_layers:999} without fit_mode stays AUTO (planner wins, no 999)', () => {
    const launch = buildLlamaServerLaunch({
      modelPath: '/tmp/model.gguf',
      port: 8085,
      variant: 'cuda-12.4',
      hardware: HW_12GB,
      modelMeta: { name: 'demo/8b', parameters_raw: 8 },
      weightsBytes: WEIGHTS_8B_Q4_KM,
      ggufMeta: GGUF_8B,
      settings: { ctx: 125000, n_gpu_layers: 999 },
    });
    const { args, settings } = launch;
    assert.equal(flagValue(args, '--fit'), 'on');
    assert.equal(args.indexOf('-ngl'), -1);
    assert.notEqual(flagValue(args, '-c'), '125000');
    assert.equal(settings.fit_mode, 'auto');
    assert.equal(settings.n_gpu_layers, undefined);
    assert.equal(args.includes('999'), false);
  });

  test('onboarding {ctx, cache_type, fit:true} without fit_mode stays AUTO', () => {
    const args = buildLlamaServerArgs({
      modelPath: '/tmp/model.gguf',
      port: 8085,
      variant: 'cuda-12.4',
      hardware: HW_12GB,
      weightsBytes: WEIGHTS_8B_Q4_KM,
      ggufMeta: GGUF_8B,
      settings: { ctx: 125000, cache_type: 'f16', fit: true },
    });
    assert.equal(flagValue(args, '--fit'), 'on');
    assert.equal(args.indexOf('-ngl'), -1);
    assert.equal(flagValue(args, '-c'), '32768');
  });

  test('GPU auto without hardware: --fit on, no -ngl, preferred -c (never ngl=999)', () => {
    const args = buildLlamaServerArgs({
      modelPath: '/tmp/model.gguf',
      port: 8085,
      variant: 'cuda-12.4',
      settings: { ctx: 2048 },
    });
    assert.equal(args.indexOf('-ngl'), -1);
    assert.equal(flagValue(args, '--fit'), 'on');
    assert.equal(flagValue(args, '-c'), '32768');
  });

  test('explicit partial ngl is manual: -ngl 32 and --fit off', () => {
    const args = buildLlamaServerArgs({
      modelPath: '/tmp/model.gguf',
      port: 8085,
      variant: 'cuda-12.4',
      settings: { fit_mode: 'manual', n_gpu_layers: 32, ctx: 4096 },
    });
    assert.equal(flagValue(args, '-ngl'), '32');
    assert.equal(flagValue(args, '--fit'), 'off');
    assert.equal(flagValue(args, '-c'), '4096');
  });

  test('manual with ngl unset keeps --fit on', () => {
    const args = buildLlamaServerArgs({
      modelPath: '/tmp/model.gguf',
      port: 8085,
      variant: 'cuda-12.4',
      hardware: HW_12GB,
      weightsBytes: WEIGHTS_8B_Q4_KM,
      ggufMeta: GGUF_8B,
      settings: { fit_mode: 'manual', ctx: 8192, cache_type: 'f16' },
    });
    assert.equal(args.indexOf('-ngl'), -1);
    assert.equal(flagValue(args, '--fit'), 'on');
    assert.equal(flagValue(args, '-c'), '8192');
  });

  test('buildLlamaServerArgs maps cache and batch flags in manual mode', () => {
    const args = buildLlamaServerArgs({
      modelPath: '/tmp/model.gguf',
      port: 9090,
      variant: 'cuda-12.4',
      settings: {
        fit_mode: 'manual',
        ctx: 8192,
        n_gpu_layers: 16,
        cache_type: 'q4_0',
        batch_size: 512,
        extra_args: ['--no-mmap'],
      },
    });
    assert.deepEqual(args.slice(0, 6), ['-m', '/tmp/model.gguf', '--host', '127.0.0.1', '--port', '9090']);
    assert.ok(args.includes('-c'));
    assert.ok(args.includes('8192'));
    assert.ok(args.includes('--cache-type-k'));
    assert.ok(args.includes('q4_0'));
    assert.ok(args.includes('-b'));
    assert.ok(args.includes('512'));
    assert.ok(args.includes('--no-mmap'));
    assert.ok(args.includes('--jinja'));
  });

  test('buildLlamaServerArgs passes --mmproj when a projector path is set', () => {
    const args = buildLlamaServerArgs({
      modelPath: '/tmp/Qwen3.8-27B-Q4_K_M.gguf',
      port: 8085,
      variant: 'cpu',
      mmprojPath: '/tmp/mmproj-F16.gguf',
    });
    const idx = args.indexOf('--mmproj');
    assert.ok(idx >= 0);
    assert.equal(args[idx + 1], '/tmp/mmproj-F16.gguf');
    assert.ok(args.includes('--jinja'));
  });

  test('no_mmproj leaves the sibling projector off (vision off for this load)', () => {
    const base = {
      modelPath: '/tmp/Qwen3.8-27B-Q4_K_M.gguf',
      port: 8085,
      variant: 'cpu',
      mmprojPath: '/tmp/mmproj-F16.gguf',
    };
    const off = buildLlamaServerLaunch({ ...base, settings: { no_mmproj: true } });
    assert.equal(off.args.includes('--mmproj'), false);
    assert.equal(off.settings.no_mmproj, true);

    const viaExtra = buildLlamaServerArgs({ ...base, settings: { extra_args: ['--no-mmproj'] } });
    assert.equal(viaExtra.includes('--mmproj'), false);

    const on = buildLlamaServerArgs({ ...base, settings: { no_mmproj: false } });
    assert.equal(flagValue(on, '--mmproj'), '/tmp/mmproj-F16.gguf');
  });

  test('buildLlamaServerArgs does not duplicate --jinja from extra_args', () => {
    const args = buildLlamaServerArgs({
      modelPath: '/tmp/model.gguf',
      port: 8085,
      variant: 'cpu',
      settings: { extra_args: ['--jinja'] },
    });
    assert.equal(args.filter((token) => token === '--jinja').length, 1);
  });

  test('skip_jinja omits --jinja (Phase 3 bad-template retry)', () => {
    const args = buildLlamaServerArgs({
      modelPath: '/tmp/model.gguf',
      port: 8085,
      variant: 'cpu',
      settings: { skip_jinja: true, extra_args: ['--jinja', '--no-mmap'] },
    });
    assert.equal(args.includes('--jinja'), false);
    assert.ok(args.includes('--no-mmap'));
  });

  test('buildLlamaServerArgs with ggufMeta auto-fits instead of ngl=999', () => {
    const args = buildLlamaServerArgs({
      modelPath: '/tmp/model.gguf',
      port: 8085,
      variant: 'cuda-12.4',
      hardware: { gpuVramGb: 24, availableRamGb: 32, totalRamGb: 64, backend: 'cuda' },
      modelMeta: { name: 'demo/7b', parameters_raw: 7, quantization: 'Q4_K_M' },
      ggufMeta: {
        arch: 'llama',
        nLayers: 80,
        nKvHeads: 8,
        headDim: 128,
        nEmbd: 4096,
        nVocab: 128256,
      },
    });
    assert.equal(args.indexOf('-ngl'), -1);
    assert.equal(flagValue(args, '--fit'), 'on');
  });

  test('findSiblingMmproj prefers mmproj-F16 next to the weights', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'minnow-mmproj-'));
    await fsp.writeFile(path.join(dir, 'Qwen3.8-27B-Q4_K_M.gguf'), '');
    await fsp.writeFile(path.join(dir, 'mmproj-BF16.gguf'), '');
    await fsp.writeFile(path.join(dir, 'mmproj-F16.gguf'), '');
    const found = await findSiblingMmproj(path.join(dir, 'Qwen3.8-27B-Q4_K_M.gguf'));
    assert.equal(found, path.join(dir, 'mmproj-F16.gguf'));
    await fsp.rm(dir, { recursive: true, force: true });
  });

  test('--alias uses libraryId unless extra_args already set it', () => {
    const args = buildLlamaServerArgs({
      modelPath: '/tmp/model.gguf',
      port: 8085,
      variant: 'cuda-12.4',
      hardware: HW_12GB,
      weightsBytes: WEIGHTS_8B_Q4_KM,
      ggufMeta: GGUF_8B,
      libraryId: 'gguf:11111111-1111-1111-1111-111111111111',
      settings: {},
    });
    assert.equal(flagValue(args, '--alias'), 'gguf:11111111-1111-1111-1111-111111111111');

    const skipped = buildLlamaServerArgs({
      modelPath: '/tmp/model.gguf',
      port: 8085,
      variant: 'cuda-12.4',
      hardware: HW_12GB,
      weightsBytes: WEIGHTS_8B_Q4_KM,
      ggufMeta: GGUF_8B,
      libraryId: 'gguf:11111111-1111-1111-1111-111111111111',
      settings: { extra_args: ['--alias', 'user-alias'] },
    });
    assert.equal(flagValue(skipped, '--alias'), 'user-alias');
    assert.equal(skipped.filter((token) => token === '--alias').length, 1);
  });

  test('extra_args --no-cont-batching and --cache-reuse skip the defaults', () => {
    const args = buildLlamaServerArgs({
      modelPath: '/tmp/model.gguf',
      port: 8085,
      variant: 'cuda-12.4',
      hardware: HW_12GB,
      weightsBytes: WEIGHTS_8B_Q4_KM,
      ggufMeta: GGUF_8B,
      settings: { extra_args: ['--no-cont-batching', '--cache-reuse', '128'] },
    });
    assert.equal(args.includes('--cont-batching'), false);
    assert.equal(args.includes('--no-cont-batching'), true);
    assert.equal(flagValue(args, '--cache-reuse'), '128');
    assert.equal(args.filter((token) => token === '--cache-reuse').length, 1);
  });

  test('quoted extra_args chat-template survives as two argv tokens', () => {
    const fromString = buildLlamaServerArgs({
      modelPath: '/tmp/model.gguf',
      port: 8085,
      variant: 'cpu',
      settings: { extra_args: '--chat-template "hello world"' },
    });
    const idx = fromString.indexOf('--chat-template');
    assert.ok(idx >= 0);
    assert.equal(fromString[idx + 1], 'hello world');

    // Naive inspector split of the same string must be recovered.
    const fromNaive = buildLlamaServerArgs({
      modelPath: '/tmp/model.gguf',
      port: 8085,
      variant: 'cpu',
      settings: { extra_args: ['--chat-template', '"hello', 'world"'] },
    });
    const naiveIdx = fromNaive.indexOf('--chat-template');
    assert.equal(fromNaive[naiveIdx + 1], 'hello world');
  });

  test('chat_template setting emits --chat-template with spaces intact', () => {
    const args = buildLlamaServerArgs({
      modelPath: '/tmp/model.gguf',
      port: 8085,
      variant: 'cpu',
      settings: { chat_template: 'hello world' },
    });
    const idx = args.indexOf('--chat-template');
    assert.ok(idx >= 0);
    assert.equal(args[idx + 1], 'hello world');
  });

  test('no_mmap and mlock settings emit flags; extra_args --no-mmap is not duplicated', () => {
    const fromSettings = buildLlamaServerArgs({
      modelPath: '/tmp/model.gguf',
      port: 8085,
      variant: 'cpu',
      settings: { no_mmap: true, mlock: true },
    });
    assert.equal(fromSettings.includes('--no-mmap'), true);
    assert.equal(fromSettings.includes('--mlock'), true);

    const fromExtra = buildLlamaServerArgs({
      modelPath: '/tmp/model.gguf',
      port: 8085,
      variant: 'cpu',
      settings: { no_mmap: true, extra_args: ['--no-mmap'] },
    });
    assert.equal(fromExtra.filter((token) => token === '--no-mmap').length, 1);
  });

  test('manual partial ngl with known nLayers passes -t; full offload does not', () => {
    const expectedThreads = String(os.availableParallelism?.() ?? os.cpus().length);
    const partial = buildLlamaServerArgs({
      modelPath: '/tmp/model.gguf',
      port: 8085,
      variant: 'cuda-12.4',
      hardware: HW_12GB,
      weightsBytes: WEIGHTS_8B_Q4_KM,
      ggufMeta: GGUF_8B,
      settings: { fit_mode: 'manual', n_gpu_layers: 16, ctx: 4096 },
    });
    assert.equal(flagValue(partial, '-ngl'), '16');
    assert.equal(flagValue(partial, '-t'), expectedThreads);

    const full = buildLlamaServerArgs({
      modelPath: '/tmp/model.gguf',
      port: 8085,
      variant: 'cuda-12.4',
      hardware: HW_12GB,
      weightsBytes: WEIGHTS_8B_Q4_KM,
      ggufMeta: GGUF_8B,
      settings: { fit_mode: 'manual', n_gpu_layers: 32, ctx: 4096 },
    });
    assert.equal(flagValue(full, '-ngl'), '33');
    assert.equal(full.indexOf('-t'), -1);
  });

  test('manual ngl at the layer count offloads every block (nLayers + 1)', () => {
    // `-ngl 32` on a 32-block model leaves one block on the CPU: llama.cpp spends the
    // first offload slot on the output layer. The slider's "All" must clear the model.
    for (const requested of [32, 40]) {
      const args = buildLlamaServerArgs({
        modelPath: '/tmp/model.gguf',
        port: 8085,
        variant: 'cuda-12.4',
        hardware: HW_12GB,
        weightsBytes: WEIGHTS_8B_Q4_KM,
        ggufMeta: GGUF_8B,
        settings: { fit_mode: 'manual', n_gpu_layers: requested, ctx: 4096 },
      });
      assert.equal(flagValue(args, '-ngl'), '33');
    }

    // Partial offload is a real user choice and passes through untouched.
    const partial = buildLlamaServerArgs({
      modelPath: '/tmp/model.gguf',
      port: 8085,
      variant: 'cuda-12.4',
      hardware: HW_12GB,
      weightsBytes: WEIGHTS_8B_Q4_KM,
      ggufMeta: GGUF_8B,
      settings: { fit_mode: 'manual', n_gpu_layers: 31, ctx: 4096 },
    });
    assert.equal(flagValue(partial, '-ngl'), '31');

    // No GGUF header means no layer count to reason about — do not invent one.
    const noMeta = buildLlamaServerArgs({
      modelPath: '/tmp/model.gguf',
      port: 8085,
      variant: 'cuda-12.4',
      hardware: HW_12GB,
      weightsBytes: WEIGHTS_8B_Q4_KM,
      settings: { fit_mode: 'manual', n_gpu_layers: 32, ctx: 4096 },
    });
    assert.equal(flagValue(noMeta, '-ngl'), '32');
  });

  test('extra_args -t skips the default thread flag', () => {
    const args = buildLlamaServerArgs({
      modelPath: '/tmp/model.gguf',
      port: 8085,
      variant: 'cpu',
      hardware: { gpuVramGb: 0, availableRamGb: 32, totalRamGb: 64, backend: 'cpu' },
      weightsBytes: WEIGHTS_8B_Q4_KM,
      ggufMeta: GGUF_8B,
      settings: { extra_args: ['-t', '4'] },
    });
    assert.equal(flagValue(args, '-t'), '4');
    assert.equal(args.filter((token) => token === '-t').length, 1);
  });

  test('settings.parallel: 2 emits --parallel 2; empty settings stay --parallel 1', () => {
    const two = buildLlamaServerArgs({
      modelPath: '/tmp/model.gguf',
      port: 8085,
      variant: 'cuda-12.4',
      hardware: HW_12GB,
      modelMeta: { name: 'demo/8b', parameters_raw: 8, serveWeightsGb: WEIGHTS_8B_Q4_KM / 1024 ** 3 },
      weightsBytes: WEIGHTS_8B_Q4_KM,
      ggufMeta: GGUF_8B,
      settings: { parallel: 2 },
    });
    assert.equal(flagValue(two, '--parallel'), '2');
    // Total -c is still a ladder rung; planner multiplies per-slot × parallel.
    assert.ok(Number(flagValue(two, '-c')) > 0);
  });

  test('LM Studio parity flags map to their llama-server spellings', () => {
    const args = buildLlamaServerArgs({
      modelPath: '/tmp/model.gguf',
      port: 8085,
      variant: 'cuda-12.4',
      hardware: HW_12GB,
      weightsBytes: WEIGHTS_8B_Q4_KM,
      ggufMeta: GGUF_8B,
      settings: {
        threads: 12,
        kv_unified: true,
        kv_offload: false,
        ctx_checkpoints: 8,
        context_shift: true,
        swa_full: true,
        rope_freq_base: 1_000_000,
        rope_freq_scale: 0.5,
        seed: 42,
        flash_attn: 'off',
        reasoning_budget_message: 'Out of thinking budget.',
      },
    });
    assert.equal(flagValue(args, '-t'), '12');
    assert.ok(args.includes('--kv-unified'));
    assert.ok(args.includes('--no-kv-offload'));
    assert.equal(flagValue(args, '-ctxcp'), '8');
    assert.ok(args.includes('--context-shift'));
    assert.ok(args.includes('--swa-full'));
    assert.equal(flagValue(args, '--rope-freq-base'), '1000000');
    assert.equal(flagValue(args, '--rope-freq-scale'), '0.5');
    assert.equal(flagValue(args, '-s'), '42');
    assert.equal(flagValue(args, '--flash-attn'), 'off');
    assert.equal(flagValue(args, '--reasoning-budget-message'), 'Out of thinking budget.');
  });

  test('boolean parity flags emit their off spelling, or nothing when unset', () => {
    const off = buildLlamaServerArgs({
      modelPath: '/tmp/model.gguf',
      port: 8085,
      variant: 'cuda-12.4',
      hardware: HW_12GB,
      weightsBytes: WEIGHTS_8B_Q4_KM,
      ggufMeta: GGUF_8B,
      settings: { kv_unified: false, context_shift: false },
    });
    assert.ok(off.includes('--no-kv-unified'));
    assert.ok(off.includes('--no-context-shift'));

    const unset = buildLlamaServerArgs({
      modelPath: '/tmp/model.gguf',
      port: 8085,
      variant: 'cuda-12.4',
      hardware: HW_12GB,
      weightsBytes: WEIGHTS_8B_Q4_KM,
      ggufMeta: GGUF_8B,
      settings: {},
    });
    for (const flag of [
      '--kv-unified',
      '--no-kv-unified',
      '--no-kv-offload',
      '-ctxcp',
      '--context-shift',
      '--no-context-shift',
      '--swa-full',
      '--rope-freq-base',
      '--rope-freq-scale',
      '-s',
      '--reasoning-budget-message',
    ]) {
      assert.equal(unset.includes(flag), false, `${flag} should not be emitted by default`);
    }
  });

  test('extra_args wins over every parity flag', () => {
    const args = buildLlamaServerArgs({
      modelPath: '/tmp/model.gguf',
      port: 8085,
      variant: 'cuda-12.4',
      hardware: HW_12GB,
      weightsBytes: WEIGHTS_8B_Q4_KM,
      ggufMeta: GGUF_8B,
      settings: {
        seed: 42,
        ctx_checkpoints: 8,
        flash_attn: 'off',
        cache_type_k: 'q4_0',
        extra_args: ['-s', '7', '-ctxcp', '4', '--flash-attn', 'on', '--cache-type-k', 'q8_0'],
      },
    });
    assert.equal(args.filter((token) => token === '-s').length, 1);
    assert.equal(flagValue(args, '-s'), '7');
    assert.equal(args.filter((token) => token === '-ctxcp').length, 1);
    assert.equal(flagValue(args, '-ctxcp'), '4');
    assert.equal(args.filter((token) => token === '--flash-attn').length, 1);
    assert.equal(flagValue(args, '--flash-attn'), 'on');
    assert.equal(args.filter((token) => token === '--cache-type-k').length, 1);
    assert.equal(flagValue(args, '--cache-type-k'), 'q8_0');
  });

  test('cache_type_k / cache_type_v stay paired; a one-sided override copies to both', () => {
    const split = buildLlamaServerLaunch({
      modelPath: '/tmp/model.gguf',
      port: 8085,
      variant: 'cuda-12.4',
      hardware: HW_12GB,
      weightsBytes: WEIGHTS_8B_Q4_KM,
      ggufMeta: GGUF_8B,
      settings: { fit_mode: 'manual', ctx: 4096, cache_type: 'q8_0', cache_type_v: 'q4_0' },
    });
    // Match KV + q4_0 V used to emit q8_0/q4_0 and crawl. Copy the explicit side.
    assert.equal(flagValue(split.args, '--cache-type-k'), 'q4_0');
    assert.equal(flagValue(split.args, '--cache-type-v'), 'q4_0');
    assert.match(String(split.warning), /K cache q8_0 and V cache q4_0 differ/);

    const pinnedF16 = buildLlamaServerLaunch({
      modelPath: '/tmp/model.gguf',
      port: 8085,
      variant: 'cuda-12.4',
      hardware: HW_12GB,
      weightsBytes: WEIGHTS_8B_Q4_KM,
      ggufMeta: GGUF_8B,
      settings: { fit_mode: 'manual', ctx: 4096, cache_type: 'q8_0', cache_type_k: 'f16' },
    });
    assert.equal(flagValue(pinnedF16.args, '--cache-type-k'), 'f16');
    assert.equal(flagValue(pinnedF16.args, '--cache-type-v'), 'f16');
    assert.match(String(pinnedF16.warning), /mixed types/);
  });

  test('matching K and V do not warn and emit the shared type on both flags', () => {
    const { args, warning } = buildLlamaServerLaunch({
      modelPath: '/tmp/model.gguf',
      port: 8085,
      variant: 'cuda-12.4',
      hardware: HW_12GB,
      weightsBytes: WEIGHTS_8B_Q4_KM,
      ggufMeta: GGUF_8B,
      settings: { fit_mode: 'manual', ctx: 4096, cache_type: 'q8_0', cache_type_k: 'q8_0', cache_type_v: 'q8_0' },
    });
    assert.equal(flagValue(args, '--cache-type-k'), 'q8_0');
    assert.equal(flagValue(args, '--cache-type-v'), 'q8_0');
    assert.equal(warning, null);
  });

  test('the removed --draft-max / --draft-min spellings are never emitted', () => {
    const { args } = buildLlamaServerLaunch({
      modelPath: '/tmp/model.gguf',
      port: 8085,
      variant: 'cuda-12.4',
      hardware: HW_12GB,
      weightsBytes: WEIGHTS_8B_Q4_KM,
      ggufMeta: GGUF_8B,
      settings: { seed: 1 },
    });
    for (const flag of ['--draft', '--draft-n', '--draft-max', '--draft-min', '--draft-n-min']) {
      assert.equal(args.includes(flag), false, `${flag} was removed in llama.cpp b9628+`);
    }
  });

  test('-lv 4 is emitted so the load bar has phase markers, unless extra_args sets it', () => {
    const args = buildLlamaServerArgs({
      modelPath: '/tmp/model.gguf',
      port: 8085,
      variant: 'cuda-12.4',
      hardware: HW_12GB,
      weightsBytes: WEIGHTS_8B_Q4_KM,
      ggufMeta: GGUF_8B,
      settings: {},
    });
    // At the default verbosity (3) the whole weight load is silent.
    assert.equal(flagValue(args, '-lv'), '4');
    // The activity poller depends on /slots; do not rely on it staying default-on.
    assert.ok(args.includes('--slots'));

    const pinned = buildLlamaServerArgs({
      modelPath: '/tmp/model.gguf',
      port: 8085,
      variant: 'cuda-12.4',
      hardware: HW_12GB,
      weightsBytes: WEIGHTS_8B_Q4_KM,
      ggufMeta: GGUF_8B,
      settings: { extra_args: ['-lv', '2'] },
    });
    assert.equal(pinned.filter((token) => token === '-lv').length, 1);
    assert.equal(flagValue(pinned, '-lv'), '2');

    const verbose = buildLlamaServerArgs({
      modelPath: '/tmp/model.gguf',
      port: 8085,
      variant: 'cuda-12.4',
      hardware: HW_12GB,
      weightsBytes: WEIGHTS_8B_Q4_KM,
      ggufMeta: GGUF_8B,
      settings: { extra_args: ['-v'] },
    });
    assert.equal(verbose.includes('-lv'), false);
  });

  test('spec decoding emits only the --spec-* spellings', () => {
    const args = buildLlamaServerArgs({
      modelPath: '/tmp/model.gguf',
      port: 8085,
      variant: 'cuda-12.4',
      hardware: HW_12GB,
      weightsBytes: WEIGHTS_8B_Q4_KM,
      ggufMeta: GGUF_8B,
      settings: {
        spec_type: 'draft-simple',
        spec_draft_model: '/tmp/draft.gguf',
        spec_draft_ngl: 16,
        spec_draft_n_max: 5,
        spec_draft_n_min: 1,
        spec_draft_p_min: 0.4,
      },
    });
    assert.equal(flagValue(args, '--spec-type'), 'draft-simple');
    assert.equal(flagValue(args, '--spec-draft-model'), '/tmp/draft.gguf');
    assert.equal(flagValue(args, '--spec-draft-ngl'), '16');
    assert.equal(flagValue(args, '--spec-draft-n-max'), '5');
    assert.equal(flagValue(args, '--spec-draft-n-min'), '1');
    assert.equal(flagValue(args, '--spec-draft-p-min'), '0.4');
  });

  test('draft-mtp needs no draft model, and spec flags vanish when the mode is off', () => {
    const mtp = buildLlamaServerArgs({
      modelPath: '/tmp/model.gguf',
      port: 8085,
      variant: 'cuda-12.4',
      hardware: HW_12GB,
      weightsBytes: WEIGHTS_8B_Q4_KM,
      ggufMeta: GGUF_8B,
      settings: { spec_type: 'draft-mtp', spec_draft_n_max: 3 },
    });
    assert.equal(flagValue(mtp, '--spec-type'), 'draft-mtp');
    assert.equal(mtp.includes('--spec-draft-model'), false);

    // `none` and an unknown mode both emit nothing — an unknown --spec-type aborts
    // the launch before the port binds.
    for (const spec_type of ['none', 'draft-telepathy']) {
      const off = buildLlamaServerArgs({
        modelPath: '/tmp/model.gguf',
        port: 8085,
        variant: 'cuda-12.4',
        hardware: HW_12GB,
        weightsBytes: WEIGHTS_8B_Q4_KM,
        ggufMeta: GGUF_8B,
        settings: { spec_type, spec_draft_n_max: 5 },
      });
      assert.equal(off.includes('--spec-type'), false, spec_type);
      assert.equal(off.includes('--spec-draft-n-max'), false, spec_type);
    }
  });

  test('a spec-decode launch carries its mode onto the plan for failure diagnosis', () => {
    const { plan } = buildLlamaServerLaunch({
      modelPath: '/tmp/model.gguf',
      port: 8085,
      variant: 'cuda-12.4',
      hardware: HW_12GB,
      weightsBytes: WEIGHTS_8B_Q4_KM,
      ggufMeta: GGUF_8B,
      settings: { spec_type: 'draft-eagle3' },
    });
    assert.equal(plan.spec_type, 'draft-eagle3');
    assert.equal(plan.spec_draft_model, undefined);
  });

  test('the resolved per-side KV types are stamped onto the plan for residency sizing', () => {
    const { plan } = buildLlamaServerLaunch({
      modelPath: '/tmp/model.gguf',
      port: 8085,
      variant: 'cuda-12.4',
      hardware: HW_12GB,
      weightsBytes: WEIGHTS_8B_Q4_KM,
      ggufMeta: GGUF_8B,
      settings: { fit_mode: 'manual', ctx: 4096, cache_type: 'q8_0', cache_type_v: 'q4_0', swa_full: true },
    });
    assert.equal(plan.cache_type_k, 'q4_0');
    assert.equal(plan.cache_type_v, 'q4_0');
    assert.equal(plan.swa_full, true);
  });

  test('two inventory GPUs pin --device to the first id until the user opts in', () => {
    const args = buildLlamaServerArgs({
      modelPath: '/tmp/model.gguf',
      port: 8085,
      variant: 'cuda-12.4',
      hardware: { gpuVramGb: 34, availableRamGb: 64, totalRamGb: 128, backend: 'cuda' },
      weightsBytes: WEIGHTS_8B_Q4_KM,
      ggufMeta: GGUF_8B,
      llamaDevices: [
        { id: 'CUDA0', name: 'RTX 4090', memoryMiB: 24576 },
        { id: 'CUDA1', name: 'RTX 3080', memoryMiB: 10240 },
      ],
    });
    assert.equal(flagValue(args, '--device'), 'CUDA0');
    assert.equal(args.indexOf('--split-mode'), -1);
    assert.equal(args.indexOf('--tensor-split'), -1);
  });

  test('user device list emits --device, layer split, and tensor-split in check order', () => {
    const args = buildLlamaServerArgs({
      modelPath: '/tmp/model.gguf',
      port: 8085,
      variant: 'cuda-12.4',
      hardware: { gpuVramGb: 34, availableRamGb: 64, totalRamGb: 128, backend: 'cuda' },
      weightsBytes: WEIGHTS_8B_Q4_KM,
      ggufMeta: GGUF_8B,
      llamaDevices: [
        { id: 'CUDA0', name: 'RTX 4090', memoryMiB: 24576 },
        { id: 'CUDA1', name: 'RTX 3080', memoryMiB: 10240 },
      ],
      settings: {
        device: 'CUDA1,CUDA0',
        split_mode: 'layer',
        tensor_split: '5,5',
      },
    });
    assert.equal(flagValue(args, '--device'), 'CUDA1,CUDA0');
    assert.equal(flagValue(args, '--split-mode'), 'layer');
    assert.equal(flagValue(args, '--tensor-split'), '5,5');
  });

  test('extra_args --device wins over the first-class device field', () => {
    const args = buildLlamaServerArgs({
      modelPath: '/tmp/model.gguf',
      port: 8085,
      variant: 'cuda-12.4',
      hardware: HW_12GB,
      weightsBytes: WEIGHTS_8B_Q4_KM,
      ggufMeta: GGUF_8B,
      llamaDevices: [
        { id: 'CUDA0', name: 'A', memoryMiB: 8192 },
        { id: 'CUDA1', name: 'B', memoryMiB: 8192 },
      ],
      settings: {
        device: 'CUDA0,CUDA1',
        extra_args: ['--device', 'CUDA1'],
      },
    });
    const idxs = args.reduce((acc, token, i) => {
      if (token === '--device') acc.push(i);
      return acc;
    }, []);
    assert.equal(idxs.length, 1);
    assert.equal(args[idxs[0] + 1], 'CUDA1');
  });

  test('tensor split mode forces --fit off', () => {
    const args = buildLlamaServerArgs({
      modelPath: '/tmp/model.gguf',
      port: 8085,
      variant: 'cuda-12.4',
      hardware: { gpuVramGb: 48, availableRamGb: 64, totalRamGb: 128, backend: 'cuda' },
      weightsBytes: WEIGHTS_8B_Q4_KM,
      ggufMeta: GGUF_8B,
      llamaDevices: [
        { id: 'CUDA0', name: 'A', memoryMiB: 24576 },
        { id: 'CUDA1', name: 'B', memoryMiB: 24576 },
      ],
      settings: { device: 'CUDA0,CUDA1', split_mode: 'tensor' },
    });
    assert.equal(flagValue(args, '--split-mode'), 'tensor');
    assert.equal(flagValue(args, '--fit'), 'off');
  });

  test('mismatched tensor-split is omitted with a warning', () => {
    const { args, warning } = buildLlamaServerLaunch({
      modelPath: '/tmp/model.gguf',
      port: 8085,
      variant: 'cuda-12.4',
      hardware: { gpuVramGb: 48, availableRamGb: 64, totalRamGb: 128, backend: 'cuda' },
      weightsBytes: WEIGHTS_8B_Q4_KM,
      ggufMeta: GGUF_8B,
      llamaDevices: [
        { id: 'CUDA0', name: 'A', memoryMiB: 24576 },
        { id: 'CUDA1', name: 'B', memoryMiB: 24576 },
      ],
      settings: { device: 'CUDA0,CUDA1', tensor_split: '3,1,1' },
    });
    assert.equal(args.indexOf('--tensor-split'), -1);
    assert.match(warning, /tensor-split/);
  });
});
