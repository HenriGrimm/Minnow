import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AllowanceTracker, allowanceFailure } from '../../server/generations/allowance.js';
import { classifyAgentCliFailure } from '../../server/generations/agent-cli/errors.js';
import { classifyUpstreamError } from '../../server/generations/fallback.js';
import { getAgentCliAllowanceIdentity } from '../../server/models/agent-cli-usage.js';

const context = { identity: 'account-a', modelId: 'opus' };
const quota = { kind: 'quota', scope: 'provider' };

test('quota scope is shared across models while unrelated accounts remain eligible', () => {
  const tracker = new AllowanceTracker({ now: () => 100 });
  tracker.record(context, quota);
  assert.equal(tracker.availability({ ...context, modelId: 'sonnet' }).available, false);
  assert.equal(tracker.availability({ ...context, identity: 'account-b' }).available, true);
  const model = new AllowanceTracker({ now: () => 100 });
  model.record(context, { ...quota, scope: 'model' });
  assert.equal(model.availability({ ...context, modelId: 'sonnet' }).available, true);
  const family = new AllowanceTracker({ now: () => 100 });
  family.record({ ...context, family: 'opus' }, { ...quota, scope: 'family' });
  assert.equal(family.availability({ ...context, modelId: 'opus-next', family: 'opus' }).available, false);
  assert.equal(family.availability({ ...context, modelId: 'sonnet', family: 'sonnet' }).available, true);
});

test('expiry, cancellation and manual retry allow just one recovery attempt', () => {
  let now = 100;
  const tracker = new AllowanceTracker({ now: () => now });
  tracker.record(context, { ...quota, resetAt: 200 });
  assert.equal(tracker.claim(context), null);
  now = 200;
  const probe = tracker.claim(context);
  assert.ok(probe);
  assert.equal(tracker.claim({ ...context, modelId: 'sonnet' }), null);
  probe.finish(null); // cancellation releases the slot without claiming recovery
  assert.equal(tracker.rows.size, 1);
  const second = tracker.claim(context);
  second.finish(quota);
  assert.equal(tracker.availability(context).available, false);
  tracker.retry(context);
  const third = tracker.claim(context);
  tracker.retry(context);
  assert.equal(tracker.claim(context), null);
  third.finish(null, true);
  assert.equal(tracker.rows.size, 0);
});

test('a late successful probe cannot clear a newer refusal', () => {
  const tracker = new AllowanceTracker({ now: () => 100 });
  tracker.record(context, quota);
  tracker.retry(context);
  const probe = tracker.claim(context);
  tracker.record(context, quota);
  probe.finish(null, true);
  assert.equal(tracker.availability(context).available, false);
  assert.equal(tracker.block(context).row.failures, 2);
});

test('short backoff keeps the original request retry while blocking unrelated requests', () => {
  const tracker = new AllowanceTracker({ now: () => 100 });
  const original = { ...context, requestId: 'first' };
  tracker.record(original, { kind: 'rate_limit', scope: 'model' });
  assert.equal(tracker.claim({ ...context, requestId: 'second' }), null);
  const retry = tracker.claim(original);
  assert.ok(retry);
  assert.equal(tracker.claim(original), null);
  retry.finish(null, true);
  assert.equal(tracker.availability(context).available, true);
});

test('incomplete repeated refusals do not shorten a known reset', () => {
  const tracker = new AllowanceTracker({ now: () => 100 });
  tracker.record(context, { ...quota, resetAt: 100 + 86400_000 });
  tracker.record(context, quota);
  assert.equal(tracker.block(context).row.retryAt, 100 + 86400_000);
});

test('CLI environment credentials invalidate allowance fingerprints without account requests', async () => {
  const first = await getAgentCliAllowanceIdentity('claude', { env: { ANTHROPIC_API_KEY: 'first-key' } });
  const second = await getAgentCliAllowanceIdentity('claude', { env: { ANTHROPIC_API_KEY: 'second-key' } });
  assert.notEqual(first, second);
  assert.doesNotMatch(first, /first-key/);
});

test('unknown resets back off to six hours and survive reload without vendor diagnostics', () => {
  const tracker = new AllowanceTracker({ now: () => 100 });
  for (let count = 0; count < 20; count++) tracker.record(context, { ...quota, rawBody: 'SECRET', message: 'SECRET' });
  const saved = tracker.snapshot();
  assert.equal(tracker.block(context).row.retryAt, 100 + 6 * 3600_000);
  assert.doesNotMatch(JSON.stringify(saved), /SECRET/);
  const reopened = new AllowanceTracker({ rows: saved, now: () => 101 });
  assert.equal(reopened.availability(context).available, false);
  tracker.record({ ...context, identity: 'rate' }, { kind: 'rate_limit', scope: 'model' });
  assert.equal(Object.keys(tracker.snapshot()).length, 1);
});

test('HTTP and CLI refusals preserve quota, scope and unclamped retry information', () => {
  const quota429 = classifyUpstreamError(null, { status: 429, headers: new Headers({ 'Retry-After': '259200' }) }, 'Usage limit reached');
  assert.equal(quota429.failure.kind, 'quota');
  assert.equal(quota429.failure.retryAfterMs, 259200000);
  assert.equal(allowanceFailure('credit balance is too low').scope, 'provider');
  assert.equal(allowanceFailure('Weekly usage limit reached').scope, 'model');
  assert.equal(allowanceFailure('Something went wrong'), null);
  const rate429 = classifyUpstreamError(null, { status: 429 }, 'Too many requests');
  assert.equal(rate429.failure.kind, 'rate_limit');
  const cli = classifyAgentCliFailure({ terminal: { ok: false, error: "You've hit your limit" } });
  assert.equal(cli.quotaExceeded, true);
  assert.equal(cli.failure.scope, 'provider');
  assert.equal(classifyAgentCliFailure({ error: new Error("You've hit your usage limit") }).quotaExceeded, true);
  assert.equal(classifyAgentCliFailure({ error: new Error('429 Too many requests') }).kind, 'retryable');
  assert.equal(classifyAgentCliFailure({ error: new Error('401 Unauthorized') }).quotaExceeded, undefined);
});
