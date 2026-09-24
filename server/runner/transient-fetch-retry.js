const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429, 502, 503, 504, 529]);

const MAX_TRANSIENT_FETCH_ATTEMPTS = 3;

/**
 * Socket-level failures raised while a response body is being read. Unlike the
 * `TypeError: Failed to fetch` family these surface *after* headers arrived, so
 * a retry replays a request whose stream had already started.
 */
const MID_STREAM_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

const MID_STREAM_ERROR_TEXT = [
  'socket hang up',
  'terminated',
  'premature close',
  'other side closed',
  'network socket disconnected',
  // Some transports stringify the code into the message and drop `cause`.
  'econnreset',
];

function isTransientFetchError(err) {
  if (!(err instanceof TypeError)) return false;
  const message = err.message;
  return message.includes("Failed to fetch") || message.includes("NetworkError");
}

function httpStatusFromError(err) {
  if (!(err instanceof Error)) return null;
  const match = err.message.match(/^HTTP (\d{3})\b/);
  if (!match) return null;
  return Number(match[1]);
}

function isTransientHttpError(err) {
  const status = httpStatusFromError(err);
  return status != null && TRANSIENT_HTTP_STATUSES.has(status);
}

/** Walk the `cause` chain so undici's wrapped socket errors are still seen. */
function errorChain(err) {
  const chain = [];
  let cursor = err;
  while (cursor instanceof Error && chain.length < 5) {
    chain.push(cursor);
    cursor = cursor.cause;
  }
  return chain;
}

/**
 * True when the stream died on the wire rather than being cancelled. An abort
 * (user Stop, wall-clock timeout, thinking budget) is never retryable, so the
 * name check comes first.
 */
function isMidStreamTransportError(err) {
  if (!(err instanceof Error)) return false;
  for (const link of errorChain(err)) {
    if (link.name === 'AbortError' || link.name === 'TimeoutError') return false;
  }
  return errorChain(err).some((link) => {
    if (typeof link.code === 'string' && MID_STREAM_ERROR_CODES.has(link.code)) return true;
    const message = link.message.toLowerCase();
    return MID_STREAM_ERROR_TEXT.some((needle) => message.includes(needle));
  });
}

/**
 * Connection-level failures that mean "the model server is not answering right
 * now" — typically a local server restarting or still loading a model. Node's
 * fetch reports these as `TypeError: fetch failed` with the socket code on
 * `cause`, which the browser-shaped `isTransientFetchError` never matched.
 */
const UNREACHABLE_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
]);

const UNREACHABLE_HTTP_STATUSES = new Set([502, 503]);

function isProviderUnreachableError(err) {
  if (!(err instanceof Error)) return false;
  const status = httpStatusFromError(err);
  if (status != null) return UNREACHABLE_HTTP_STATUSES.has(status);
  for (const link of errorChain(err)) {
    if (link.name === 'AbortError' || link.name === 'TimeoutError') return false;
  }
  return errorChain(err).some((link) => {
    if (typeof link.code === 'string' && UNREACHABLE_ERROR_CODES.has(link.code)) return true;
    const message = link.message.toUpperCase();
    return [...UNREACHABLE_ERROR_CODES].some((code) => message.includes(code));
  });
}

function isRetryableTransientError(err) {
  return isTransientFetchError(err) || isTransientHttpError(err) || isProviderUnreachableError(err);
}

/** Backoff while the provider is unreachable: 2s, 4s, 8s, then every 15s. */
const UNREACHABLE_BACKOFF_CAP_MS = 15_000;

function sleepUnlessAborted(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', done);
      resolve();
    }
    signal?.addEventListener?.('abort', done, { once: true });
  });
}

/**
 * Run `fn` with exponential backoff on transient failures.
 * The export name is historical (it used to retry once); callers keep the name
 * so chat and the runner cannot grow a second policy.
 *
 * Streaming callers pass `isRetryable` to opt into mid-stream socket errors and
 * `onRetry` to tell consumers to discard whatever the dead attempt painted.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @param {number} [delayMs=400]
 * @param {{
 *   isRetryable?: (err: unknown) => boolean,
 *   onRetry?: (info: { error: unknown, attempt: number }) => void,
 *   signal?: { aborted: boolean } | null,
 *   unreachableWaitMs?: number,
 *   onUnreachableWait?: (info: { error: unknown, waitMs: number, waitedMs: number, budgetMs: number }) => void,
 * }} [options]
 * `unreachableWaitMs` > 0 keeps retrying while the provider refuses connections,
 * for up to that long in total, without spending the quick-retry attempts —
 * a restarting local server should cost a pause, not the whole attempt.
 * @returns {Promise<T>}
 */
async function retryOnceOnTransientFetch(fn, delayMs = 400, options = {}) {
  const shouldRetry = options.isRetryable ?? isRetryableTransientError;
  const unreachableBudgetMs = Math.max(0, Number(options.unreachableWaitMs) || 0);
  let unreachableWaitedMs = 0;
  let unreachableStreak = 0;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_TRANSIENT_FETCH_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // A cancelled turn must surface as an abort, never as a retry.
      if (options.signal?.aborted) throw err;
      if (unreachableWaitedMs < unreachableBudgetMs && isProviderUnreachableError(err)) {
        const waitMs = Math.min(
          UNREACHABLE_BACKOFF_CAP_MS,
          2000 * 2 ** unreachableStreak,
          unreachableBudgetMs - unreachableWaitedMs,
        );
        unreachableStreak += 1;
        options.onUnreachableWait?.({
          error: err,
          waitMs,
          waitedMs: unreachableWaitedMs,
          budgetMs: unreachableBudgetMs,
        });
        await sleepUnlessAborted(waitMs, options.signal);
        unreachableWaitedMs += waitMs;
        if (options.signal?.aborted) throw err;
        attempt -= 1;
        continue;
      }
      if (!shouldRetry(err) || attempt === MAX_TRANSIENT_FETCH_ATTEMPTS) {
        throw err;
      }
      options.onRetry?.({ error: err, attempt });
      const waitMs = delayMs <= 0 ? 0 : delayMs * 2 ** (attempt - 1);
      if (waitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }
  }
  throw lastErr;
}

export {
  isTransientFetchError,
  isTransientHttpError,
  isMidStreamTransportError,
  isRetryableTransientError,
  isProviderUnreachableError,
  retryOnceOnTransientFetch,
  TRANSIENT_HTTP_STATUSES,
  MAX_TRANSIENT_FETCH_ATTEMPTS
};
