import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  buildCurrentRoundUsage,
  buildLiveLastStats,
  buildLiveStreamMeta,
  buildLiveStreamStats,
  buildTurnDisplayMeta,
  LIVE_STREAM_STATS_THROTTLE_MS,
} from '../../src/chat/streaming-stats.ts';
import { estimateTokensFromText } from '../../src/chat/prompts/token-estimate-core.ts';
import { buildLastStatsSnapshot } from '../../src/usage/chat-turn-metrics.ts';

describe('buildLiveLastStats', () => {
  test('holds context through empty and completion-only updates, then accepts compression', () => {
    let previous = buildLastStatsSnapshot({}, { prompt_tokens: 10000, completion_tokens: 500 });
    for (const partialText of ['', 'Hello', 'A longer reply']) {
      const meta = buildLiveStreamMeta({ streamMeta: {}, t0: 0, tFirst: 1, partialText }, 1000);
      previous = buildLiveLastStats(meta, previous);
      assert.equal(previous.total_tokens, 10500);
      assert.equal(previous.prompt_tokens, 10000);
      assert.equal(previous.completion_tokens, 500);
      assert.equal(previous.generation_time, meta.stats.generation_time);
    }
    const compressed = buildLiveLastStats({
      stats: {}, usage: { prompt_tokens: 4000, completion_tokens: 20 },
    }, previous);
    assert.equal(compressed.total_tokens, 4020);
  });

  test('leaves first-turn context estimated until prompt usage is known', () => {
    const snapshot = buildLiveLastStats({
      stats: { tokens_per_second: 12 }, usage: { completion_tokens: 12, total_tokens: 12 },
    }, null);
    assert.equal(snapshot.total_tokens, null);
    assert.equal(snapshot.prompt_tokens, null);
    assert.equal(snapshot.tokens_per_second, 12);
  });

  test('accepts a provider whole total without a prompt breakdown', () => {
    const snapshot = buildLiveLastStats({ stats: {}, usage: { total_tokens: 9000 } }, null);
    assert.equal(snapshot.total_tokens, 9000);
  });
});

/**
 * Live stats price streamed prose with the shared estimator — read the expected
 * count from it rather than restating its divisor, so recalibrating the
 * estimator does not rewrite this suite.
 */
function proseTokens(chars: number): number {
  return estimateTokensFromText('x'.repeat(chars));
}

describe('buildCurrentRoundUsage', () => {
  test('estimates completion tokens from partial assistant text', () => {
    const usage = buildCurrentRoundUsage({
      streamMeta: {},
      t0: 0,
      tFirst: 10,
      partialText: 'x'.repeat(400),
      partialThinkingLength: 0,
    });

    assert.equal(usage.completion_tokens, proseTokens(400));
    assert.equal(usage.total_tokens, proseTokens(400));
  });

  test('does not estimate completion from thinking length (provider reports it)', () => {
    const usage = buildCurrentRoundUsage({
      streamMeta: {},
      t0: 0,
      tFirst: 10,
      partialText: 'abcd',
      partialThinkingLength: 4,
    });

    assert.equal(usage.completion_tokens, 1);
  });

  test('prefers provider usage from stream meta when present', () => {
    const usage = buildCurrentRoundUsage({
      streamMeta: {
        usage: { prompt_tokens: 1200, completion_tokens: 42, total_tokens: 1242 },
      },
      t0: 0,
      tFirst: 10,
      partialText: 'ignored for count',
      partialThinkingLength: 0,
    });

    assert.equal(usage.completion_tokens, 42);
    assert.equal(usage.prompt_tokens, 1200);
    assert.equal(usage.total_tokens, 1242);
  });

  test('holds the finished round while the accumulator is empty between rounds', () => {
    // What run-turn-chat flushes at round_end: empty stream meta, no partial text.
    const usage = buildCurrentRoundUsage({
      streamMeta: {},
      t0: 0,
      tFirst: 10,
      partialText: '',
      priorStatsSegments: [
        {
          stats: {},
          usage: { prompt_tokens: 10_000, completion_tokens: 80, total_tokens: 10_080 },
        },
        {
          stats: {},
          usage: { prompt_tokens: 11_000, completion_tokens: 60, total_tokens: 11_060 },
        },
      ],
    });

    // The round that just closed, not a rollup and not a blank strip.
    assert.equal(usage.prompt_tokens, 11_000);
    assert.equal(usage.completion_tokens, 60);
    assert.equal(usage.total_tokens, 11_060);
  });

  test('ignores completed tool-loop rounds — earlier replies are already in this prompt', () => {
    const usage = buildCurrentRoundUsage({
      streamMeta: {
        usage: { prompt_tokens: 12_000, completion_tokens: 40, total_tokens: 12_040 },
      },
      t0: 0,
      tFirst: 10,
      partialText: '',
      priorStatsSegments: [
        {
          stats: {},
          usage: { prompt_tokens: 10_000, completion_tokens: 80, total_tokens: 10_080 },
        },
        {
          stats: {},
          usage: { prompt_tokens: 11_000, completion_tokens: 60, total_tokens: 11_060 },
        },
      ],
    });

    assert.equal(usage.prompt_tokens, 12_000);
    assert.equal(usage.completion_tokens, 40);
    assert.equal(usage.total_tokens, 12_040);
  });
});

