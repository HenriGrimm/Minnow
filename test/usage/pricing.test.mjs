/**
 * Provider pricing resolution and USD cost math.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  computeCostUsd,
  hasMeasurableUsage,
  normalizeUsageTotals,
  resolveModelPricing,
  usageTokenCounts,
} from '../../src/usage/pricing.ts';
import { recordChatCompletionUsageWithPricing } from '../../src/usage/record-chat-usage.ts';

test('native per-generation reported cost overrides configured token-price estimates', () => {
  const chat = { id: 'native-cli-cost', history: [] };
  recordChatCompletionUsageWithPricing(chat, { source: { kind: 'main', modeId: 'general' }, providerId: 'claude-code-cli', modelId: 'fixture',
    usage: { prompt_tokens: 1000, completion_tokens: 500 }, reportedCostUsd: .01 }, { default: { inputPer1M: 100, outputPer1M: 100 } });
  assert.equal(chat.tokenLedger.entries[0].costUsd, .01);
});

const PRICING_TABLE = {
  currency: 'USD',
  default: { inputPer1M: 1, outputPer1M: 3 },
  models: {
    'gpt-4o': { inputPer1M: 5, outputPer1M: 15 },
    'gpt-4o-mini': { inputPer1M: 0.15, outputPer1M: 0.6 },
    '*': { inputPer1M: 2, outputPer1M: 8 },
  },
};

describe('resolveModelPricing', () => {
  test('exact model beats wildcard and default', () => {
    const rates = resolveModelPricing(PRICING_TABLE, 'gpt-4o-mini');
    assert.equal(rates.inputPer1M, 0.15);
    assert.equal(rates.outputPer1M, 0.6);
  });

  test('wildcard applies when model id missing', () => {
    const rates = resolveModelPricing(PRICING_TABLE, 'unknown-model');
    assert.equal(rates.inputPer1M, 2);
    assert.equal(rates.outputPer1M, 8);
  });

  test('missing pricing returns zero rates', () => {
    const rates = resolveModelPricing(null, 'gpt-4o');
    assert.equal(rates.inputPer1M, 0);
    assert.equal(rates.outputPer1M, 0);
  });
});

describe('computeCostUsd', () => {
  test('computes split prompt and completion cost', () => {
    const usage = { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 };
    const rates = { inputPer1M: 1, outputPer1M: 2 };
    const cost = computeCostUsd(usage, rates);
    assert.equal(cost, 0.002);
  });

  test('attributes total_tokens to completion when split missing', () => {
    const usage = { total_tokens: 1_000_000 };
    const rates = { inputPer1M: 0, outputPer1M: 1 };
    const counts = usageTokenCounts(usage);
    assert.equal(counts.completionTokens, 1_000_000);
    const cost = computeCostUsd(usage, rates);
    assert.equal(cost, 1);
  });

  test('zero rates yield null cost', () => {
    const usage = { prompt_tokens: 100, completion_tokens: 50 };
    const cost = computeCostUsd(usage, { inputPer1M: 0, outputPer1M: 0 });
    assert.equal(cost, null);
  });
});

describe('hasMeasurableUsage', () => {
  test('false for empty usage', () => {
    assert.equal(hasMeasurableUsage({}), false);
    assert.equal(hasMeasurableUsage(undefined), false);
  });

  test('true when total_tokens present', () => {
    assert.equal(hasMeasurableUsage({ total_tokens: 12 }), true);
  });
});

describe('normalizeUsageTotals', () => {
  test('fills total_tokens from prompt + completion when omitted', () => {
    const out = normalizeUsageTotals({ prompt_tokens: 100, completion_tokens: 50 });
    assert.equal(out.total_tokens, 150);
    assert.equal(out.prompt_tokens, 100);
    assert.equal(out.completion_tokens, 50);
  });

  test('keeps an existing finite total_tokens', () => {
    const out = normalizeUsageTotals({
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 15522,
    });
    assert.equal(out.total_tokens, 15522);
  });

  test('leaves empty usage unchanged', () => {
    const out = normalizeUsageTotals({});
    assert.equal(out.total_tokens, undefined);
  });
});
