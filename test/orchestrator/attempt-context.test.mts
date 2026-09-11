import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { latestAttemptContext, renderAttemptContext } from '../../src/orchestrator/attempt-context.ts';

test('uses the latest round, including a decrease after compression, without summing usage', () => {
  const context = latestAttemptContext([
    { type: 'context_usage', used: 9000, limit: 10000, isEstimate: false },
    { type: 'context_usage', used: 3000, limit: 10000, isEstimate: true },
    { type: 'round_end', usage: { total_tokens: 12000 } },
  ]);
  assert.deepEqual(context, { used: 3000, limit: 10000, isEstimate: true, percent: 30 });
  assert.equal(latestAttemptContext([]), null);
  assert.equal(latestAttemptContext([{ type: 'context_usage', used: NaN }]), null);
  assert.equal(latestAttemptContext([{ type: 'context_usage', used: 4, limit: 0 }])?.limit, null);
});

test('renders overflow, estimates and missing measurements accessibly', () => {
  const window = new Window();
  globalThis.document = window.document as unknown as Document;
  const view = renderAttemptContext([{ type: 'context_usage', used: 110, limit: 100, isEstimate: true }]);
  assert.match(view.querySelector('summary')!.textContent!, /Context ~110 \/ 100/);
  assert.match(view.textContent!, /110% used. 0 tokens remaining/);
  assert.equal(view.classList.contains('ov2-context--warn'), true);
  assert.equal((view.querySelector('.ov2-context__wheel') as HTMLElement).style.getPropertyValue('--context-fill'), '100%');
  assert.match(renderAttemptContext([]).textContent!, /Context unavailable/);
  assert.match(renderAttemptContext([{ type: 'context_usage', used: 10, limit: null }]).textContent!, /Context limit unknown/);
  window.happyDOM.abort();
});
