import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  DEFAULT_SAMPLER_GLOBAL,
  parseSamplerGlobalBlock,
} from '../../src/config/sampler-meta.ts';
import { DEFAULT_META } from '../../server/config/home.js';
import { DEFAULT_AGENT_MAX_TOKENS } from '../../server/runner/sampler-types.js';

describe('sampler global meta', () => {
  test('parseSamplerGlobalBlock merges defaults when persisted block is sparse', () => {
    const merged = parseSamplerGlobalBlock({ temperature: 0.8, maxTokens: 4096 });
    assert.equal(merged.temperature, 0.8);
    assert.equal(merged.maxTokens, 4096);
    assert.equal(merged.topP, DEFAULT_SAMPLER_GLOBAL.topP);
    assert.equal(merged.topK, DEFAULT_SAMPLER_GLOBAL.topK);
  });

  test('parseSamplerGlobalBlock returns full defaults when sampler missing', () => {
    const merged = parseSamplerGlobalBlock(null);
    assert.equal(merged.temperature, DEFAULT_SAMPLER_GLOBAL.temperature);
    assert.equal(merged.topP, DEFAULT_SAMPLER_GLOBAL.topP);
    assert.equal(merged.topK, DEFAULT_SAMPLER_GLOBAL.topK);
    assert.equal(merged.minP, DEFAULT_SAMPLER_GLOBAL.minP);
    assert.equal(merged.repetitionPenalty, DEFAULT_SAMPLER_GLOBAL.repetitionPenalty);
    assert.equal(merged.presencePenalty, DEFAULT_SAMPLER_GLOBAL.presencePenalty);
    assert.equal(merged.maxTokens, DEFAULT_SAMPLER_GLOBAL.maxTokens);
    assert.equal(merged.maxTokens, 131072);
    assert.equal(DEFAULT_META.sampler.maxTokens, merged.maxTokens);
    assert.equal(DEFAULT_AGENT_MAX_TOKENS, merged.maxTokens);
  });
});
