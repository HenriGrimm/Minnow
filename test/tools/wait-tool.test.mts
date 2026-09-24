/**
 * `wait` tool: duration parsing, formatting, and the timer capability.
 */

import assert from 'node:assert/strict';
import { afterEach, before, describe, test } from 'node:test';
import { installHappyDomGlobals } from '../os/dom-helpers.mts';
import {
  DEFAULT_WAIT_REASON,
  MAX_WAIT_MS,
  createWaitCapability,
  formatWaitDuration,
  parseWaitDuration,
  resetWaitTimersForTests,
} from '../../src/tools/wait-tool.ts';
import {
  executeTool,
  setWaitCapabilityFactoryForTests,
} from '../../src/tools/client.ts';

function okMs(raw: unknown): number {
  const parsed = parseWaitDuration(raw);
  assert.equal(parsed.ok, true, `expected ${String(raw)} to parse`);
  return parsed.ok ? parsed.ms : -1;
}

function errorText(raw: unknown): string {
  const parsed = parseWaitDuration(raw);
  assert.equal(parsed.ok, false, `expected ${String(raw)} to be rejected`);
  return parsed.ok ? '' : parsed.error;
}

describe('parseWaitDuration', () => {
  test('parses single-unit strings', () => {
    assert.equal(okMs('30s'), 30_000);
    assert.equal(okMs('5m'), 300_000);
    assert.equal(okMs('2h'), MAX_WAIT_MS);
  });

  test('parses compound strings', () => {
    assert.equal(okMs('1h30m'), 5_400_000);
    assert.equal(okMs('90m'), 5_400_000);
    assert.equal(okMs('1h5m30s'), 3_930_000);
  });

  test('parses a bare number as seconds', () => {
    assert.equal(okMs(90), 90_000);
    assert.equal(okMs('90'), 90_000);
  });

  test('rejects durations above the 2h cap', () => {
    const message = errorText('3h');
    assert.match(message, /2h/);
    assert.equal(parseWaitDuration(MAX_WAIT_MS + 1).ok, false);
  });

  test('rejects empty, zero, negative, and non-numeric input', () => {
    for (const raw of ['', '   ', 'abc', '5 minutes', 0, -1, Number.NaN, null, undefined, {}]) {
      assert.equal(parseWaitDuration(raw).ok, false, `expected ${String(raw)} to be rejected`);
    }
  });
});

describe('formatWaitDuration', () => {
  test('formats seconds, minutes, and compound durations', () => {
    assert.equal(formatWaitDuration(30_000), '30s');
    assert.equal(formatWaitDuration(300_000), '5m');
    assert.equal(formatWaitDuration(5_400_000), '1h30m');
    assert.equal(formatWaitDuration(3_600_000), '1h');
    assert.equal(formatWaitDuration(0), '0s');
  });
});

describe('createWaitCapability', () => {
  afterEach(() => {
    resetWaitTimersForTests();
  });

  test('resolves with a completion message naming the duration and reason', async () => {
    const content = await createWaitCapability().wait({
      durationMs: 20,
      reason: 'dev server boot',
    });
    assert.ok(content.startsWith('Timer completed after'), content);
    assert.match(content, /dev server boot/);
    assert.match(content, /Continue now\./);
  });

  test('falls back to a default reason when none is given', async () => {
    const content = await createWaitCapability().wait({ durationMs: 20, reason: '  ' });
    assert.match(content, new RegExp(DEFAULT_WAIT_REASON));
  });

  test('rejects with AbortError when the signal aborts mid-wait', async () => {
    const controller = new AbortController();
    const pending = createWaitCapability().wait({
      durationMs: 5_000,
      reason: 'aborted',
      signal: controller.signal,
    });
    controller.abort();
    await assert.rejects(pending, (err: Error) => err.name === 'AbortError');
  });

  test('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      createWaitCapability().wait({
        durationMs: 20,
        reason: 'already aborted',
        signal: controller.signal,
      }),
      (err: Error) => err.name === 'AbortError',
    );
  });

  test('leaves no pending timer after a completed wait', async () => {
    await createWaitCapability().wait({ durationMs: 20, reason: 'cleanup' });
    // A leaked timer would keep the process alive past this sentinel.
    await new Promise((resolve) => setTimeout(resolve, 50));
    resetWaitTimersForTests();
  });
});

describe('executeTool("wait")', () => {
  // The client executor pulls in config/UI modules that expect a DOM.
  before(async () => {
    const { Window } = await import('happy-dom');
    installHappyDomGlobals(new Window());
  });

  afterEach(() => {
    setWaitCapabilityFactoryForTests(null);
    resetWaitTimersForTests();
  });

  test('returns the timer result through the tool executor', async () => {
    setWaitCapabilityFactoryForTests(() => ({
      wait: async ({ durationMs, reason }) =>
        `Timer completed after ${formatWaitDuration(durationMs)} — ${reason}. Continue now.`,
    }));
    const result = await executeTool('wait', { duration: '1s', reason: 'smoke' });
    assert.match(result.content, /^Timer completed after/);
    assert.match(result.content, /smoke/);
  });

  test('rejects a duration above the 2h cap before starting a timer', async () => {
    setWaitCapabilityFactoryForTests(() => ({
      wait: async () => 'should not run',
    }));
    const result = await executeTool('wait', { duration: '3h', reason: 'x' });
    assert.match(result.content, /^Error: duration must be between 1s and 2h/);
  });
});
