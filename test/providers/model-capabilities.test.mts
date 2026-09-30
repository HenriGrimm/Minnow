/**
 * Client merge: catalog vs probe precedence.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  applyProviderCapabilities,
  catalogCapabilitiesFromRow,
  catalogRowHasVision,
  mergeModelCapabilities,
  prioritizeModelIdsForProbe,
  resolveSendCapabilities,
} from '../../src/providers/model-capabilities.ts';
import { modelCache } from '../../src/app-state.ts';
import { encodeModelSelectKey } from '../../src/lib/model-select-key.ts';

describe('mergeModelCapabilities', () => {
  test('catalog vision wins for vlm over probe false', () => {
    const row = { id: 'x', type: 'vlm', max_context_length: 32768 };
    const merged = mergeModelCapabilities(row, {
      vision: false,
      tools: true,
      streaming: true,
      grammar: null,
      reasoning: null,
      contextLength: null,
      loadState: null,
      sources: { vision: 'catalog', tools: 'probe' },
      probeErrors: {},
    });
    assert.equal(merged.vision, true);
    assert.equal(merged.tools, true);
    assert.equal(merged.contextLength, 32768);
  });

  test('probe fills tools when catalog unknown', () => {
    const row = { id: 'y', type: 'llm' };
    const merged = mergeModelCapabilities(row, {
      vision: false,
      tools: true,
      streaming: true,
      grammar: null,
      reasoning: null,
      contextLength: null,
      loadState: 'loaded',
      sources: { tools: 'probe', streaming: 'probe' },
      probeErrors: {},
    });
    assert.equal(merged.tools, true);
    assert.equal(merged.streaming, true);
  });
});

describe('catalogCapabilitiesFromRow', () => {
  test('DeepSeek V4 uses provider binary options without inventing levels', () => {
    const caps = catalogCapabilitiesFromRow({
      id: 'deepseek-v4-pro',
      type: 'llm',
      reasoning: { allowed_options: ['off', 'on'], default: 'on' },
    }, 'openai-v1');
    assert.deepEqual(caps.reasoningAllowedOptions, ['off', 'on']);
    assert.equal(caps.reasoningDefault, 'on');
  });

  test('Muse and other OpenAI-compatible rows do not invent effort levels', () => {
    const muse = catalogCapabilitiesFromRow({ id: 'muse-spark-1.3', type: 'llm' }, 'openai-v1');
    assert.equal(muse.reasoningAllowedOptions, undefined);
    const announced = catalogCapabilitiesFromRow({
      id: 'muse-spark-1.3', type: 'llm',
      reasoning: { allowed_options: ['off', 'medium', 'high'], default: 'medium' },
    }, 'openai-v1');
    assert.deepEqual(announced.reasoningAllowedOptions, ['off', 'medium', 'high']);
    assert.equal(announced.reasoningDefault, 'medium');
  });

  test('provider catalog levels are retained for other models', () => {
    const caps = catalogCapabilitiesFromRow({
      id: 'vendor/new-reasoner',
      type: 'llm',
      reasoning: { allowed_options: ['none', 'low', 'max'], default: 'max' },
    }, 'openai-v1');
    assert.deepEqual(caps.reasoningAllowedOptions, ['off', 'low', 'max']);
    assert.equal(caps.reasoningDefault, 'max');
  });
  test('marks vlm as vision', () => {
    const caps = catalogCapabilitiesFromRow({ id: 'v', type: 'vlm' });
    assert.equal(caps.vision, true);
  });

  test('marks catalogVision on llm type as vision', () => {
    const caps = catalogCapabilitiesFromRow({
      id: 'qwen',
      type: 'llm',
      catalogVision: true,
    });
    assert.equal(caps.vision, true);
    assert.equal(catalogRowHasVision({ id: 'qwen', type: 'llm', catalogVision: true }), true);
  });

  test('Qwen3.8 defaults thinking on at high (wire xhigh)', () => {
    const caps = catalogCapabilitiesFromRow(
      { id: 'qwen/qwen3.8-27b', type: 'vlm' },
      'openai-v1',
    );
    assert.deepEqual(caps.reasoningAllowedOptions, ['off', 'low', 'medium', 'high']);
    assert.equal(caps.reasoningDefault, 'high');
  });

  test('Qwen3.8 infers levels without apiKind (My Models / llama.cpp rows)', () => {
    const caps = catalogCapabilitiesFromRow({
      id: 'gguf:unsloth/Qwen3.8-27B-GGUF:Qwen3.8-27B-Q4_K_M.gguf',
      type: 'llm',
    });
    assert.deepEqual(caps.reasoningAllowedOptions, ['off', 'low', 'medium', 'high']);
    assert.equal(caps.reasoningDefault, 'high');
  });

  test('Qwen3.8 upgrades LM Studio off/on catalog to effort levels', () => {
    const caps = catalogCapabilitiesFromRow(
      {
        id: 'qwen/qwen3.8-27b',
        type: 'vlm',
        reasoning: { allowed_options: ['off', 'on'], default: 'on' },
      },
      'lm-studio-v0',
    );
    assert.deepEqual(caps.reasoningAllowedOptions, ['off', 'low', 'medium', 'high']);
    assert.equal(caps.reasoningDefault, 'high');
  });

  test('preserves LM Studio xhigh catalog option and default', () => {
    const caps = catalogCapabilitiesFromRow({
      id: 'qwen/qwen3.8-27b',
      type: 'vlm',
      reasoning: {
        allowed_options: ['xhigh', 'medium', 'low', 'off'],
        default: 'xhigh',
      },
    });
    assert.deepEqual(caps.reasoningAllowedOptions, ['off', 'low', 'medium', 'high', 'xhigh']);
    assert.equal(caps.reasoningDefault, 'xhigh');
  });

  test('GLM-5.3 defaults thinking on at max (no off / medium)', () => {
    const caps = catalogCapabilitiesFromRow(
      { id: 'glm-5.3-flash', type: 'llm' },
      'openai-v1',
    );
    assert.deepEqual(caps.reasoningAllowedOptions, ['low', 'high', 'max']);
    assert.equal(caps.reasoningDefault, 'max');
  });

  test('GLM-5.3 infers levels without apiKind (My Models / llama.cpp rows)', () => {
    const caps = catalogCapabilitiesFromRow({
      id: 'GLM-5.3-Flash-GGUF',
      type: 'llm',
    });
    assert.deepEqual(caps.reasoningAllowedOptions, ['low', 'high', 'max']);
    assert.equal(caps.reasoningDefault, 'max');
  });

  test('GLM-5.3 upgrades off/on and low/medium/high catalogs to Low/High/Max', () => {
    const caps = catalogCapabilitiesFromRow(
      {
        id: 'z-ai/glm-5.3-flash',
        type: 'llm',
        reasoning: { allowed_options: ['off', 'low', 'medium', 'high'], default: 'medium' },
      },
      'openai-v1',
    );
    assert.deepEqual(caps.reasoningAllowedOptions, ['low', 'high', 'max']);
    assert.equal(caps.reasoningDefault, 'max');
  });
});

describe('prioritizeModelIdsForProbe', () => {
  test('respects loaded cache state', () => {
    modelCache.clear();
    modelCache.set('loaded-one', { id: 'loaded-one', state: 'loaded' });
    modelCache.set('other', { id: 'other', state: 'not loaded' });
    const out = prioritizeModelIdsForProbe(
      ['other', 'loaded-one', 'zzz'],
      'zzz',
    );
    assert.equal(out[0], 'zzz');
    assert.equal(out[1], 'loaded-one');
  });
});

describe('applyProviderCapabilities', () => {
  test('stamps llama-cpp-local probe vision onto the matching My Models row', () => {
    modelCache.clear();
    const libraryId = 'gguf:org/gemma-3:gemma-3-12b-it.gguf';
    modelCache.set(encodeModelSelectKey('minnow-library', libraryId), {
      id: libraryId,
      type: 'llm',
      state: 'loaded',
    });
    applyProviderCapabilities({
      schemaVersion: 1,
      providerId: 'llama-cpp-local',
      probedAt: '2026-08-27T00:00:00.000Z',
      apiKind: 'openai-v1',
      models: {
        [libraryId]: {
          vision: true,
          tools: true,
          streaming: true,
          grammar: null,
          reasoning: null,
          contextLength: null,
          loadState: 'loaded',
          sources: { vision: 'probe', tools: 'probe', streaming: 'probe' },
          probeErrors: {},
        },
      },
    });
    const row = modelCache.get(encodeModelSelectKey('minnow-library', libraryId));
    assert.equal(row?.capabilities?.vision, true);
    assert.equal(row?.capabilities?.sources?.vision, 'probe');
  });
});

describe('resolveSendCapabilities', () => {
  test('Muse catalog restores all effort levels over a stale negative probe', () => {
    modelCache.clear();
    const modelId = 'muse-spark-1.3-contributor';
    modelCache.set(encodeModelSelectKey('opencode-go', modelId), {
      id: modelId,
      reasoning: { allowed_options: ['minimal', 'low', 'medium', 'high', 'xhigh'], default: 'medium' },
      capabilities: {
        vision: null, tools: null, streaming: null, grammar: null, reasoning: false,
        reasoningAllowedOptions: ['on'], reasoningDefault: 'on',
        contextLength: null, loadState: 'loaded',
      },
    });
    const caps = resolveSendCapabilities('opencode-go', modelId, 'openai-v1');
    assert.equal(caps?.reasoning, true);
    assert.deepEqual(caps?.reasoningAllowedOptions, ['minimal', 'low', 'medium', 'high', 'xhigh']);
    assert.equal(caps?.reasoningDefault, 'medium');
  });

  test('preserves positively probed effort levels when a models list omits controls', () => {
    modelCache.clear();
    const modelId = 'custom-reasoner';
    modelCache.set(encodeModelSelectKey('custom', modelId), {
      id: modelId,
      capabilities: {
        vision: null, tools: null, streaming: null, grammar: null, reasoning: true,
        reasoningAllowedOptions: ['low', 'high'], reasoningDefault: 'high',
        sources: { reasoning: 'probe' }, contextLength: null, loadState: 'loaded',
      },
    });
    const caps = resolveSendCapabilities('custom', modelId, 'openai-v1');
    assert.deepEqual(caps?.reasoningAllowedOptions, ['low', 'high']);
    assert.equal(caps?.reasoningDefault, 'high');
  });
  test('DeepSeek V4 waits for provider options and drops stale guessed levels', () => {
    modelCache.clear();
    const assumed = resolveSendCapabilities('deepseek', 'deepseek-flash');
    assert.equal(assumed, undefined);
    modelCache.set(encodeModelSelectKey('deepseek', 'deepseek-flash'), {
      id: 'deepseek-flash', type: 'llm',
      capabilities: {
        vision: null, tools: null, streaming: null, grammar: null, reasoning: true,
        reasoningAllowedOptions: ['off', 'on'], reasoningDefault: 'on',
        contextLength: null, loadState: 'loaded',
      },
    });
    const merged = resolveSendCapabilities('deepseek', 'deepseek-flash', 'openai-v1');
    assert.equal(merged?.reasoningAllowedOptions, undefined);
    assert.equal(merged?.reasoningDefault, undefined);
  });

  test('provider levels override old cached guesses exactly', () => {
    modelCache.clear();
    const modelId = 'deepseek-v4-pro';
    modelCache.set(encodeModelSelectKey('deepseek', modelId), {
      id: modelId, type: 'llm',
      reasoning: { allowed_options: ['off', 'medium', 'high'], default: 'medium' },
      capabilities: {
        vision: null, tools: null, streaming: null, grammar: null, reasoning: true,
        reasoningAllowedOptions: ['off', 'low', 'high', 'max'], reasoningDefault: 'high',
        contextLength: null, loadState: 'loaded',
      },
    });
    const resolved = resolveSendCapabilities('deepseek', modelId, 'openai-v1');
    assert.deepEqual(resolved?.reasoningAllowedOptions, ['off', 'medium', 'high']);
    assert.equal(resolved?.reasoningDefault, 'medium');
  });
  test('Qwen3.8 library row without capabilities still exposes levels', () => {
    modelCache.clear();
    const modelId = 'gguf:unsloth/Qwen3.8-27B-GGUF:Qwen3.8-27B-Q4_K_M.gguf';
    modelCache.set(encodeModelSelectKey('minnow-library', modelId), {
      id: modelId,
      type: 'llm',
    });
    const caps = resolveSendCapabilities('minnow-library', modelId);
    assert.deepEqual(caps?.reasoningAllowedOptions, ['off', 'low', 'medium', 'high']);
    assert.equal(caps?.reasoningDefault, 'high');
  });

  test('Qwen3.8 without a cache row still exposes levels for the composer', () => {
    modelCache.clear();
    const caps = resolveSendCapabilities('llama-cpp-local', 'Qwen3.8-27B-Q4_K_M');
    assert.deepEqual(caps?.reasoningAllowedOptions, ['off', 'low', 'medium', 'high']);
    assert.equal(caps?.reasoningDefault, 'high');
  });

  test('cached off/on for Qwen3.8 is upgraded to levels from catalog', () => {
    modelCache.clear();
    modelCache.set(encodeModelSelectKey('lmstudio', 'qwen/qwen3.8-27b'), {
      id: 'qwen/qwen3.8-27b',
      type: 'vlm',
      api: 'lm-studio-v0',
      capabilities: {
        vision: true,
        tools: null,
        streaming: null,
        grammar: null,
        reasoning: true,
        reasoningAllowedOptions: ['off', 'on'],
        reasoningDefault: 'on',
        contextLength: null,
        loadState: 'loaded',
      },
    });
    const caps = resolveSendCapabilities('lmstudio', 'qwen/qwen3.8-27b', 'lm-studio-v0');
    assert.deepEqual(caps?.reasoningAllowedOptions, ['off', 'low', 'medium', 'high']);
    assert.equal(caps?.reasoningDefault, 'high');
  });

  test('GLM-5.3 without a cache row still exposes Low/High/Max', () => {
    modelCache.clear();
    const caps = resolveSendCapabilities('zai', 'glm-5.3-flash');
    assert.deepEqual(caps?.reasoningAllowedOptions, ['low', 'high', 'max']);
    assert.equal(caps?.reasoningDefault, 'max');
  });

  test('cached off/on for GLM-5.3 is replaced with Low/High/Max', () => {
    modelCache.clear();
    modelCache.set(encodeModelSelectKey('zai', 'glm-5.3-flash'), {
      id: 'glm-5.3-flash',
      type: 'llm',
      api: 'openai-v1',
      capabilities: {
        vision: false,
        tools: null,
        streaming: null,
        grammar: null,
        reasoning: true,
        reasoningAllowedOptions: ['off', 'on'],
        reasoningDefault: 'on',
        contextLength: null,
        loadState: 'loaded',
      },
    });
    const caps = resolveSendCapabilities('zai', 'glm-5.3-flash', 'openai-v1');
    assert.deepEqual(caps?.reasoningAllowedOptions, ['low', 'high', 'max']);
    assert.equal(caps?.reasoningDefault, 'max');
  });
});
