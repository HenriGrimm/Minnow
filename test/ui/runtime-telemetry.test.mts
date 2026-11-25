import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ServeActivity } from '../../src/models/api-client';
import { runtimeFigures, runtimeNow } from '../../src/ui/models/runtime-telemetry';

const base: ServeActivity = { serveId: 's', modelLabel: 'm', libraryId: null, updatedAt: 1, available: true, stale: false, queued: 0, slots: [] };
const mtplx = (activeRequests: number, live: NonNullable<ServeActivity['mtplx']>['live']): ServeActivity => ({
  ...base,
  mtplx: { activeRequests, live, latest: { decode_tok_s: 51, prefill_tok_s: 95.8, ttft_s: 0.35, cached_tokens: 85564, prompt_tokens: 85600 } as never },
});

describe('runtimeNow', () => {
  it('reads MTPLX prefill as prompt progress with its own speed', () => {
    const now = runtimeNow(mtplx(1, { phase: 'prompt', promptTotal: 46130, promptDone: 18400, promptTokS: 1240, decodeTokS: null, completionTokens: null }));
    assert.equal(now.label, 'Reading prompt 39%');
    assert.equal(now.rate, 1240);
    assert.equal(now.detail, '18.4K of 46.1K');
  });

  it('reads MTPLX decode with the live rate and token count', () => {
    const now = runtimeNow(mtplx(1, { phase: 'generating', promptTotal: 46130, promptDone: null, promptTokS: null, decodeTokS: 44.8, completionTokens: 2623 }));
    assert.deepEqual([now.label, now.rate, now.detail], ['Generating', 44.8, '2.6K tokens']);
  });

  it('is Ready with no live rate when nothing runs', () => {
    assert.deepEqual([runtimeNow(mtplx(0, null)).label, runtimeNow(mtplx(0, null)).rate], ['Ready', null]);
  });
});

describe('runtimeFigures', () => {
  it('labels MTPLX figures as the last request', () => {
    const set = runtimeFigures(mtplx(0, null));
    assert.equal(set?.caption, 'Last request');
    assert.deepEqual(set?.figures.map((f) => `${f.label} ${f.value}`), [
      'Generation 51.0 tok/s', 'Prompt 95.8 tok/s', 'First token 0.35 s', 'From cache 85.6K of 85.6K',
    ]);
  });

  it('shows llama.cpp slot occupancy', () => {
    const slot = { id: 0, taskId: 1, promptProcessed: 0, promptCached: 0, decoded: 0, remaining: null, tokensPerSecond: null };
    const set = runtimeFigures({ ...base, slots: [{ ...slot, state: 'generating' }, { ...slot, id: 1, state: 'idle' }] });
    assert.deepEqual(set, { caption: 'Slots', figures: [{ label: 'Busy', value: '1 of 2' }] });
  });
});
