/**
 * Hugging Face search — DTO mapping, the VLM filter, and the platform gate.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import {
  mapHubRow,
  resetHfSearchForTests,
  searchHubModels,
  setHfSearchFetchForTests,
} from '../../server/models/hf-search.js';
import { isMlxSupported } from '../../server/servers/mlx-lm.js';

/** @param {object[]} rows */
function stubHub(rows) {
  /** @type {string[]} */
  const calls = [];
  setHfSearchFetchForTests(async (url) => {
    calls.push(String(url));
    return { ok: true, status: 200, json: async () => rows };
  });
  return calls;
}

const MLX_4BIT = {
  id: 'mlx-community/Qwen3-8B-4bit',
  pipeline_tag: 'text-generation',
  downloads: 12_000,
  likes: 40,
  gated: false,
  config: {
    model_type: 'qwen3',
    architectures: ['Qwen3ForCausalLM'],
    quantization_config: { bits: 4 },
    chat_template_jinja: '{% if tools %}...{% endif %}',
  },
  safetensors: { parameters: { BF16: 256_259_072, U32: 1_023_803_392 }, total: 1_280_062_464 },
};

const VLM_ROW = {
  id: 'mlx-community/Qwen2-VL-7B-4bit',
  pipeline_tag: 'image-text-to-text',
  downloads: 99_999,
  config: { model_type: 'qwen2_vl', quantization_config: { bits: 4 } },
  safetensors: { parameters: { U32: 1_000_000 }, total: 1_000_000 },
};

