/** Plain-language classification for failed chat turns (managed card + legacy bubble). */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { classifyTurnFailure, formatAvailableAt, formatWait } from '../../src/chat/turn-failure.ts';

const NOW = Date.UTC(2026, 10, 20, 15, 0);

describe('classifyTurnFailure', () => {
  test('subscription CLI auth failures offer inline sign-in', () => {
    const view = classifyTurnFailure({
      message: 'Agent CLI authentication failed. Sign in from Models → Subscriptions. Not logged in · Please run /login',
      providerId: 'claude-code-cli',
    });
    assert.equal(view.kind, 'signed_out');
    assert.equal(view.title, 'You’re signed out of Claude Code');
    assert.deepEqual(view.signIn, { kind: 'claude', label: 'Claude Code' });
    assert.equal(view.settings, 'clis');
    // The server-added prefix is guidance we already render; details keep the provider's words.
    assert.equal(view.detail, 'Not logged in · Please run /login');
  });

  test('API providers that reject credentials point to Providers, not sign-in', () => {
    const view = classifyTurnFailure({ message: 'Upstream HTTP 401 (auth)', providerId: 'openai', providerLabel: 'OpenAI' });
    assert.equal(view.kind, 'api_key');
    assert.equal(view.signIn, undefined);
    assert.equal(view.settings, 'providers');
    assert.match(view.title, /OpenAI/);
  });

  test('structured quota failures report when usage comes back', () => {
    const resetAt = NOW + 3 * 3600_000;
    const view = classifyTurnFailure({
      message: 'You have hit your usage limit',
      failure: { kind: 'quota', resetAt, providerId: 'codex-cli', modelId: 'gpt-5' },
      now: NOW,
    });
    assert.equal(view.kind, 'usage_limit');
    assert.equal(view.title, 'You’re out of usage on Codex');
    assert.equal(view.availableAt, resetAt);
    assert.match(view.body, /resets today at|resets tomorrow at/);
  });

  test('quota wins over an auth-looking status and unknown resets still read clearly', () => {
    const view = classifyTurnFailure({ message: 'Upstream HTTP 402 (payment required)', failure: { quotaExceeded: true }, now: NOW });
    assert.equal(view.kind, 'usage_limit');
    assert.equal(view.availableAt, undefined);
    assert.match(view.body, /Retry once it resets/);
  });

  test('a past reset time is not offered as a future retry', () => {
    const view = classifyTurnFailure({ failure: { kind: 'quota', resetAt: NOW - 1000 }, now: NOW });
    assert.equal(view.availableAt, undefined);
  });

  test('rate limits, unreachable providers, model, context and timeouts are distinct', () => {
    assert.equal(classifyTurnFailure({ message: 'Upstream HTTP 429', failure: { kind: 'rate_limit', retryAt: NOW + 60_000 }, now: NOW }).kind, 'rate_limit');
    assert.equal(classifyTurnFailure({ message: 'fetch failed: ECONNREFUSED 127.0.0.1:1234' }).kind, 'unreachable');
    assert.equal(classifyTurnFailure({ failure: { providerUnreachable: true } }).kind, 'unreachable');
    assert.equal(classifyTurnFailure({ message: 'Upstream HTTP 400 (bad request / model not found)' }).kind, 'model_unavailable');
    assert.equal(classifyTurnFailure({ message: "This model's maximum context length is 8192 tokens" }).kind, 'context_limit');
    assert.equal(classifyTurnFailure({ failure: { outcome: 'timeout' } }).kind, 'timeout');
  });

  test('unknown failures stay generic and keep the raw reason as detail', () => {
    const view = classifyTurnFailure({ message: 'runTurn: something odd' });
    assert.equal(view.kind, 'generic');
    assert.equal(view.title, 'This turn didn’t finish');
    assert.equal(view.detail, 'runTurn: something odd');
    assert.equal(classifyTurnFailure({}).detail, undefined);
  });
});

describe('availability formatting', () => {
  test('short waits are relative, longer ones name a day', () => {
    assert.equal(formatWait(30_000), 'in 1 minute');
    assert.equal(formatWait(25 * 60_000), 'in 25 minutes');
    assert.equal(formatWait(130 * 60_000), 'in about 2 hours');
    const now = new Date(2026, 10, 20, 9, 0).getTime();
    assert.match(formatAvailableAt(new Date(2026, 10, 20, 16, 0).getTime(), now), /^today at /);
    assert.match(formatAvailableAt(new Date(2026, 10, 21, 9, 0).getTime(), now), /^tomorrow at /);
    assert.doesNotMatch(formatAvailableAt(new Date(2026, 10, 24, 9, 0).getTime(), now), /^(today|tomorrow)/);
  });
});
