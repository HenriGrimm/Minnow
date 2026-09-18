/**
 * Per-library-model launch prefs in config.json.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import {
  getLaunchPrefs,
  llamaSettingsFromLaunchRow,
  mergeLaunchSettings,
  normalizeLaunchBlock,
  recordLaunchLoadPrior,
  setLibraryLaunchSettings,
  LAUNCH_SETTING_KEYS,
} from '../../server/models/launch-prefs.js';

const LIB_GGUF = 'gguf:11111111-1111-1111-1111-111111111111';
const LIB_DEMO = 'lib-demo-8b';

describe('models launch prefs', () => {
  /** @type {string} */
  let homeDir;

  before(async () => {
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-launch-prefs-'));
    process.env.MINNOW_HOME = homeDir;
    resetMinnowHomeCache();
    await fs.mkdir(path.join(homeDir, 'config'), { recursive: true });
    await fs.writeFile(
      path.join(homeDir, 'config.json'),
      `${JSON.stringify({ models: {} })}\n`,
    );
  });

  after(async () => {
    delete process.env.MINNOW_HOME;
    resetMinnowHomeCache();
    await fs.rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  test('normalizeLaunchBlock drops unknown keys', () => {
    const out = normalizeLaunchBlock({
      byLibraryId: {
        [LIB_DEMO]: {
          fit_mode: 'manual',
          ctx: 8192,
          n_gpu_layers: 12,
          cache_type: 'q8_0',
          unknownFlag: true,
          nested: { nope: 1 },
        },
      },
    });
    assert.equal(out.byLibraryId[LIB_DEMO].fit_mode, 'manual');
    assert.equal(out.byLibraryId[LIB_DEMO].ctx, 8192);
    assert.equal(out.byLibraryId[LIB_DEMO].n_gpu_layers, 12);
    assert.equal(out.byLibraryId[LIB_DEMO].cache_type, 'q8_0');
    assert.equal(out.byLibraryId[LIB_DEMO].unknownFlag, undefined);
    assert.equal(out.byLibraryId[LIB_DEMO].nested, undefined);
    assert.equal(LAUNCH_SETTING_KEYS.includes('fit_mode'), true);
    assert.equal(LAUNCH_SETTING_KEYS.includes('chat_template'), true);
    assert.equal(LAUNCH_SETTING_KEYS.includes('chat_template_file'), true);
    assert.equal(LAUNCH_SETTING_KEYS.includes('no_mmap'), true);
    assert.equal(LAUNCH_SETTING_KEYS.includes('mlock'), true);
    assert.equal(LAUNCH_SETTING_KEYS.includes('device'), true);
    assert.equal(LAUNCH_SETTING_KEYS.includes('split_mode'), true);
    assert.equal(LAUNCH_SETTING_KEYS.includes('tensor_split'), true);
    assert.equal(LAUNCH_SETTING_KEYS.includes('unknownFlag'), false);
  });

  test('setLibraryLaunchSettings persists and clears', async () => {
    let prefs = await setLibraryLaunchSettings(LIB_GGUF, {
      fit_mode: 'manual',
      ctx: 4096,
      n_gpu_layers: 8,
      cache_type: 'f16',
      parallel: 2,
    });
    assert.equal(prefs.byLibraryId[LIB_GGUF].ctx, 4096);
    assert.equal(prefs.byLibraryId[LIB_GGUF].n_gpu_layers, 8);
    assert.equal(prefs.byLibraryId[LIB_GGUF].parallel, 2);

    prefs = await getLaunchPrefs();
    assert.equal(prefs.byLibraryId[LIB_GGUF].fit_mode, 'manual');

    prefs = await setLibraryLaunchSettings(LIB_GGUF, null);
    assert.equal(prefs.byLibraryId[LIB_GGUF], undefined);
  });

  test('persists device split fields', async () => {
    const prefs = await setLibraryLaunchSettings(LIB_DEMO, {
      device: 'CUDA1,CUDA0',
      split_mode: 'layer',
      tensor_split: '5,5',
    });
    assert.equal(prefs.byLibraryId[LIB_DEMO].device, 'CUDA1,CUDA0');
    assert.equal(prefs.byLibraryId[LIB_DEMO].split_mode, 'layer');
    assert.equal(prefs.byLibraryId[LIB_DEMO].tensor_split, '5,5');
    const roundTrip = llamaSettingsFromLaunchRow(prefs.byLibraryId[LIB_DEMO]);
    assert.equal(roundTrip.device, 'CUDA1,CUDA0');
  });

  test('empty object deletes the row', async () => {
    await setLibraryLaunchSettings(LIB_DEMO, { fit_mode: 'auto', parallel: 4 });
    const prefs = await setLibraryLaunchSettings(LIB_DEMO, {});
    assert.equal(prefs.byLibraryId[LIB_DEMO], undefined);
  });

  test('slider save preserves lastLoadMs', async () => {
    await setLibraryLaunchSettings(LIB_DEMO, {
      fit_mode: 'manual',
      ctx: 8192,
      lastLoadMs: 12000,
      lastWeightsBytes: 4_000_000_000,
    });
    const prefs = await setLibraryLaunchSettings(LIB_DEMO, {
      fit_mode: 'manual',
      ctx: 16384,
      n_gpu_layers: 16,
    });
    assert.equal(prefs.byLibraryId[LIB_DEMO].ctx, 16384);
    assert.equal(prefs.byLibraryId[LIB_DEMO].n_gpu_layers, 16);
    assert.equal(prefs.byLibraryId[LIB_DEMO].lastLoadMs, 12000);
    assert.equal(prefs.byLibraryId[LIB_DEMO].lastWeightsBytes, 4_000_000_000);
  });

  test('recordLaunchLoadPrior writes progress onto an empty row', async () => {
    await setLibraryLaunchSettings(LIB_GGUF, null);
    const prefs = await recordLaunchLoadPrior(LIB_GGUF, {
      lastLoadMs: 4500,
      lastWeightsBytes: 2048,
    });
    assert.equal(prefs.byLibraryId[LIB_GGUF].lastLoadMs, 4500);
    assert.equal(prefs.byLibraryId[LIB_GGUF].lastWeightsBytes, 2048);
    assert.equal(llamaSettingsFromLaunchRow(prefs.byLibraryId[LIB_GGUF]), undefined);
  });

  test('mergeLaunchSettings later layer wins and strips progress', () => {
    const merged = mergeLaunchSettings(
      { fit_mode: 'auto', ctx: 4096, lastLoadMs: 99 },
      { fit_mode: 'manual', ctx: 8192, n_gpu_layers: 12 },
    );
    assert.equal(merged.fit_mode, 'manual');
    assert.equal(merged.ctx, 8192);
    assert.equal(merged.n_gpu_layers, 12);
    assert.equal(merged.lastLoadMs, undefined);
  });

  test('chat_template and quoted extra_args persist through normalize', async () => {
    const prefs = await setLibraryLaunchSettings('lib-chat-template', {
      chat_template: 'hello world',
      chat_template_file: '/tmp/template.jinja',
      no_mmap: true,
      no_mmproj: true,
      mlock: false,
      extra_args: ['--chat-template', '"hello', 'world"'],
    });
    const row = prefs.byLibraryId['lib-chat-template'];
    assert.equal(row.chat_template, 'hello world');
    assert.equal(row.chat_template_file, '/tmp/template.jinja');
    assert.equal(row.no_mmap, true);
    assert.equal(row.no_mmproj, true);
    assert.equal(row.mlock, false);
    assert.deepEqual(row.extra_args, ['--chat-template', 'hello world']);
  });

  test('LM Studio parity settings survive normalize; bad values are dropped', async () => {
    const prefs = await setLibraryLaunchSettings('lib-parity', {
      threads: 12,
      kv_unified: true,
      kv_offload: false,
      ctx_checkpoints: 8,
      context_shift: true,
      swa_full: true,
      rope_freq_base: 1_000_000,
      rope_freq_scale: 0.5,
      seed: -1,
      flash_attn: 'off',
      cache_type_k: 'Q8_0',
      cache_type_v: 'not-a-type',
      reasoning_budget_message: '  wrap it up  ',
      idle_ttl_ms: 0,
      n_cpu_moe: 4,
    });
    const row = prefs.byLibraryId['lib-parity'];
    assert.equal(row.threads, 12);
    assert.equal(row.kv_unified, true);
    assert.equal(row.kv_offload, false);
    assert.equal(row.ctx_checkpoints, 8);
    assert.equal(row.context_shift, true);
    assert.equal(row.swa_full, true);
    assert.equal(row.rope_freq_base, 1_000_000);
    assert.equal(row.rope_freq_scale, 0.5);
    assert.equal(row.seed, -1);
    assert.equal(row.flash_attn, 'off');
    // Case-folded onto the ggml type name; an unknown type never reaches argv.
    assert.equal(row.cache_type_k, 'q8_0');
    assert.equal(row.cache_type_v, undefined);
    assert.equal(row.reasoning_budget_message, 'wrap it up');
    assert.equal(row.idle_ttl_ms, 0);
    assert.equal(row.n_cpu_moe, 4);
  });

  test('out-of-range parity values are dropped rather than stored', async () => {
    const prefs = await setLibraryLaunchSettings('lib-parity-bad', {
      ctx: 4096,
      threads: 0,
      seed: -5,
      rope_freq_base: -1,
      rope_freq_scale: 0,
      ctx_checkpoints: -2,
      idle_ttl_ms: -1,
      flash_attn: 'sometimes',
    });
    const row = prefs.byLibraryId['lib-parity-bad'];
    assert.equal(row.ctx, 4096);
    assert.equal(row.threads, undefined);
    assert.equal(row.seed, undefined);
    assert.equal(row.rope_freq_base, undefined);
    assert.equal(row.rope_freq_scale, undefined);
    assert.equal(row.ctx_checkpoints, undefined);
    assert.equal(row.idle_ttl_ms, undefined);
    assert.equal(row.flash_attn, undefined);
  });
});
