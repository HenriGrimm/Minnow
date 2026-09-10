/**
 * Tell "you are out of usage" apart from "you are going too fast".
 *
 * Providers send both as HTTP 429. Only the second one is worth retrying:
 * a weekly or monthly cap does not clear inside a turn, so retrying it just
 * burns attempts and, on a board, abandons tasks that were never at fault.
 */

/**
 * Substrings that mean the allowance itself is spent.
 *
 * Deliberately excludes bare "rate limit" / "too many requests" — those are
 * backpressure and stay retryable.
 */
export const QUOTA_EXHAUSTED_MARKERS = [
  'usage limit reached',
  'usage limit exceeded',
  'usagelimiterror',
  'quota exceeded',
  'exceeded your current quota',
  'insufficient_quota',
  'insufficient quota',
  'insufficient credits',
  'insufficient_credit',
  'out of credits',
  'no credits remaining',
  'credit balance is too low',
  'billing hard limit',
  'hard limit reached',
  'spend limit',
  'spending limit',
  'plan limit reached',
  'upgrade your plan',
  'purchase more credits',
  'enable usage from your available balance',
];

/**
 * A wait this long is a quota window reopening, not backpressure easing.
 * Ten minutes is far past any real Retry-After and far short of a daily reset.
 */
export const QUOTA_RETRY_AFTER_MS = 10 * 60 * 1000;

/**
 * @param {unknown} text
 * @returns {boolean}
 */
export function isQuotaExhaustedText(text) {
  const lower = String(text ?? '').toLowerCase();
  return QUOTA_EXHAUSTED_MARKERS.some((marker) => lower.includes(marker));
}

/**
 * Decide whether an upstream refusal means the allowance is spent.
 *
 * `retryAfterMs` must be the header's own value, not one clamped for backoff —
 * the clamped value can never reach {@link QUOTA_RETRY_AFTER_MS}.
 *
 * @param {{ status?: number, body?: unknown, retryAfterMs?: number | null }} [input]
 * @returns {boolean}
 */
export function detectQuotaExhausted(input) {
  const status = input?.status;
  if (status === 402) return true;
  if (isQuotaExhaustedText(input?.body)) return true;
  const retryAfterMs = input?.retryAfterMs;
  return typeof retryAfterMs === 'number' && retryAfterMs >= QUOTA_RETRY_AFTER_MS;
}

/** `Resets in 3 days` / `try again in 45 minutes` — whatever the provider said. */
const RESET_HINT = /(?:resets?|try again|available again)\s+(?:in|at)\s+([^.,;)]{1,48})/i;

/**
 * Pull the provider's own "when it comes back" phrase out of an error body.
 * @param {unknown} text
 * @returns {string | null}
 */
export function parseQuotaResetHint(text) {
  const match = RESET_HINT.exec(String(text ?? ''));
  if (!match) return null;
  const hint = match[1].trim();
  return hint || null;
}

/** Headline every surface uses for a spent allowance. */
export const OUT_OF_USAGE_TITLE = 'Out of usage';

/**
 * One user-facing line for a spent allowance.
 * @param {{ detail?: unknown, providerLabel?: string | null }} [input]
 * @returns {string}
 */
export function formatOutOfUsageMessage(input) {
  const label = String(input?.providerLabel ?? '').trim();
  const where = label ? ` on ${label}` : '';
  const hint = parseQuotaResetHint(input?.detail);
  const when = hint ? ` Resets in ${hint}.` : '';
  return `${OUT_OF_USAGE_TITLE}${where}. The provider will not accept more requests until the allowance resets.${when}`;
}
