/**
 * P10-G (MIN-772) — `stream_meta.runtime` is `{ timings, prompt_progress }`,
 * not a display string. The status row must map it through llamaRuntimeStatusView.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  applyStreamMetaEvent,
  llamaRuntimeFromStreamMetaRuntime,
  runtimeStatusFromStreamMetaRuntime,
  streamMetaFromRoundEnd,
} from '../../src/chat/turn-stream-meta.ts';

describe('llamaRuntimeFromStreamMetaRuntime', () => {
  test('reads timings and prompt_progress off the P10-B runtime object', () => {
    const mapped = llamaRuntimeFromStreamMetaRuntime({
      timings: { predicted_n: 12 },
      prompt_progress: { total: 100, cache: 0, processed: 40, time_ms: 80 },
    });
    assert.equal(mapped?.timings?.predicted_n, 12);
    assert.equal(mapped?.prompt_progress?.processed, 40);
  });

  test('rejects a string runtime so it cannot leak into the status row', () => {
    assert.equal(llamaRuntimeFromStreamMetaRuntime('Processing prompt… 40%'), undefined);
    assert.equal(llamaRuntimeFromStreamMetaRuntime(null), undefined);
    assert.equal(llamaRuntimeFromStreamMetaRuntime(40), undefined);
  });
});

describe('runtimeStatusFromStreamMetaRuntime', () => {
  test('maps prompt_progress to a prefill percent, not a raw runtime dump', () => {
    const view = runtimeStatusFromStreamMetaRuntime(
      { prompt_progress: { total: 16360, cache: 0, processed: 8192, time_ms: 1047 } },
      false,
    );
    assert.equal(view.phase, 'prompt_processing');
    assert.equal(view.detail, '50%');
  });

  test('a string runtime yields an empty view, never the string as detail', () => {
    const view = runtimeStatusFromStreamMetaRuntime('50%', false);
    assert.equal(view.phase, null);
    assert.equal(view.detail, '');
  });

  test('switches to a token count once output has been shown', () => {
    const view = runtimeStatusFromStreamMetaRuntime(
      {
        prompt_progress: { total: 16360, cache: 0, processed: 8192, time_ms: 1047 },
        timings: { predicted_n: 3 },
      },
      true,
    );
    assert.equal(view.phase, 'generating');
    assert.equal(view.detail, '3 tokens');
  });
});

describe('runtimeStatusFromStreamMetaRuntime — hosted estimate (MIN-337)', () => {
  test('falls back to the runner estimate when llama timings are absent', () => {
    const view = runtimeStatusFromStreamMetaRuntime({ output_tokens_estimate: 103 }, false);
    assert.equal(view.phase, 'generating');
    assert.equal(view.detail, '103 tokens');
  });

  test('llama predicted_n wins over the estimate', () => {
    const view = runtimeStatusFromStreamMetaRuntime(
      { timings: { predicted_n: 7 }, output_tokens_estimate: 103 },
      true,
    );
    assert.equal(view.detail, '7 tokens');
  });

  test('prefill progress still wins before output', () => {
    const view = runtimeStatusFromStreamMetaRuntime(
      {
        prompt_progress: { total: 100, cache: 0, processed: 50, time_ms: 10 },
        output_tokens_estimate: 4,
      },
      false,
    );
    assert.equal(view.phase, 'prompt_processing');
  });

  test('the estimate never reaches accumulated timings (usage fill)', () => {
    const acc = applyStreamMetaEvent(
      {},
      { type: 'stream_meta', runtime: { output_tokens_estimate: 103 } },
    );
    assert.equal(acc.timings, undefined);
  });
});

describe('applyStreamMetaEvent', () => {
  test('folds usage, stats, model, finish, and runtime into the accumulator', () => {
    const acc = applyStreamMetaEvent(
      {},
      {
        type: 'stream_meta',
        usage: { prompt_tokens: 1200, completion_tokens: 8, total_tokens: 1208 },
        stats: { tokens_per_second: 42 },
        model: 'qwen2.5',
        finishReason: 'null',
        runtime: {
          timings: { predicted_n: 8, prompt_per_second: 400 },
          prompt_progress: { total: 1200, cache: 0, processed: 1200, time_ms: 10 },
        },
      },
    );
    assert.equal(acc.usage?.prompt_tokens, 1200);
    assert.equal(acc.usage?.completion_tokens, 8);
    assert.equal(acc.stats?.tokens_per_second, 42);
    assert.equal(acc.model, 'qwen2.5');
    assert.equal(acc.finish_reason, 'null');
    assert.equal(acc.timings?.predicted_n, 8);
    assert.equal(acc.prompt_progress?.total, 1200);
  });

  test('later events overlay earlier usage rather than replacing the object wholesale', () => {
    const first = applyStreamMetaEvent(
      {},
      { type: 'stream_meta', usage: { prompt_tokens: 100, completion_tokens: 1 } },
    );
    const second = applyStreamMetaEvent(first, {
      type: 'stream_meta',
      usage: { completion_tokens: 9, total_tokens: 109 },
    });
    assert.equal(second.usage?.prompt_tokens, 100);
    assert.equal(second.usage?.completion_tokens, 9);
    assert.equal(second.usage?.total_tokens, 109);
  });
});

describe('streamMetaFromRoundEnd', () => {
  test('prefers round_end usage while keeping live timings', () => {
    const merged = streamMetaFromRoundEnd(
      {
        usage: { prompt_tokens: 50 },
        timings: { predicted_n: 4 },
      },
      {
        type: 'round_end',
        index: 0,
        text: 'hi',
        reasoning: '',
        toolCallCount: 0,
        usage: { prompt_tokens: 80, completion_tokens: 4, total_tokens: 84 },
        stats: { tokens_per_second: 10 },
        finishReason: 'stop',
        t0: 0,
        tFirst: 1,
        tEnd: 2,
      },
    );
    assert.equal(merged.usage?.prompt_tokens, 80);
    assert.equal(merged.usage?.completion_tokens, 4);
    assert.equal(merged.stats?.tokens_per_second, 10);
    assert.equal(merged.timings?.predicted_n, 4);
    assert.equal(merged.finish_reason, 'stop');
  });
});
