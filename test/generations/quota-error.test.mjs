/**
 * Spent-allowance detection: a weekly cap and ordinary backpressure both
 * arrive as HTTP 429, and only one of them is worth retrying.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  detectQuotaExhausted,
  formatOutOfUsageMessage,
  isQuotaExhaustedText,
  parseQuotaResetHint,
  QUOTA_RETRY_AFTER_MS,
} from '../../server/generations/quota-error.js';
import { classifyUpstreamError } from '../../server/generations/fallback.js';

/** The body that abandoned two board tasks overnight on 2026-09-10. */
const OPENCODE_GO_BODY = JSON.stringify({
  type: 'error',
  error: {
    type: 'GoUsageLimitError',
    message:
      'Weekly usage limit reached. Resets in 3 days. To continue using this model now, ' +
      'enable usage from your available balance: https://opencode.ai/workspace/wrk_01/go',
  },
  metadata: { workspace: 'wrk_01', limitName: 'weekly' },
});

describe('isQuotaExhaustedText', () => {
  test('recognizes a spent allowance across providers', () => {
    assert.equal(isQuotaExhaustedText(OPENCODE_GO_BODY), true);
    assert.equal(isQuotaExhaustedText('You exceeded your current quota'), true);
    assert.equal(isQuotaExhaustedText('{"error":{"code":"insufficient_quota"}}'), true);
    assert.equal(isQuotaExhaustedText('Your credit balance is too low'), true);
    assert.equal(isQuotaExhaustedText('Out of credits — purchase more credits'), true);
  });

  test('leaves ordinary backpressure alone', () => {
    assert.equal(isQuotaExhaustedText('Rate limit exceeded, please retry'), false);
    assert.equal(isQuotaExhaustedText('Too Many Requests'), false);
    assert.equal(isQuotaExhaustedText('server is overloaded, try again'), false);
    assert.equal(isQuotaExhaustedText(''), false);
    assert.equal(isQuotaExhaustedText(undefined), false);
  });
});

describe('detectQuotaExhausted', () => {
  test('402 is always a spent allowance', () => {
    assert.equal(detectQuotaExhausted({ status: 402 }), true);
  });

  test('a 429 body that names the cap counts', () => {
    assert.equal(detectQuotaExhausted({ status: 429, body: OPENCODE_GO_BODY }), true);
  });

  test('a bare 429 does not', () => {
    assert.equal(detectQuotaExhausted({ status: 429, body: '' }), false);
    assert.equal(detectQuotaExhausted({ status: 429 }), false);
  });

  test('a Retry-After past the ceiling is a quota window, not backpressure', () => {
    assert.equal(detectQuotaExhausted({ status: 429, retryAfterMs: QUOTA_RETRY_AFTER_MS }), true);
    assert.equal(detectQuotaExhausted({ status: 429, retryAfterMs: 30_000 }), false);
  });
});

describe('parseQuotaResetHint', () => {
  test('recovers the provider reset phrase', () => {
    assert.equal(parseQuotaResetHint(OPENCODE_GO_BODY), '3 days');
    assert.equal(parseQuotaResetHint('try again in 45 minutes.'), '45 minutes');
    assert.equal(parseQuotaResetHint('no hint here'), null);
  });
});

describe('formatOutOfUsageMessage', () => {
  test('names the provider and the reset when both are known', () => {
    const message = formatOutOfUsageMessage({
      detail: OPENCODE_GO_BODY,
      providerLabel: 'opencode-go',
    });
    assert.match(message, /^Out of usage on opencode-go\./);
    assert.match(message, /Resets in 3 days\./);
  });

  test('reads cleanly with neither', () => {
    assert.equal(
      formatOutOfUsageMessage(),
      'Out of usage. The provider will not accept more requests until the allowance resets.',
    );
  });
});

describe('classifyUpstreamError on a spent allowance', () => {
  test('a quota 429 is fatal, not retryable', () => {
    const classified = classifyUpstreamError(null, { status: 429 }, OPENCODE_GO_BODY);
    assert.equal(classified.kind, 'fatal');
    assert.equal(classified.quotaExceeded, true);
    assert.notEqual(classified.rateLimited, true);
  });

  test('a 429 without a quota body stays retryable', () => {
    const classified = classifyUpstreamError(null, { status: 429 }, 'Too Many Requests');
    assert.equal(classified.kind, 'retryable');
    assert.equal(classified.rateLimited, true);
    assert.notEqual(classified.quotaExceeded, true);
  });

  test('402 is fatal even with no body', () => {
    const classified = classifyUpstreamError(null, { status: 402 });
    assert.equal(classified.kind, 'fatal');
    assert.equal(classified.quotaExceeded, true);
  });

  test('a multi-day Retry-After is fatal rather than a 30s backoff', () => {
    const classified = classifyUpstreamError(null, {
      status: 429,
      headers: new Headers({ 'retry-after': '259200' }),
    });
    assert.equal(classified.kind, 'fatal');
    assert.equal(classified.quotaExceeded, true);
  });

  test('an SDK error whose message names the cap is fatal', () => {
    const classified = classifyUpstreamError(
      new Error('Upstream HTTP 429: Weekly usage limit reached. Resets in 3 days.'),
    );
    assert.equal(classified.kind, 'fatal');
    assert.equal(classified.quotaExceeded, true);
  });
});
