import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { liveFromSnapshot } from '../../server/models/mtplx-activity.js';
import type { ServeActivity, ServeActivitySlot } from '../../src/models/api-client';
import { localModelPhase } from '../../src/models/local-model-phase';

const base: ServeActivity = {
  serveId: 'serve', modelLabel: 'model', libraryId: 'model', updatedAt: 1,
  available: true, stale: false, queued: 0, slots: [],
};
const slot = (over: Partial<ServeActivitySlot>): ServeActivitySlot => ({
  id: 0, taskId: 1, state: 'idle', promptProcessed: 0, promptCached: 0, decoded: 0,
  remaining: null, tokensPerSecond: null, promptTokensPerSecond: null, ...over,
});
const mtplx = (activeRequests: number, live: NonNullable<ServeActivity['mtplx']>['live'], latest = null as { decode_tok_s?: number } | null) =>
  ({ ...base, slots: [], mtplx: { activeRequests, live, latest } }) as ServeActivity;

describe('MTPLX snapshot', () => {
  it('reads chunked prefill as the prompt phase with its live rate', () => {
    const live = liveFromSnapshot({ in_flight: [{ prompt_tokens: 4000, last_progress: null,
      prefill_state: { phase: 'chunk', tokens_done: 1000, tokens_total: 4000, live_prefill_tok_s: 850, prefill_tok_s: 700 } }] });
    assert.deepEqual(live, { phase: 'prompt', promptTotal: 4000, promptDone: 1000, promptTokS: 850, decodeTokS: null, completionTokens: null });
  });

  it('reads decode progress as generating with the recent phase rate', () => {
    const live = liveFromSnapshot({ in_flight: [{ prompt_tokens: 4000, prefill_state: null,
      last_progress: { completion_tokens: 120, decode_tok_s: 51, phase_tok_s: 64 } }] });
    assert.equal(live?.phase, 'generating');
    assert.equal(live?.decodeTokS, 64);
  });

  it('is null without an in-flight request or snapshot', () => {
    assert.equal(liveFromSnapshot(null), null);
    assert.equal(liveFromSnapshot({ in_flight: [] }), null);
  });
});

describe('localModelPhase', () => {
  it('shows MTPLX prompt progress and speed', () => {
    const phase = localModelPhase(mtplx(1, { phase: 'prompt', promptTotal: 4000, promptDone: 1000, promptTokS: 850, decodeTokS: null, completionTokens: null }));
    assert.deepEqual(phase, { phase: 'prompt', rate: 850, progress: 0.25 });
  });

  it('uses the live MTPLX decode rate, not the last completed request', () => {
    const phase = localModelPhase(mtplx(1, { phase: 'generating', promptTotal: 4000, promptDone: null, promptTokS: null, decodeTokS: 64, completionTokens: 120 }, { decode_tok_s: 92 }));
    assert.deepEqual(phase, { phase: 'generating', rate: 64, progress: null });
  });

  it('treats MTPLX with no active request as idle', () => {
    assert.equal(localModelPhase(mtplx(0, null, { decode_tok_s: 92 })).phase, 'idle');
  });

  it('shows llama.cpp prefill with a percent only when Minnow owns the stream', () => {
    const activity = { ...base, slots: [slot({ state: 'prompt', promptProcessed: 2048, promptTokensPerSecond: 1200 })] };
    assert.deepEqual(localModelPhase(activity), { phase: 'prompt', rate: 1200, progress: null });
    const overlay = { serveId: 'serve', libraryId: 'model', modelLabel: 'model', processed: 2048, total: 8192, cache: 0, predictedN: 0 };
    assert.deepEqual(localModelPhase(activity, overlay), { phase: 'prompt', rate: 1200, progress: 0.25 });
  });

  it('prefers a generating slot and goes idle when stale', () => {
    const activity = { ...base, slots: [slot({ id: 1, state: 'prompt' }), slot({ state: 'generating', tokensPerSecond: 40 })] };
    assert.equal(localModelPhase(activity).phase, 'generating');
    assert.equal(localModelPhase({ ...activity, stale: true }).phase, 'idle');
  });
});