describe('buildLiveStreamStats', () => {
  test('computes tok/s during an in-flight stream', () => {
    const stats = buildLiveStreamStats(
      {
        streamMeta: {},
        t0: 0,
        tFirst: 0,
        partialText: 'x'.repeat(400),
      },
      2000,
    );

    assert.equal(stats.time_to_first_token, 0);
    assert.ok(stats.generation_time != null && stats.generation_time > 0);
    assert.ok(stats.tokens_per_second != null && stats.tokens_per_second > 0);
    assert.ok(stats.tokens_per_second! < 200);
  });

  test('prior segments increase token totals but do not inflate live tok/s', () => {
    const stats = buildLiveStreamStats(
      {
        streamMeta: {
          usage: { completion_tokens: 40 },
        },
        t0: 0,
        tFirst: 0,
        partialText: '',
        priorSegments: [{ completion_tokens: 200 }],
        priorStatsSegments: [
          {
            stats: { tokens_per_second: 10, generation_time: 20 },
            usage: { completion_tokens: 200 },
          },
        ],
      },
      4000,
    );

    assert.ok(stats.tokens_per_second != null && stats.tokens_per_second < 15);
    assert.ok(stats.tokens_per_second! > 8);
  });

  test('weights tok/s across three tool-loop rounds by completion tokens', () => {
    // (10*100 + 20*200 + 50*50) / (100+200+50) = 21.428…
    const stats = buildLiveStreamStats(
      {
        streamMeta: {
          usage: { prompt_tokens: 3000, completion_tokens: 50, total_tokens: 3050 },
          stats: { tokens_per_second: 50, generation_time: 1, time_to_first_token: 0.1 },
        },
        t0: 0,
        tFirst: 100,
        partialText: 'ignored when provider usage is present',
        priorSegments: [
          { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 },
          { prompt_tokens: 2000, completion_tokens: 200, total_tokens: 2200 },
        ],
        priorStatsSegments: [
          {
            stats: { tokens_per_second: 10, generation_time: 10, time_to_first_token: 0.2 },
            usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 },
          },
          {
            stats: { tokens_per_second: 20, generation_time: 10, time_to_first_token: 0.2 },
            usage: { prompt_tokens: 2000, completion_tokens: 200, total_tokens: 2200 },
          },
        ],
      },
      1100,
    );

    assert.ok(stats.tokens_per_second != null);
    assert.ok(Math.abs(stats.tokens_per_second! - 21.428571) < 0.01);
  });
});

