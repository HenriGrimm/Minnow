/**
 * Table-driven llama.cpp failure classifier.
 *
 * Each `log` fixture is a harvested llama.cpp / ggml stderr snippet (b104xx-era
 * wording). Keep the signatures in diagnose-llama-failure.js in lockstep with
 * these strings — they are the contract Phase 3 UI copy keys off.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { diagnoseLlamaFailure } from '../../server/models/diagnose-llama-failure.js';
import { classifyServeExit } from '../../server/models/classify-serve-exit.js';
import { planLlamaLaunch } from '../../src/models/launch-plan.mjs';

/** Llama-like 8B GQA — same fixture as launch-plan tests so OOM replan is quantitative. */
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

const OOM_PLAN = {
  ...planLlamaLaunch({
    geometry: DENSE_8B,
    weightsBytes: 5 * 1024 ** 3,
    trainCtx: 32768,
    hardware: { gpuVramGb: 8, availableRamGb: 32, totalRamGb: 32 },
    variant: 'cuda-12.4',
    parallel: 1,
  }),
  geometry: DENSE_8B,
  weightsBytes: 5 * 1024 ** 3,
  trainCtx: 32768,
  hardware: { gpuVramGb: 8, availableRamGb: 32, totalRamGb: 32 },
  variant: 'cuda-12.4',
  parallel: 1,
  splitCount: 1,
};

/** @type {Array<{ code: string, log: string, exitCode: number | null, retryable: boolean, plan?: object | null }>} */
const FIXTURES = [
  {
    code: 'oom_vram',
    // ggml CUDA path: alloc helper then cudaMalloc (llama.cpp server load).
    log: 'ggml_backend_cuda_buffer_type_alloc_buffer: allocating 2147483648 bytes on device 0: cudaMalloc failed: out of memory',
    exitCode: 1,
    retryable: true,
    plan: OOM_PLAN,
  },
  {
    code: 'oom_vram',
    log: 'ggml_vulkan: Device memory allocation of size 8589934592 failed (VK_ERROR_OUT_OF_DEVICE_MEMORY)',
    exitCode: 1,
    retryable: true,
    plan: OOM_PLAN,
  },
  {
    code: 'oom_ram',
    log: 'libc++abi: terminating due to uncaught exception of type std::bad_alloc: std::bad_alloc',
    exitCode: 1,
    retryable: true,
  },
  {
    code: 'oom_ram',
    log: '',
    // Windows STATUS_STACK_BUFFER_OVERRUN / abort — 0xC0000409.
    exitCode: 3221226505,
    retryable: true,
  },
  {
    code: 'unsupported_arch',
    log: 'error: unknown model architecture: qwen35',
    exitCode: 1,
    retryable: false,
  },
  {
    code: 'unsupported_arch',
    log: 'error: unknown pre-tokenizer type: \'qwen3\'',
    exitCode: 1,
    retryable: false,
  },
  {
    code: 'wrong_runtime_arch',
    log: '',
    // Windows ERROR_EXE_MACHINE_TYPE_MISMATCH — ARM64 PE on AMD64.
    exitCode: 216,
    retryable: false,
  },
  {
    code: 'wrong_runtime_arch',
    log: 'Installed llama-server.exe is arm64, but this Minnow host is x64. Reinstall llama.cpp from Models → Engine.',
    exitCode: 1,
    retryable: false,
  },
  {
    code: 'missing_runtime_lib',
    log: '',
    // Windows STATUS_DLL_NOT_FOUND — 0xC0000135.
    exitCode: 3221225781,
    retryable: false,
  },
  {
    code: 'missing_runtime_lib',
    log: 'The code execution cannot proceed because cudart64_12.dll was not found. Reinstalling the program may fix this problem.',
    exitCode: 1,
    retryable: false,
  },
  {
    code: 'missing_runtime_lib',
    log: 'error while loading shared libraries: libcuda.so.1: cannot open shared object file',
    exitCode: 127,
    retryable: false,
  },
  {
    code: 'port_conflict',
    log: 'error binding to 127.0.0.1:8085: EADDRINUSE',
    exitCode: 1,
    retryable: true,
  },
  {
    code: 'port_conflict',
    log: 'Only one usage of each socket address (protocol/network address/port) is normally permitted.',
    exitCode: 1,
    retryable: true,
  },
  {
    code: 'bad_template',
    log: 'minja error: Failed to parse chat template: unexpected token',
    exitCode: 1,
    retryable: true,
  },
  {
    code: 'corrupt_gguf',
    log: 'gguf_init_from_file: invalid magic characters \'GGUF\', got \'XXXX\'',
    exitCode: 1,
    retryable: false,
  },
  {
    code: 'corrupt_gguf',
    log: 'llama_model_load: error loading model: gguf_init_from_file failed',
    exitCode: 1,
    retryable: false,
  },
  {
    code: 'corrupt_gguf',
    log: 'llama_model_load: wrong number of tensors; expected 291, got 12',
    exitCode: 1,
    retryable: false,
    plan: { splitCount: 5 },
  },
  {
    code: 'mmap_failed',
    log: 'llama_mmap: failed to mmap file: mmap failed: Cannot allocate memory',
    exitCode: 1,
    retryable: true,
  },
  {
    code: 'mmap_failed',
    log: 'llama_model_load: failed to open file \'model.gguf\'',
    exitCode: 1,
    retryable: true,
  },
  {
    code: 'killed_by_os',
    log: '',
    exitCode: 137,
    retryable: true,
  },
  {
    code: 'unknown',
    log: 'srv    load: model loaded',
    exitCode: 1,
    retryable: true,
  },
];

