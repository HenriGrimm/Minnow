import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { buildUsageTimeline, usageAxisMaximum } from '../../src/usage/usage-timeline.ts';
import { createUsageTimeline } from '../../src/ui/usage-timeline.ts';
import type { TokenLedgerEntry } from '../../src/usage/types.ts';

function entry(at: number, prompt = 100, completion = 20): TokenLedgerEntry {
  return { id: String(at), at, source: { kind: 'main', modeId: 'build' }, providerId: 'local', modelId: 'test', costUsd: null, usage: { prompt_tokens: prompt, completion_tokens: completion } };
}

test('dense histories preserve totals and empty calendar days without one mark per completion', () => {
  const first = new Date(2026, 7, 3, 12).getTime();
  const last = new Date(2026, 8, 20, 12).getTime();
  const entries = Array.from({ length: 5000 }, (_, i) => entry(i % 2 ? first : last));
  const { buckets, interval } = buildUsageTimeline(entries, 0, last);
  assert.equal(interval, 'day');
  assert.equal(buckets.length, 49);
  assert.equal(buckets.reduce((sum, bucket) => sum + bucket.tokens, 0), 600_000);
  assert.equal(buckets.reduce((sum, bucket) => sum + bucket.count, 0), 5000);
  assert.equal(buckets[1]!.count, 0);
  assert.equal(new Date(buckets[0]!.at).getHours(), 0);
  assert.equal(entries[0]!.at, last, 'does not reorder the source ledger');
});

test('ranges filter records, retain zero-token responses, and reject malformed dates and counts', () => {
  const now = new Date(2026, 8, 20, 12).getTime();
  const entries = [entry(now - 10 * 86_400_000), entry(now, 0, 0), entry(NaN), entry(1e20), entry(now + 1), entry(now, -1, NaN)];
  const { buckets } = buildUsageTimeline(entries, 7, now);
  assert.equal(buckets.reduce((sum, bucket) => sum + bucket.count, 0), 2);
  assert.equal(buckets.reduce((sum, bucket) => sum + bucket.tokens, 0), 0);
  assert.deepEqual(buildUsageTimeline([], 0, now).buckets, []);
  assert.equal(usageAxisMaximum(398_216), 400_000);
  assert.equal(usageAxisMaximum(0), 4);
  const totalOnly = entry(now);
  totalOnly.usage = { total_tokens: 42 };
  assert.equal(buildUsageTimeline([totalOnly], 0, now).buckets[0]!.tokens, 42);
});

test('timeline exposes exact values, keyboard navigation, and an empty range state', async () => {
  const win = new Window();
  const previous = globalThis.document;
  Object.assign(globalThis, { document: win.document });
  try {
    const now = Date.now();
    const chart = createUsageTimeline([entry(now - 50 * 86_400_000), entry(now - 40 * 86_400_000)]);
    document.body.appendChild(chart);
    const bars = chart.querySelectorAll('.usage-chart__bucket');
    const active = chart.querySelector('[tabindex="0"]')!;
    assert.match(chart.querySelector('.usage-chart__detail')!.textContent!, /120 tokens/);
    active.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Home', bubbles: true }) as unknown as Event);
    assert.equal(bars[0]!.getAttribute('tabindex'), '0');
    bars[0]!.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }) as unknown as Event);
    assert.equal(bars[1]!.getAttribute('tabindex'), '0');
    assert.match(chart.querySelector('.usage-chart__detail')!.textContent!, /0 tokens/);
    assert.equal(chart.querySelectorAll('[tabindex="0"]').length, 1);
    const range = chart.querySelector('select')!;
    range.value = '7';
    range.dispatchEvent(new win.Event('change') as unknown as Event);
    assert.match(chart.textContent!, /No retained completions in this time range/);
    assert.equal(chart.querySelector('svg'), null);
  } finally {
    Object.assign(globalThis, { document: previous });
    await win.happyDOM.close();
  }
});
