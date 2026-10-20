import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeOpenCodeAccountUsage } from '../../server/providers/opencode-account-usage.js';

const checkedAt = '2026-10-20T01:00:00.000Z';
test('Go uses only reported percentages and relative reset times, not guessed dollars', () => {
  const metrics = normalizeOpenCodeAccountUsage({
    rollingUsage: { usagePercent: 42, resetInSec: 3600 },
    weeklyUsage: { usagePercent: 0, resetInSec: 0 },
    monthlyUsage: { usagePercent: 100 },
    useBalance: true,
  }, checkedAt);
  assert.deepEqual(metrics, [
    { label: 'Rolling allowance', used: 42, remaining: 58, limit: 100, unit: '%', resetsAt: '2026-10-20T02:00:00.000Z' },
    { label: 'Weekly allowance', used: 0, remaining: 100, limit: 100, unit: '%', resetsAt: checkedAt },
    { label: 'Monthly allowance', used: 100, remaining: 0, limit: 100, unit: '%' },
  ]);
});
test('missing or malformed Go data remains unknown and cannot become a zero figure', () => {
  for (const value of [null, undefined, '', '0', NaN, Infinity, -1, 101]) {
    assert.deepEqual(normalizeOpenCodeAccountUsage({ rollingUsage: { usagePercent: value } }, checkedAt), []);
  }
  assert.deepEqual(normalizeOpenCodeAccountUsage({}, checkedAt), []);
  assert.deepEqual(normalizeOpenCodeAccountUsage(null, checkedAt), []);
  assert.equal(normalizeOpenCodeAccountUsage({ rollingUsage: { usagePercent: 5, resetInSec: Number.MAX_VALUE } }, checkedAt)[0].resetsAt, undefined);
});