describe('diagnoseLlamaFailure', () => {
  for (const fixture of FIXTURES) {
    const name = `${fixture.code} ← ${fixture.log.slice(0, 48) || `exit ${fixture.exitCode}`}`;
    test(name, () => {
      const result = diagnoseLlamaFailure(fixture.log, fixture.exitCode, fixture.plan ?? null);
      assert.equal(result.code, fixture.code);
      assert.equal(result.retryable, fixture.retryable);
      assert.ok(result.title);
      assert.ok(result.remediation);
    });
  }

  test('oom_vram with plan attaches suggestedSettings (ctx + cache_type)', () => {
    const result = diagnoseLlamaFailure('cudaMalloc failed: out of memory', 1, OOM_PLAN);
    assert.equal(result.code, 'oom_vram');
    assert.ok(result.suggestedSettings, 'expected a quantitative retry payload');
    assert.equal(result.suggestedSettings.fit_mode, 'manual');
    assert.equal(typeof result.suggestedSettings.ctx, 'number');
    assert.ok(result.suggestedSettings.ctx > 0);
    assert.ok(['f16', 'q8_0', 'q4_0'].includes(String(result.suggestedSettings.cache_type)));
  });

  test('oom_vram without plan has no suggestedSettings', () => {
    const result = diagnoseLlamaFailure('cudaMalloc failed: out of memory', 1, null);
    assert.equal(result.code, 'oom_vram');
    assert.equal(result.suggestedSettings, undefined);
  });

  test('corrupt_gguf with splitCount > 1 mentions missing shards', () => {
    const result = diagnoseLlamaFailure(
      'gguf_init_from_file failed',
      1,
      { splitCount: 5 },
    );
    assert.equal(result.code, 'corrupt_gguf');
    assert.match(result.detail, /split/i);
    assert.match(result.remediation, /shard/i);
  });

  test('mmap_failed suggests --no-mmap', () => {
    const result = diagnoseLlamaFailure('mmap failed', 1, null);
    assert.deepEqual(result.suggestedSettings, { extra_args: ['--no-mmap'] });
  });

  test('bad_template surfaces first-class chat-template fields without inventing a template', () => {
    const result = diagnoseLlamaFailure('Failed to parse chat template', 1, null);
    assert.equal(result.code, 'bad_template');
    assert.deepEqual(result.chatTemplateFields, ['chat_template', 'chat_template_file']);
    assert.equal(result.suggestedSettings, undefined);
    assert.match(result.remediation, /--chat-template/);
    assert.match(result.remediation, /chat_template_file/);
  });

  test('signed Windows 0xC0000409 still maps to oom_ram', () => {
    // Node may report NTSTATUS as a signed int32.
    const signed = 0xc0000409 << 0;
    const result = diagnoseLlamaFailure('', signed, null);
    assert.equal(result.code, 'oom_ram');
  });

  test('classifyServeExit wrapper returns oom_vram for cudaMalloc unless overridden', () => {
    const classified = classifyServeExit({
      exitCode: 1,
      logTail: 'cudaMalloc failed: out of memory',
      plan: OOM_PLAN,
    });
    assert.equal(classified.code, 'oom_vram');
  });

  test('a draft-model mode with no draft model is named, not left as unknown', () => {
    // b9628 registers the speculative implementation and then segfaults with nothing
    // in the log, so this can only be matched on the launch settings.
    const log = [
      "common_speculative_impl_draft_simple: adding speculative implementation 'draft-simple'",
      'common_speculative_impl_draft_simple: - n_max=3, n_min=0, p_min=0.000000',
    ].join('\n');
    const result = diagnoseLlamaFailure(log, 139, { spec_type: 'draft-simple' });
    assert.equal(result.code, 'spec_missing_draft_model');
    assert.equal(result.retryable, false);
    assert.equal(result.suggestedSettings.spec_type, 'none');
  });

  test('spec_missing_draft_model does not fire when a draft model is set, or for MTP', () => {
    assert.equal(
      diagnoseLlamaFailure('', 139, {
        spec_type: 'draft-simple',
        spec_draft_model: '/tmp/draft.gguf',
      }).code,
      'unknown',
    );
    assert.equal(diagnoseLlamaFailure('', 139, { spec_type: 'draft-mtp' }).code, 'unknown');
  });

  test('a real OOM signature still wins over the spec-decode settings rule', () => {
    const result = diagnoseLlamaFailure('cudaMalloc failed: out of memory', 1, {
      ...OOM_PLAN,
      spec_type: 'draft-simple',
    });
    assert.equal(result.code, 'oom_vram');
  });

  test('unknown detail is the 280-char grepped excerpt', () => {
    const log = 'fatal: something obscure broke in ggml\nerror: not a classified signature';
    const result = diagnoseLlamaFailure(log, 1, null);
    assert.equal(result.code, 'unknown');
    assert.match(result.detail, /fatal: something obscure/);
  });
});
