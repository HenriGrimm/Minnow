/**
 * `/slots` normalisation.
 *
 * Every quirk locked here was measured against llama-server b9628, not assumed:
 * idle slots carry four fields; `n_prompt_tokens` mirrors the running processed count
 * during prefill (so there is no denominator to make a percentage from); `n_decoded`
 * is stale from the previous task until the new one has tokens left to produce; and a
 * saturated server simply stops answering.
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import {
  getServeActivity,
  listServeActivity,
  normalizeSlots,
  parseLlamaCppDeferred,
  resetServeActivityFetchForTests,
  setServeActivityFetchForTests,
  startServeActivity,
  stopAllServeActivity,
  subscribeServeActivity,
} from '../../server/models/serve-activity.js';

after(() => {
  stopAllServeActivity();
  resetServeActivityFetchForTests();
});

/** Wait for the poller to publish, without a fixed sleep. */
function nextActivity(timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error('no activity sample published'));
    }, timeoutMs);
    const unsubscribe = subscribeServeActivity((activity) => {
      clearTimeout(timer);
      unsubscribe();
      resolve(activity);
    });
  });
}

describe('normalizeSlots', () => {
  it('reads an idle slot from the four fields llama.cpp sends', () => {
    const slots = normalizeSlots(
      [{ id: 0, n_ctx: 16384, speculative: false, is_processing: false }],
      new Map(),
      1_000,
    );
    assert.deepEqual(slots, [
      {
        id: 0,
        taskId: null,
        state: 'idle',
        promptProcessed: 0,
        promptCached: 0,
        decoded: 0,
        remaining: null,
        tokensPerSecond: null,
        promptTokensPerSecond: null,
      },
    ]);
  });

  it('derives a prompt rate from consecutive prefill samples of the same task', () => {
    const prev = new Map();
    const prefill = (processed) => [{
      id: 0, is_processing: true, id_task: 42,
      n_prompt_tokens_processed: processed, n_prompt_tokens_cache: 0,
      next_token: [{ n_remain: 0, n_decoded: 0 }],
    }];
    assert.equal(normalizeSlots(prefill(2048), prev, 1_000)[0].promptTokensPerSecond, null);
    const [slot] = normalizeSlots(prefill(4096), prev, 1_500);
    assert.equal(slot.state, 'prompt');
    assert.equal(slot.promptTokensPerSecond, 4096);
  });

  it('reports prefill as a token count, because /slots has no total to divide by', () => {
    const slots = normalizeSlots(
      [
        {
          id: 0,
          is_processing: true,
          id_task: 1305,
          // During prefill these two are the same running count, not a part and a whole.
          n_prompt_tokens: 10240,
          n_prompt_tokens_processed: 10240,
          n_prompt_tokens_cache: 0,
          next_token: [{ n_remain: 0, n_decoded: 60 }],
        },
      ],
      new Map(),
      1_000,
    );
    assert.equal(slots[0].state, 'prompt');
    assert.equal(slots[0].promptProcessed, 10240);
    // n_decoded here is left over from the previous task — it must not be shown.
    assert.equal(slots[0].decoded, 0);
    assert.equal(slots[0].remaining, null);
  });

  it('surfaces the cached prefix so a near-instant prefill is explainable', () => {
    const slots = normalizeSlots(
      [
        {
          id: 0,
          is_processing: true,
          id_task: 7,
          n_prompt_tokens_processed: 10016,
          n_prompt_tokens_cache: 10016,
          next_token: [{ n_remain: 0, n_decoded: 0 }],
        },
      ],
      new Map(),
      1_000,
    );
    assert.equal(slots[0].promptCached, 10016);
  });

  it('switches to generating once the task has tokens left to produce', () => {
    const slots = normalizeSlots(
      [
        {
          id: 0,
          is_processing: true,
          id_task: 1305,
          n_prompt_tokens_processed: 16360,
          next_token: [{ n_remain: 295, n_decoded: 5 }],
        },
      ],
      new Map(),
      1_000,
    );
    assert.equal(slots[0].state, 'generating');
    assert.equal(slots[0].decoded, 5);
    assert.equal(slots[0].remaining, 295);
  });

  it('derives tok/s from consecutive samples of the same task', () => {
    const prev = new Map();
    normalizeSlots(
      [{ id: 0, is_processing: true, id_task: 1, next_token: [{ n_remain: 100, n_decoded: 10 }] }],
      prev,
      1_000,
    );
    const second = normalizeSlots(
      [{ id: 0, is_processing: true, id_task: 1, next_token: [{ n_remain: 60, n_decoded: 50 }] }],
      prev,
      2_000,
    );
    // 40 tokens in 1000 ms.
    assert.equal(second[0].tokensPerSecond, 40);
  });

  it('does not carry a rate across a task change', () => {
    const prev = new Map();
    normalizeSlots(
      [{ id: 0, is_processing: true, id_task: 1, next_token: [{ n_remain: 10, n_decoded: 900 }] }],
      prev,
      1_000,
    );
    const second = normalizeSlots(
      [{ id: 0, is_processing: true, id_task: 2, next_token: [{ n_remain: 100, n_decoded: 3 }] }],
      prev,
      2_000,
    );
    assert.equal(second[0].tokensPerSecond, null);
    assert.equal(second[0].decoded, 3);
  });

  it('ignores a body that is not a slot array', () => {
    assert.deepEqual(normalizeSlots(null, new Map(), 0), []);
    assert.deepEqual(normalizeSlots({ error: 'slots disabled' }, new Map(), 0), []);
  });
});

