/**
 * Detect fetch transport failures and transient HTTP statuses that often
 * succeed on a retry. Used by main chat, sub-agents, and goal evaluation.
 */
/** True when a fetch rejection is likely a transient network blip. */
export declare function isTransientFetchError(err: unknown): boolean;
/** True when `err` is `HTTP {status}: …` for a retryable status (429/502/…). */
export declare function isTransientHttpError(err: unknown): boolean;
/**
 * True when a response body died on the wire (ECONNRESET, socket hang up,
 * undici `terminated`) rather than being cancelled. Aborts return false.
 */
export declare function isMidStreamTransportError(err: unknown): boolean;
/** The default retry predicate: transient fetch or transient HTTP status. */
export declare function isRetryableTransientError(err: unknown): boolean;
/**
 * Run `fn` with exponential backoff on transient fetch / HTTP errors.
 * Export name is historical (used to retry once); do not add a second helper.
 */
export declare function retryOnceOnTransientFetch<T>(
  fn: () => Promise<T>,
  delayMs?: number,
  options?: {
    isRetryable?: (err: unknown) => boolean;
    onRetry?: (info: { error: unknown; attempt: number }) => void;
    signal?: { aborted: boolean } | null;
  },
): Promise<T>;
export declare const TRANSIENT_HTTP_STATUSES: ReadonlySet<number>;
export declare const MAX_TRANSIENT_FETCH_ATTEMPTS: number;
