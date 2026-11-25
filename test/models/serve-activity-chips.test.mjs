import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  formatQueuedChipLabel,
  serveActivityChipLabels,
} from '../../src/models/serve-activity-chips.ts';

const IDLE = {
  serveId: 'serve-1',
  modelLabel: 'qwen',
  libraryId: 'lib-1',
  updatedAt: 1,
  available: true,
  stale: false,
  queued: 0,
  slots: [
    {
      id: 0,
      taskId: null,
      state: 'idle',
      promptProcessed: 0,
      promptCached: 0,
      decoded: 0,
      remaining: null,
      tokensPerSecond: null,
    },
  ],
};

describe('serve activity chip labels', () => {
  test('idle host is Ready', () => {
    assert.deepEqual(serveActivityChipLabels(IDLE), ['Ready']);
  });

  test('queue depth replaces Ready when the host is backed up', () => {
    assert.deepEqual(serveActivityChipLabels({ ...IDLE, queued: 2 }), ['2 queued']);
    assert.equal(formatQueuedChipLabel(1), '1 queued');
  });

  test('busy slot keeps its chip and appends queue depth', () => {
    const activity = {
      ...IDLE,
      queued: 3,
      slots: [
        {
          id: 0,
          taskId: 9,
          state: 'generating',
          promptProcessed: 100,
          promptCached: 0,
          decoded: 917,
          remaining: 20,
          tokensPerSecond: 40,
        },
      ],
    };
    assert.deepEqual(serveActivityChipLabels(activity), ['0 GEN 917 tok', '3 queued']);
  });

  test('stale idle without a queue still says the reading is old', () => {
    assert.deepEqual(serveActivityChipLabels({ ...IDLE, stale: true }), ['Ready · stale']);
  });

  test('prefill is a percent when Minnow owns prompt_progress for this serve', () => {
    const activity = {
      ...IDLE,
      slots: [
        {
          id: 0,
          taskId: 1,
          state: 'prompt',
          promptProcessed: 8192,
          promptCached: 0,
          decoded: 0,
          remaining: null,
          tokensPerSecond: null,
        },
      ],
    };
    const overlay = {
      serveId: 'serve-1',
      libraryId: 'lib-1',
      modelLabel: 'qwen',
      processed: 8192,
      total: 16384,
      cache: 0,
    };
    assert.deepEqual(serveActivityChipLabels(activity, overlay), ['0 PP 50%']);
  });

  test('prefill is a percent when chat published libraryId without a serve id', () => {
    const activity = {
      ...IDLE,
      slots: [
        {
          id: 0,
          taskId: 1,
          state: 'prompt',
          promptProcessed: 4096,
          promptCached: 0,
          decoded: 0,
          remaining: null,
          tokensPerSecond: null,
        },
      ],
    };
    const overlay = {
      serveId: null,
      libraryId: 'lib-1',
      modelLabel: 'lib-1',
      processed: 4096,
      total: 8192,
      cache: 0,
    };
    assert.deepEqual(serveActivityChipLabels(activity, overlay), ['0 PP 50%']);
  });

  test('prefill stays a token count when the overlay is for another serve', () => {
    const activity = {
      ...IDLE,
      slots: [
        {
          id: 0,
          taskId: 1,
          state: 'prompt',
          promptProcessed: 1200,
          promptCached: 0,
          decoded: 0,
          remaining: null,
          tokensPerSecond: null,
        },
      ],
    };
    const overlay = {
      serveId: 'other',
      libraryId: 'lib-other',
      modelLabel: 'other-model',
      processed: 10,
      total: 100,
      cache: 0,
    };
    assert.deepEqual(serveActivityChipLabels(activity, overlay), ['0 PP 1.2k tok']);
  });

  test('queued chip stays off when mlx synthesis does not set queued', () => {
    const activity = { ...IDLE, queued: 0 };
    assert.deepEqual(serveActivityChipLabels(activity), ['Ready']);
    assert.equal(formatQueuedChipLabel(0), null);
  });
});

describe('MTPLX chips', () => {
  const it = test;
  const mtplx = (live) => ({
    serveId: 's', modelLabel: 'm', libraryId: null, updatedAt: 1, available: true, stale: false, queued: 0, slots: [],
    mtplx: { activeRequests: 1, latest: { decode_tok_s: 92 }, live },
  });
  it('names the live phase instead of a request count', () => {
    assert.deepEqual(serveActivityChipLabels(mtplx({ phase: 'prompt', promptDone: 1000, promptTotal: 4000, promptTokS: 800, decodeTokS: null, completionTokens: null })), ['PP 25%']);
    assert.deepEqual(serveActivityChipLabels(mtplx({ phase: 'generating', promptDone: null, promptTotal: 4000, promptTokS: null, decodeTokS: 44, completionTokens: 2623 })), ['GEN 2.6k tok']);
    assert.deepEqual(serveActivityChipLabels(mtplx(null)), ['1 active']);
  });
});