describe('Hugging Face search', () => {
  afterEach(() => {
    resetHfSearchForTests();
  });

  // These map an MLX row directly rather than going through searchHubModels,
  // so the field-shape assertions still run on the Linux/Windows machines that
  // refuse MLX search outright.
  test('reads the quant width out of quantization_config', () => {
    const row = mapHubRow(MLX_4BIT, 'mlx');
    assert.equal(row.quant, 'mlx-4bit');
    assert.equal(row.arch, 'qwen3');
    assert.equal(row.toolCapable, true);
  });

  test('sizes a repo from dtype widths, not the misleading safetensors total', () => {
    const row = mapHubRow(MLX_4BIT, 'mlx');
    // `total` (1_280_062_464) is a count of stored elements, not bytes — using
    // it would advertise a 4.3 GB download as 1.2 GB.
    const expected = 256_259_072 * 2 + 1_023_803_392 * 4;
    assert.equal(row.sizeBytes, expected);
    assert.notEqual(row.sizeBytes, MLX_4BIT.safetensors.total);
  });

  test('takes params from the name, since packed weights understate them', () => {
    // Element count / 1e9 would say 1.28B for what is an 8B model.
    assert.equal(mapHubRow(MLX_4BIT, 'mlx').paramsB, 8);
  });

  test('drops vision models from MLX search, which belong to mlx-vlm', async () => {
    if (!isMlxSupported()) return; // MLX search is refused outright off Apple Silicon
    stubHub([VLM_ROW, MLX_4BIT]);
    const { results } = await searchHubModels({ query: 'qwen', format: 'mlx' });
    assert.deepEqual(
      results.map((r) => r.repoId),
      [MLX_4BIT.id],
      'a VLM download that can only fail at load in mlx-lm must never be offered',
    );
  });

  test('GGUF search keeps multimodal and untagged repos but drops non-chat pipelines', async () => {
    stubHub([
      { ...VLM_ROW, id: 'unsloth/gemma-4-12b-it-GGUF' },
      { id: 'ggml-org/gemma-4-E4B-it-GGUF', pipeline_tag: 'any-to-any' },
      { id: 'lmstudio-community/gemma-4-E4B-it-GGUF' },
      { id: 'someorg/embed-GGUF', pipeline_tag: 'feature-extraction' },
      { id: 'someorg/whisper-GGUF', pipeline_tag: 'automatic-speech-recognition' },
    ]);
    const { results } = await searchHubModels({ query: 'gemma-4', format: 'gguf' });
    assert.deepEqual(
      results.map((r) => r.repoId),
      [
        'unsloth/gemma-4-12b-it-GGUF',
        'ggml-org/gemma-4-E4B-it-GGUF',
        'lmstudio-community/gemma-4-E4B-it-GGUF',
      ],
    );
  });

  test('MLX search returns mapped rows when the platform allows it', async () => {
    if (!isMlxSupported()) return; // covered by the platform-gate test below
    stubHub([MLX_4BIT]);
    const { results } = await searchHubModels({ query: 'qwen', format: 'mlx' });
    assert.equal(results[0].quant, 'mlx-4bit');
  });

  test('refuses MLX entirely when the platform cannot run it', async () => {
    stubHub([MLX_4BIT]);
    const { results, reason } = await searchHubModels({ query: 'qwen', format: 'mlx' });
    if (isMlxSupported()) {
      assert.equal(reason, null);
      assert.ok(results.length > 0);
      return;
    }
    assert.deepEqual(results, []);
    assert.match(reason ?? '', /Apple Silicon/);
  });

  test('GGUF search works on every platform', async () => {
    const calls = stubHub([
      {
        id: 'unsloth/Qwen3-8B-GGUF',
        pipeline_tag: 'text-generation',
        downloads: 311_381,
        gated: false,
        config: { model_type: 'qwen3' },
      },
    ]);
    const { results } = await searchHubModels({ query: 'qwen3', format: 'gguf' });
    assert.equal(results[0].repoId, 'unsloth/Qwen3-8B-GGUF');
    assert.equal(results[0].format, 'gguf');
    assert.equal(results[0].paramsB, 8);
    // GGUF repos carry no safetensors block, so size is genuinely unknown here.
    assert.equal(results[0].sizeBytes, null);
    assert.match(calls[0], /filter=gguf/);
    // The Hub's single-tag pipeline filter would hide most official GGUF builds.
    assert.doesNotMatch(calls[0], /filter=text-generation/);
  });

  test('skips ids that would fail the download-path validator', async () => {
    const calls = stubHub([
      { id: '../../etc/passwd', pipeline_tag: 'text-generation' },
      { id: 'no-slash-here', pipeline_tag: 'text-generation' },
      { id: 'unsloth/Qwen3-8B-GGUF', pipeline_tag: 'text-generation' },
    ]);
    const { results } = await searchHubModels({ query: 'x', format: 'gguf' });
    assert.deepEqual(
      results.map((r) => r.repoId),
      ['unsloth/Qwen3-8B-GGUF'],
    );
    assert.ok(calls.length === 1);
  });

  test('marks gated repos so the card can ask for a token first', async () => {
    stubHub([
      {
        id: 'meta-llama/Llama-3-8B-GGUF',
        pipeline_tag: 'text-generation',
        // The Hub returns false | "auto" | "manual".
        gated: 'manual',
        config: { model_type: 'llama' },
      },
    ]);
    const { results } = await searchHubModels({ query: 'llama', format: 'gguf' });
    assert.equal(results[0].gated, true);
  });

  test('surfaces an upstream failure instead of an empty list', async () => {
    setHfSearchFetchForTests(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    await assert.rejects(() => searchHubModels({ query: 'qwen3', format: 'gguf' }), /503/);
  });

  test('caches repeated queries instead of re-hitting the Hub', async () => {
    const calls = stubHub([
      { id: 'unsloth/Qwen3-8B-GGUF', pipeline_tag: 'text-generation', config: {} },
    ]);
    await searchHubModels({ query: 'cache-me', format: 'gguf' });
    await searchHubModels({ query: 'cache-me', format: 'gguf' });
    assert.equal(calls.length, 1, 'debounced typing should not re-request the same key');
  });

  test('pagination retains filters and owner/repository searches narrow by author', async () => {
    const calls = [];
    setHfSearchFetchForTests(async (url) => {
      calls.push(new URL(url));
      return new Response(JSON.stringify([{ id: 'Qwen/Qwen3-4B-GGUF', pipeline_tag: 'text-generation' }]), {
        headers: { link: '<https://huggingface.co/api/models?cursor=page2>; rel="next"' },
      });
    });
    const first = await searchHubModels({ query: 'Qwen/Qwen3-4B-GGUF', format: 'gguf' });
    await searchHubModels({ query: 'Qwen/Qwen3-4B-GGUF', format: 'gguf', cursor: first.nextCursor });
    assert.equal(calls[0].searchParams.get('author'), 'Qwen');
    assert.equal(calls[0].searchParams.get('search'), 'Qwen3-4B-GGUF');
    assert.equal(calls[1].searchParams.get('cursor'), 'page2');
    assert.ok(calls[1].searchParams.getAll('filter').includes('gguf'));
  });
});
