import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { normalizeSamplerPreset, wrapSamplerForTurn } from '../../server/agents/sampler.js';
import { normalizeSubAgentsConfig } from '../../server/config/validators.js';

describe('server sampler normalization', () => {
  test('normalizeSamplerPreset clamps temperature', () => {
    const out = normalizeSamplerPreset({ temperature: 5, topP: 0.5 });
    assert.equal(out.temperature, 2);
    assert.equal(out.topP, 0.5);
  });

  test('normalizeSubAgentsConfig clamps checkInNudgeMs', () => {
    const { config: zero } = normalizeSubAgentsConfig({ checkInNudgeMs: 0 });
    assert.equal(zero.checkInNudgeMs, 0);
    const { config: high } = normalizeSubAgentsConfig({ checkInNudgeMs: 9_999_999 });
    assert.equal(high.checkInNudgeMs, 1_800_000);
    const { config: def } = normalizeSubAgentsConfig({});
    assert.equal(def.checkInNudgeMs, 120_000);
  });

  test('normalizeSubAgentsConfig drops retired types and timeouts', () => {
    const { config } = normalizeSubAgentsConfig({
      defaultTimeoutMs: 300000,
      types: {
        'plan-repairer': { enabled: true },
        explore: { timeoutMs: 300000, maxConcurrent: 2 },
      },
    });
    assert.equal('defaultTimeoutMs' in config, false);
    assert.equal('plan-repairer' in config.types, false);
    assert.equal('timeoutMs' in config.types.explore, false);
    assert.equal(config.types.explore.maxConcurrent, 2);
  });

  test('normalizeSubAgentsConfig clamps types.*.sampler', () => {
    const { config } = normalizeSubAgentsConfig({
      types: {
        explore: {
          sampler: { temperature: 3, topK: 80 },
        },
      },
    });
    assert.equal(config.types.explore.sampler.temperature, 2);
    assert.equal(config.types.explore.sampler.topK, 80);
  });

  test('normalizeSamplerPreset accepts stop as string or string[] and caps at 8', () => {
    const fromString = normalizeSamplerPreset({ stop: '  END  ' });
    assert.deepEqual(fromString.stop, ['END']);

    const fromArray = normalizeSamplerPreset({
      stop: [' a ', '', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'],
    });
    assert.deepEqual(fromArray.stop, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);

    const empty = normalizeSamplerPreset({ stop: ['  ', ''] });
    assert.equal(empty.stop, undefined);
  });

  test('wrapSamplerForTurn inherits fallback maxTokens when the row omits it', () => {
    const wrapped = wrapSamplerForTurn({ temperature: 0.6, topP: 0.95 }, 131072);
    assert.equal(wrapped.maxTokens, 131072);
    assert.equal(wrapped.preset.temperature, 0.6);
    assert.equal('maxTokens' in wrapped.preset, false);
    const explicit = wrapSamplerForTurn({ temperature: 0.5, maxTokens: 512 }, 131072);
    assert.equal(explicit.maxTokens, 512);
  });
});
