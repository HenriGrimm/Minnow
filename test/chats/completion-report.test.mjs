import assert from 'node:assert/strict';
import { test } from 'node:test';
import { completionReport } from '../../server/chats/completion-report.js';

test('completion includes actionable findings, sources, artifacts and validation', () => {
  const report = completionReport({ summary: 'One issue', evidence: ['Probe failed as expected'] }, JSON.stringify({
    summary: 'One issue', findings: [{ severity: 'warn', title: 'Stale cache',
      detail: 'Revocation retains data. Fix: replace the cache.', paths: ['src/cache.ts:42'] }],
    artifacts: [{ label: 'Reproduction', ref: 'test/cache.test.ts' }],
  }));
  for (const expected of ['Probe failed', 'Stale cache', 'Revocation', 'Fix:', 'src/cache.ts:42', 'test/cache.test.ts']) assert.ok(report.includes(expected));
  assert.equal(report.match(/One issue/g).length, 1);
});

test('report-only executions retain evidence and blocked results retain missing prerequisites', () => {
  assert.match(completionReport({ summary: 'Verified', evidence: ['src/a.ts:12 — failing probe'] }), /failing probe/);
  assert.match(completionReport({ summary: 'Blocked', needs: ['Database fixture'] }), /Database fixture/);
  assert.equal(completionReport({}, 'Plain final answer'), 'Plain final answer');
});

test('oversized completion reports are bounded and explicitly excerpted', () => {
  const report = completionReport({ summary: 'Finding '.repeat(4000) });
  assert.equal(report.length, 12000);
  assert.match(report, /Report excerpted; open the linked child/);
});
