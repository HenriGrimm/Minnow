/**
 * Tell a spent allowance apart from ordinary rate-limit backpressure.
 * Both arrive as HTTP 429; only backpressure is worth retrying.
 */

/** Substrings that mean the allowance itself is spent. */
export declare const QUOTA_EXHAUSTED_MARKERS: readonly string[];

/** A Retry-After at or beyond this reads as a quota window, not backpressure. */
export declare const QUOTA_RETRY_AFTER_MS: number;

/** True when `text` reads as a provider saying the allowance is spent. */
export function isQuotaExhaustedText(text: unknown): boolean;

/**
 * Decide whether an upstream refusal means the allowance is spent.
 * `retryAfterMs` must be the header's own value, not one clamped for backoff.
 */
export function detectQuotaExhausted(input?: {
  status?: number;
  body?: unknown;
  retryAfterMs?: number | null;
}): boolean;

/** The provider's own "resets in …" phrase, when it gave one. */
export function parseQuotaResetHint(text: unknown): string | null;

/** Headline every surface uses for a spent allowance. */
export declare const OUT_OF_USAGE_TITLE: string;

/** One user-facing line for a spent allowance. */
export function formatOutOfUsageMessage(input?: {
  detail?: unknown;
  providerLabel?: string | null;
}): string;
