/**
 * Transient fetch retry helper.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  isMidStreamTransportError,
  isProviderUnreachableError,
  isRetryableTransientError,
  isTransientFetchError,
  isTransientHttpError,
  retryOnceOnTransientFetch,
} from '../../src/lib/transient-fetch-retry.ts';

describe('transient-fetch-retry', () => {
  test('isTransientFetchError matches browser TypeError copy', () => {
    assert.equal(isTransientFetchError(new TypeError('Failed to fetch')), true);
    assert.equal(isTransientFetchError(new TypeError('NetworkError')), true);
    assert.equal(isTransientFetchError(new Error('Failed to fetch')), false);
    assert.equal(isTransientFetchError(new TypeError('HTTP 500')), false);
  });

  test('isTransientHttpError matches retryable statuses from HTTP error copy', () => {
    assert.equal(isTransientHttpError(new Error('HTTP 429: rate limited')), true);
    assert.equal(isTransientHttpError(new Error('HTTP 502: bad gateway')), true);
    assert.equal(isTransientHttpError(new Error('HTTP 401: unauthorized')), false);
    assert.equal(isTransientHttpError(new TypeError('Failed to fetch')), false);
  });

  test('retryOnceOnTransientFetch succeeds on second attempt', async () => {
    let calls = 0;
    const result = await retryOnceOnTransientFetch(async () => {
      calls += 1;
      if (calls === 1) {
        throw new TypeError('Failed to fetch');
      }
      return 'ok';
    }, 0);
    assert.equal(result, 'ok');
    assert.equal(calls, 2);
  });

  test('retryOnceOnTransientFetch does not retry non-transient errors', async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        retryOnceOnTransientFetch(async () => {
          calls += 1;
          throw new Error('HTTP 401: unauthorized');
        }, 0),
      /HTTP 401/,
    );
    assert.equal(calls, 1);
  });

  test('retries HTTP 429 with backoff and succeeds before the attempt ceiling', async () => {
    let calls = 0;
    const result = await retryOnceOnTransientFetch(async () => {
      calls += 1;
      if (calls < 3) {
        throw new Error('HTTP 429: rate limited');
      }
      return 'ok';
    }, 0);
    assert.equal(result, 'ok');
    assert.equal(calls, 3);
  });

  test('gives up on persistent HTTP 502 after the attempt ceiling', async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        retryOnceOnTransientFetch(async () => {
          calls += 1;
          throw new Error('HTTP 502: bad gateway');
        }, 0),
      /HTTP 502/,
    );
    assert.equal(calls, 3);
  });
  test('isMidStreamTransportError matches socket deaths, not cancellations', () => {
    assert.equal(
      isMidStreamTransportError(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })),
      true,
    );
    assert.equal(isMidStreamTransportError(new Error('socket hang up')), true);
    assert.equal(isMidStreamTransportError(new TypeError('terminated')), true);
    // undici wraps the real cause one level down.
    assert.equal(
      isMidStreamTransportError(
        new TypeError('fetch failed', {
          cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
        }),
      ),
      true,
    );
    // A user Stop or wall-clock timeout must never be replayed.
    const aborted = new Error('The operation was aborted');
    aborted.name = 'AbortError';
    assert.equal(isMidStreamTransportError(aborted), false);
    assert.equal(isMidStreamTransportError(new Error('HTTP 401: unauthorized')), false);
  });

  test('a mid-stream error is not retryable under the default predicate', async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        retryOnceOnTransientFetch(async () => {
          calls += 1;
          throw new Error('socket hang up');
        }, 0),
      /socket hang up/,
    );
    assert.equal(calls, 1, 'non-streaming callers keep the narrower policy');
  });

  test('isRetryable opts a caller into mid-stream retries and reports each one', async () => {
    let calls = 0;
    const retries: number[] = [];
    const result = await retryOnceOnTransientFetch(
      async () => {
        calls += 1;
        if (calls === 1) throw new Error('socket hang up');
        return 'ok';
      },
      0,
      {
        isRetryable: isMidStreamTransportError,
        onRetry: ({ attempt }) => retries.push(attempt),
      },
    );
    assert.equal(result, 'ok');
    assert.deepEqual(retries, [1]);
  });

  test('an aborted signal short-circuits the retry loop', async () => {
    let calls = 0;
    const controller = new AbortController();
    await assert.rejects(
      () =>
        retryOnceOnTransientFetch(
          async () => {
            calls += 1;
            controller.abort();
            throw new TypeError('Failed to fetch');
          },
          0,
          { signal: controller.signal },
        ),
      /Failed to fetch/,
    );
    assert.equal(calls, 1, 'a cancelled turn must surface as an abort');
  });
  test('isProviderUnreachableError matches Node fetch connection failures', () => {
    const refused = new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1234'), { code: 'ECONNREFUSED' }),
    });
    assert.equal(isProviderUnreachableError(refused), true);
    assert.equal(isRetryableTransientError(refused), true);
    assert.equal(isProviderUnreachableError(new Error('ECONNREFUSED')), true);
    assert.equal(isProviderUnreachableError(new Error('HTTP 503: loading model')), true);
    assert.equal(isProviderUnreachableError(new Error('HTTP 429: rate limited')), false);
    assert.equal(isProviderUnreachableError(new Error('HTTP 400: bad request')), false);
    const aborted = Object.assign(new Error('ECONNREFUSED'), { name: 'AbortError' });
    assert.equal(isProviderUnreachableError(aborted), false);
  });

  test('unreachableWaitMs waits out a refusing provider without spending quick retries', async () => {
    const refused = () => Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    let calls = 0;
    const waits: number[] = [];
    await assert.rejects(
      () =>
        retryOnceOnTransientFetch(
          async () => {
            calls += 1;
            throw refused();
          },
          0,
          { unreachableWaitMs: 20, onUnreachableWait: ({ waitMs }) => waits.push(waitMs) },
        ),
      /ECONNREFUSED/,
    );
    assert.deepEqual(waits, [20], 'the wait is clamped to the remaining budget');
    assert.equal(calls, 4, 'one waited retry, then the usual three quick attempts');

    calls = 0;
    const result = await retryOnceOnTransientFetch(
      async () => {
        calls += 1;
        if (calls < 3) throw refused();
        return 'ok';
      },
      0,
      { unreachableWaitMs: 100 },
    );
    assert.equal(result, 'ok');
  });

  test('an abort during the unreachable wait ends it early', async () => {
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(
      () =>
        retryOnceOnTransientFetch(
          async () => {
            throw Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' });
          },
          0,
          { unreachableWaitMs: 60_000, signal: controller.signal },
        ),
      /ECONNREFUSED/,
    );
    assert.ok(Date.now() - started < 1000);
  });
});
