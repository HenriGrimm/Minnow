/**
 * tok/s only counts tokens that decoded inside the measured window, and never
 * reports a rate no decoder could produce.
 *
 * Both guards exist because hosted providers inflated the chip several-fold:
 * reasoning billed in `completion_tokens` but generated before the first byte,
 * and replayed generations whose whole body arrived in milliseconds.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  MAX_PLAUSIBLE_TOKENS_PER_SECOND,
  buildClientStats,
  decodeWindowCompletionTokens,
  finalizeResponseMeta,
  mergeStreamMeta,
  reconcileCompletionStats,
} from '../../src/api/chat.ts';

describe('decodeWindowCompletionTokens', () => {
  test('drops reasoning that never streamed', () => {
    const usage = {
      completion_tokens: 1579,
      completion_tokens_details: { reasoning_tokens: 1449 },
    };
    assert.equal(decodeWindowCompletionTokens(usage), 130);
  });

  test('keeps reasoning that did stream', () => {
    const usage = {
      completion_tokens: 1579,
      completion_tokens_details: { reasoning_tokens: 1449 },
    };
    assert.equal(decodeWindowCompletionTokens(usage, true), 1579);
  });

  test('plain usage is untouched', () => {
    assert.equal(decodeWindowCompletionTokens({ completion_tokens: 240 }), 240);
  });

  test('a round that streamed nothing but hidden reasoning has no rate', () => {
    const usage = {
      completion_tokens: 900,
      completion_tokens_details: { reasoning_tokens: 900 },
    };
    assert.equal(decodeWindowCompletionTokens(usage), null);
  });
});

describe('hidden reasoning', () => {
  // Ledger row from a hosted round: 13.15 s thinking before the first byte,
  // 0.81 s of visible output. It used to read 1942 tok/s.
  const usage = {
    prompt_tokens: 29_753,
    completion_tokens: 1579,
    completion_tokens_details: { reasoning_tokens: 1449 },
  };
  const t0 = 0;
  const tFirst = 13_150;
  const tEnd = 13_960;

  test('is left out of the decode rate', () => {
    const stats = buildClientStats(t0, tFirst, tEnd, usage, 'tool_calls');
    assert.ok(stats.tokens_per_second != null);
    assert.ok(
      stats.tokens_per_second < 200,
      `expected a visible-token rate, got ${stats.tokens_per_second}`,
    );
    assert.equal(Math.round(stats.tokens_per_second), 160);
  });

  test('counts in full once the reasoning streams', () => {
    const stats = buildClientStats(t0, tFirst, tEnd, usage, 'tool_calls', true);
    assert.equal(Math.round(stats.tokens_per_second ?? 0), 1949);
  });

  test('finalizeResponseMeta honours the streamed_reasoning flag', () => {
    const hidden = finalizeResponseMeta({ usage }, t0, tFirst, tEnd);
    const streamed = finalizeResponseMeta(
      { usage, streamed_reasoning: true },
      t0,
      tFirst,
      tEnd,
    );
    assert.ok((hidden.stats.tokens_per_second ?? 0) < (streamed.stats.tokens_per_second ?? 0));
  });

  test('mergeStreamMeta flags reasoning deltas', () => {
    const acc = mergeStreamMeta(undefined, {
      choices: [{ index: 0, delta: { reasoning_content: 'weighing options' } }],
    });
    assert.equal(acc.streamed_reasoning, true);
  });

  test('mergeStreamMeta leaves prose-only rounds unflagged', () => {
    const acc = mergeStreamMeta(undefined, {
      choices: [{ index: 0, delta: { content: 'hello' } }],
    });
    assert.equal(acc.streamed_reasoning, undefined);
  });
});

describe('implausible rates', () => {
  // A replayed generation hands the whole SSE body over in milliseconds, so the
  // measured window is meaningless — no chip beats a fictional one.
  test('a replay burst reports no tok/s at all', () => {
    const usage = { prompt_tokens: 39_420, completion_tokens: 12_299 };
    const stats = buildClientStats(0, 22.4, 62.6, usage, 'tool_calls');
    assert.equal(stats.tokens_per_second, undefined);
    assert.ok(stats.generation_time != null);
  });

  test('reconcile drops a server rate above the cap', () => {
    const stats = reconcileCompletionStats(
      {},
      { tokens_per_second: 72_709, generation_time: 0.03, time_to_first_token: 0.02 },
      undefined,
    );
    assert.equal(stats.tokens_per_second, undefined);
  });

  test('a rate at the cap still shows', () => {
    const usage = { completion_tokens: MAX_PLAUSIBLE_TOKENS_PER_SECOND };
    const stats = buildClientStats(0, 100, 1100, usage, 'stop');
    assert.equal(stats.tokens_per_second, MAX_PLAUSIBLE_TOKENS_PER_SECOND);
  });
});
