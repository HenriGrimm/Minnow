import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyModelSamplerPreset,
  MODEL_SAMPLER_PRESET_FAMILIES,
  recommendedSamplerFamily,
} from '../../src/models/sampler-presets.ts';
import recommendedModels from '../../src/models/recommended.json';
import { clampSamplerPreset } from '../../src/agents/sampler-types.ts';
import { normalizeSamplerPreset } from '../../server/agents/sampler.js';

test('every shipped recommended model has a researched sampler preset', () => {
  for (const model of recommendedModels) {
    const family = recommendedSamplerFamily(model.name, model.repo, model.filename);
    assert.ok(family, model.name);
    assert.ok(family.presets.length > 0);
    assert.match(family.source, /^https:\/\/huggingface.co\/(Qwen|google)\//);
  }
});

test('Qwen3.6 coding preset encodes the issue example and preserves unrelated overrides', () => {
  const family = recommendedSamplerFamily('unsloth/Qwen3.6-27B-GGUF');
  const preset = family!.presets.find((entry) => entry.id === 'thinking-code')!;
  const expected = {
    temperature: 0.6, topP: 0.95, topK: 20,
    minP: 0, presencePenalty: 0, repetitionPenalty: 1,
  };
  assert.deepEqual(preset.values, expected);
  assert.deepEqual(applyModelSamplerPreset({ maxTokens: 4096, stop: ['END'], minP: 0.1 }, preset), {
    ...expected, maxTokens: 4096, stop: ['END'],
  });
  assert.deepEqual(preset.values, expected, 'applying must not mutate catalog values');
});

test('family matching distinguishes popular variants and converted file names', () => {
  for (const [name, familyId] of [
    ['Qwen3.6-27B-Q4_K_M.gguf', 'qwen3.6'],
    ['Qwen3_8-Flash-Next-4bit', 'qwen3.8'],
    ['qwen3.5:9b', 'qwen3.5'],
    ['Qwen3-Coder-Next-Q4_K_M', 'qwen3-coder-next'],
    ['Qwen3-8B-Q4_K_M', 'qwen3'],
    ['Qwen3-30B-A3B-Q4_K_M', 'qwen3'],
    ['DeepSeek-R1-Distill-Qwen-32B-Q4_K_M', 'deepseek-r1'],
    ['google/gemma-4-12B-it-qat-q4_0-gguf', 'gemma4'],
  ]) {
    assert.equal(recommendedSamplerFamily(name)?.id, familyId, name);
  }
  for (const name of ['unknown', 'qwen3.9-27b', 'Qwen3-Coder-30B', 'Qwen3-8B-Base', 'Qwen3-30B-A3B-Instruct-2507']) {
    assert.equal(recommendedSamplerFamily(name), null, name);
  }
});

test('catalog values survive both client and server validation', () => {
  for (const family of MODEL_SAMPLER_PRESET_FAMILIES) {
    for (const preset of family.presets) {
      assert.deepEqual(clampSamplerPreset(preset.values), preset.values, `${family.id}/${preset.id} client`);
      assert.deepEqual(normalizeSamplerPreset(preset.values), preset.values, `${family.id}/${preset.id} server`);
    }
  }
});