describe('buildCurrentRoundUsage with fake stream_meta', () => {
  test('live strip uses provider prompt_tokens, not a character estimate', () => {
    const usage = buildCurrentRoundUsage({
      streamMeta: {
        usage: { prompt_tokens: 4096, completion_tokens: 12, total_tokens: 4108 },
        stats: { tokens_per_second: 37.5 },
      },
      t0: 0,
      tFirst: 10,
      partialText: 'x'.repeat(4000),
      partialThinkingLength: 800,
    });

    assert.equal(usage.prompt_tokens, 4096);
    assert.equal(usage.completion_tokens, 12);
    assert.equal(usage.total_tokens, 4108);
    assert.notEqual(usage.completion_tokens, proseTokens(4000));
  });
});

describe('buildLiveStreamMeta', () => {
  test('keeps token counts round-scoped while rates average across the turn', () => {
    const meta = buildLiveStreamMeta(
      {
        streamMeta: {
          usage: { prompt_tokens: 3000, completion_tokens: 50, total_tokens: 3050 },
          stats: { tokens_per_second: 50, generation_time: 1, time_to_first_token: 0.1 },
        },
        t0: 0,
        tFirst: 100,
        partialText: '',
        priorStatsSegments: [
          {
            stats: { tokens_per_second: 10, generation_time: 10, time_to_first_token: 0.2 },
            usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 },
          },
        ],
      },
      1100,
    );

    // Context occupancy, not the turn rollup: 3050, never 3000 + 100 + 50.
    assert.equal(meta.usage.total_tokens, 3050);
    assert.equal(meta.usage.completion_tokens, 50);
    assert.ok(meta.stats.tokens_per_second != null && meta.stats.tokens_per_second < 50);
  });

  test('returns both usage and timing stats for the strip', () => {
    const meta = buildLiveStreamMeta(
      {
        streamMeta: {},
        t0: 0,
        tFirst: 0,
        partialText: 'x'.repeat(80),
      },
      1000,
    );

    assert.equal(meta.usage.completion_tokens, proseTokens(80));
    assert.ok(meta.stats.tokens_per_second != null);
  });
});

describe('buildTurnDisplayMeta', () => {
  const rounds = [
    {
      stats: { tokens_per_second: 10, generation_time: 10, time_to_first_token: 0.2 },
      usage: { prompt_tokens: 10_000, completion_tokens: 500, total_tokens: 10_500 },
    },
    {
      stats: { tokens_per_second: 20, generation_time: 5, time_to_first_token: 0.4 },
      usage: { prompt_tokens: 11_200, completion_tokens: 400, total_tokens: 11_600 },
    },
    {
      stats: { tokens_per_second: 50, generation_time: 2, time_to_first_token: 0.6 },
      usage: { prompt_tokens: 12_400, completion_tokens: 800, total_tokens: 13_200 },
    },
  ];

  test('takes token counts from the final round, never the tool-loop rollup', () => {
    const meta = buildTurnDisplayMeta(rounds, rounds[2]);

    assert.equal(meta?.usage.prompt_tokens, 12_400);
    assert.equal(meta?.usage.completion_tokens, 800);
    // The old rollup was 12_400 + (500 + 400 + 800) = 14_100.
    assert.equal(meta?.usage.total_tokens, 13_200);
  });

  test('still averages rates across every round of the turn', () => {
    const meta = buildTurnDisplayMeta(rounds, rounds[2]);

    // Completion-weighted: (10*500 + 20*400 + 50*800) / 1700 = 31.17…
    assert.ok(meta?.stats.tokens_per_second != null);
    assert.ok(Math.abs(meta!.stats.tokens_per_second! - 31.176) < 0.01);
  });

  test('falls back to the last round when no segment carried usage', () => {
    const lastRound = { stats: { tokens_per_second: 12 }, usage: { total_tokens: 900 } };
    assert.deepEqual(buildTurnDisplayMeta([], lastRound), lastRound);
    assert.equal(buildTurnDisplayMeta([], null), null);
  });
});

describe('LIVE_STREAM_STATS_THROTTLE_MS', () => {
  test('uses a small throttle to limit strip repaint churn', () => {
    assert.equal(LIVE_STREAM_STATS_THROTTLE_MS, 100);
  });
});
