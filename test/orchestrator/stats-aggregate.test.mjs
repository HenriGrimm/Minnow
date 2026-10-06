/**
 * Token/speed rollup used by chat metrics and evals (MIN-36).
 *
 * Ported from V1 `test/orchestrate/stats-aggregate.test.mts` against the
 * shared runner package. The renderer re-export in `src/chat/plans/stats-math.ts`
 * is the same module — do not duplicate this table there.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  aggregateOrchestrateTurnMeta,
  aggregateTurnMetaSegments,
  averageStatsSegments,
  sumUsageSegments,
} from '../../server/runner/stats-math.js';

describe('stats math (MIN-36)', () => {
  test('sumUsageSegments adds prompt, completion, and total tokens', () => {
    const out = sumUsageSegments([
      { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
      { prompt_tokens: 50, completion_tokens: 10 },
    ]);
    assert.equal(out.prompt_tokens, 150);
    assert.equal(out.completion_tokens, 50);
    assert.equal(out.total_tokens, 200);
  });

  test('averageStatsSegments divides total output by total inferred time', () => {
    const out = averageStatsSegments([
      { stats: { tokens_per_second: 10 }, usage: { completion_tokens: 100 } },
      { stats: { tokens_per_second: 20 }, usage: { completion_tokens: 300 } },
    ]);
    // 400 tokens / (100/10 + 300/20 seconds) = 16 tok/s. The old
    // token-weighted arithmetic mean incorrectly returned 17.5.
    assert.equal(out.tokens_per_second, 16);
  });

  test('averageStatsSegments uses measured generation time for bursty rounds', () => {
    const out = averageStatsSegments([
      { stats: { tokens_per_second: 40, generation_time: 10 }, usage: {} },
      { stats: { tokens_per_second: 1000, generation_time: 0.05 }, usage: {} },
    ]);
    assert.ok(Math.abs(out.tokens_per_second - 450 / 10.05) < 1e-9);
  });

  test('averageStatsSegments arithmetic mean for TTFT and generation time', () => {
    const out = averageStatsSegments([
      {
        stats: { time_to_first_token: 0.2, generation_time: 1.0 },
        usage: {},
      },
      {
        stats: { time_to_first_token: 0.4, generation_time: 3.0 },
        usage: {},
      },
    ]);
    assert.ok(out.time_to_first_token != null && Math.abs(out.time_to_first_token - 0.3) < 1e-9);
    assert.equal(out.generation_time, 2);
  });

  test('aggregateTurnMetaSegments rolls up usage and time-combined tok/s', () => {
    const aggregated = aggregateTurnMetaSegments([
      {
        stats: { tokens_per_second: 10, generation_time: 10, time_to_first_token: 0.2 },
        usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 },
      },
      {
        stats: { tokens_per_second: 20, generation_time: 5, time_to_first_token: 0.4 },
        usage: { prompt_tokens: 2000, completion_tokens: 100, total_tokens: 2100 },
      },
    ]);

    assert.equal(aggregated.usage.prompt_tokens, 2000);
    assert.equal(aggregated.usage.completion_tokens, 200);
    assert.equal(aggregated.usage.total_tokens, 2200);
    assert.ok(Math.abs(aggregated.stats.tokens_per_second - 200 / 15) < 1e-9);
    assert.equal(aggregated.stats.generation_time, 7.5);
    assert.ok(
      aggregated.stats.time_to_first_token != null &&
        Math.abs(aggregated.stats.time_to_first_token - 0.3) < 1e-9,
    );
  });

  test('aggregateOrchestrateTurnMeta sums tokens and preserves parent stop_reason', () => {
    const parent = {
      stats: { tokens_per_second: 5, stop_reason: 'eos' },
      usage: { prompt_tokens: 200, completion_tokens: 80, total_tokens: 280 },
      model_info: { arch: 'llama' },
    };
    const aggregated = aggregateOrchestrateTurnMeta(parent, [
      {
        usage: { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 },
        stats: { tokens_per_second: 15, time_to_first_token: 0.5 },
      },
      {
        usage: { prompt_tokens: 500, completion_tokens: 100, total_tokens: 600 },
        stats: { tokens_per_second: 25, time_to_first_token: 1.5 },
      },
    ]);
    assert.equal(aggregated.usage.prompt_tokens, 1700);
    assert.equal(aggregated.usage.completion_tokens, 380);
    assert.equal(aggregated.usage.total_tokens, 2080);
    assert.equal(aggregated.stats.stop_reason, 'eos');
    assert.ok(
      aggregated.stats.tokens_per_second != null && aggregated.stats.tokens_per_second > 5,
    );
  });
});
