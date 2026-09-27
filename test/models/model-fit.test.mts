import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  recommendModelFits,
  type ModelFitCandidate,
} from '../../src/models/model-fit.ts';

function candidate(
  key: string,
  overrides: Partial<ModelFitCandidate> = {},
): ModelFitCandidate {
  return {
    key,
    providerId: 'test-provider',
    modelId: key,
    label: key,
    local: false,
    loaded: false,
    capabilities: {
      vision: null,
      tools: true,
      reasoning: null,
      contextLength: 32_768,
      sources: { tools: 'probe', contextLength: 'catalog' },
    },
    ...overrides,
  };
}

describe('model fit scorer', () => {
  test('puts an explicit failed capability probe behind an unverified model', () => {
    const failed = candidate('failed', {
      capabilities: {
        vision: null,
        tools: false,
        reasoning: true,
        contextLength: 131_072,
        sources: { tools: 'probe' },
      },
      benchmark: { totalScore: 1 },
    });
    const unknown = candidate('unknown', {
      capabilities: {
        vision: null,
        tools: null,
        reasoning: null,
        contextLength: null,
      },
    });

    const ranked = recommendModelFits([failed, unknown], 'tool-agent');
    assert.equal(ranked[0]?.candidate.key, 'unknown');
    assert.equal(ranked[0]?.status, 'unverified');
    assert.equal(ranked[1]?.status, 'incompatible');
    assert.match(ranked[1]?.incompatibilities[0] ?? '', /failed its capability probe/);
  });

  test('does not present an assumed required capability as verified', () => {
    const assumed = candidate('assumed', {
      capabilities: {
        vision: null,
        tools: true,
        reasoning: null,
        contextLength: 32_768,
        sources: { tools: 'assumed' },
      },
    });

    const [result] = recommendModelFits([assumed], 'general-coding');
    assert.equal(result?.status, 'unverified');
    assert.match(result?.unknowns[0] ?? '', /not been verified by catalog or probe/);
  });

  test('enforces the 64K long-context requirement without guessing missing limits', () => {
    const short = candidate('short', {
      capabilities: { vision: null, tools: true, reasoning: true, contextLength: 32_768 },
    });
    const unknown = candidate('unknown', {
      capabilities: { vision: null, tools: true, reasoning: true, contextLength: null },
    });
    const long = candidate('long', {
      capabilities: { vision: null, tools: true, reasoning: true, contextLength: 131_072 },
    });

    const ranked = recommendModelFits([short, unknown, long], 'long-context');
    assert.equal(ranked[0]?.candidate.key, 'long');
    assert.equal(ranked[0]?.status, 'compatible');
    assert.equal(ranked[1]?.status, 'unverified');
    assert.equal(ranked[2]?.status, 'incompatible');
  });

  test('uses measured speed and load state for the fast local profile', () => {
    const slow = candidate('slow', {
      local: true,
      benchmark: { tokensPerSecond: 12, timeToFirstTokenMs: 900 },
    });
    const fast = candidate('fast', {
      local: true,
      loaded: true,
      benchmark: { tokensPerSecond: 48, timeToFirstTokenMs: 180 },
    });
    const cloud = candidate('cloud', {
      local: false,
      benchmark: { tokensPerSecond: 100 },
    });

    const ranked = recommendModelFits([slow, cloud, fast], 'fast-local');
    assert.equal(ranked[0]?.candidate.key, 'fast');
    assert.match(ranked[0]?.reasons.join(' '), /48\.0 measured tokens\/s/);
    assert.equal(ranked.at(-1)?.candidate.key, 'cloud');
    assert.equal(ranked.at(-1)?.status, 'incompatible');
  });

  test('reports configured pricing but does not invent absent cost data', () => {
    const priced = candidate('priced', {
      pricing: {
        currency: 'USD',
        inputPerMillion: 2.5,
        outputPerMillion: 10,
      },
    });
    const unpriced = candidate('unpriced');
    const ranked = recommendModelFits([priced, unpriced], 'general-coding');
    const pricedResult = ranked.find((row) => row.candidate.key === 'priced')!;
    const unpricedResult = ranked.find((row) => row.candidate.key === 'unpriced')!;

    assert.match(pricedResult.reasons.join(' '), /USD 2\.50 input/);
    assert.doesNotMatch(unpricedResult.reasons.join(' '), /per 1M tokens/);
  });
});