describe('parseLlamaCppDeferred', () => {
  it('reads the colon-form gauge llama.cpp prints', () => {
    const text = [
      '# HELP llamacpp:requests_deferred Number of requests deferred.',
      '# TYPE llamacpp:requests_deferred gauge',
      'llamacpp:requests_deferred 3',
    ].join('\n');
    assert.equal(parseLlamaCppDeferred(text), 3);
  });

  it('reads the underscore form and labelled gauges', () => {
    assert.equal(parseLlamaCppDeferred('llamacpp_requests_deferred{host="x"} 2\n'), 2);
  });

  it('returns 0 when the gauge is missing or the body is not text', () => {
    assert.equal(parseLlamaCppDeferred('llamacpp:requests_processing 1\n'), 0);
    assert.equal(parseLlamaCppDeferred(null), 0);
    assert.equal(parseLlamaCppDeferred(''), 0);
  });
});

function slotsFetch(slots, metricsBody = 'llamacpp:requests_deferred 0\n') {
  return async (url) => {
    const href = String(url);
    if (href.includes('/metrics')) {
      return { ok: true, text: async () => metricsBody };
    }
    return { ok: true, json: async () => slots };
  };
}

describe('the /slots poller', () => {
  it('publishes a normalised sample for a running serve', async () => {
    stopAllServeActivity();
    setServeActivityFetchForTests(
      slotsFetch(
        [
          {
            id: 0,
            is_processing: true,
            id_task: 42,
            n_prompt_tokens_processed: 2048,
            next_token: [{ n_remain: 0, n_decoded: 0 }],
          },
        ],
        'llamacpp:requests_deferred 0\n',
      ),
    );

    startServeActivity({ id: 'serve-a', baseUrl: 'http://127.0.0.1:9999', runtime: 'llama-cpp' });
    const activity = await nextActivity();
    assert.equal(activity.serveId, 'serve-a');
    assert.equal(activity.available, true);
    assert.equal(activity.stale, false);
    assert.equal(activity.queued, 0);
    assert.equal(activity.slots[0].state, 'prompt');
    assert.equal(activity.slots[0].promptProcessed, 2048);
    stopAllServeActivity();
  });

  it('surfaces llama.cpp deferred requests as queue depth', async () => {
    stopAllServeActivity();
    setServeActivityFetchForTests(
      slotsFetch(
        [{ id: 0, is_processing: true, id_task: 1, next_token: [{ n_remain: 10, n_decoded: 4 }] }],
        'llamacpp:requests_deferred 2\n',
      ),
    );

    startServeActivity({ id: 'serve-q', baseUrl: 'http://127.0.0.1:9999', runtime: 'llama-cpp' });
    const activity = await nextActivity();
    assert.equal(activity.queued, 2);
    stopAllServeActivity();
  });

  it('marks a serve stale instead of idle when /slots stops answering', async () => {
    stopAllServeActivity();
    setServeActivityFetchForTests(async () => {
      throw new Error('timeout');
    });

    startServeActivity({ id: 'serve-b', baseUrl: 'http://127.0.0.1:9999', runtime: 'llama-cpp' });
    const activity = await nextActivity();
    assert.equal(activity.available, false);
    assert.equal(activity.stale, true);
    // Crucially not an empty "Ready" — a saturated server must not read as idle.
    assert.deepEqual(activity.slots, []);
    stopAllServeActivity();
  });

  it('keeps the last good sample when a later poll fails', async () => {
    stopAllServeActivity();
    let slotPolls = 0;
    setServeActivityFetchForTests(async (url) => {
      const href = String(url);
      if (href.includes('/metrics')) {
        return { ok: true, text: async () => 'llamacpp:requests_deferred 1\n' };
      }
      slotPolls += 1;
      if (slotPolls > 1) throw new Error('busy');
      return {
        ok: true,
        json: async () => [
          { id: 0, is_processing: true, id_task: 5, next_token: [{ n_remain: 50, n_decoded: 12 }] },
        ],
      };
    });

    startServeActivity({ id: 'serve-c', baseUrl: 'http://127.0.0.1:9999', runtime: 'llama-cpp' });
    const first = await nextActivity();
    assert.equal(first.stale, false);
    // subscribeServeActivity replays the last sample; ignore that and wait for the failed poll.
    const afterFailure = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error('stale sample never published'));
      }, 3_000);
      const unsubscribe = subscribeServeActivity((activity) => {
        if (!activity.stale) return;
        clearTimeout(timer);
        unsubscribe();
        resolve(activity);
      });
    });
    assert.equal(afterFailure.stale, true);
    assert.equal(afterFailure.slots[0].decoded, 12, 'last good sample is kept, not discarded');
    stopAllServeActivity();
  });

  it('does not poll a non-llama.cpp serve', () => {
    stopAllServeActivity();
    startServeActivity({ id: 'serve-mlx', baseUrl: 'http://127.0.0.1:9999', runtime: 'mlx-lm' });
    assert.equal(getServeActivity('serve-mlx'), null);
    assert.deepEqual(listServeActivity(), []);
  });
});
