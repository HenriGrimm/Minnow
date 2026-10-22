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
  'usagelimitexceeded',
  'usage_limit_reached',
  'usage_limit_exceeded',
  "you've hit your limit",
  "you've hit your usage limit",
  "you've hit your session limit",
  'you have hit your limit',
  'you have hit your usage limit',
  'you have reached your usage limit',
  'allowance exhausted',
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

/** Only provider refusals enter this classifier; never scan successful model prose. */
export function allowanceFailure(message, options = {}) {
  const text = String(message || '');
  const quota = options.quotaExceeded || detectQuotaExhausted({
    status: options.status ?? Number(/HTTP (\d{3})/i.exec(text)?.[1]), body: text, retryAfterMs: options.retryAfterMs,
  });
  const rate = !quota && (options.status === 429 || /429|rate.?limit|too many requests/i.test(text));
  const unavailable = !quota && !rate && ([408, 425, 500, 502, 503, 504, 529].includes(options.status) || /(?:Upstream\s+)?HTTP (?:408|425|500|502|503|504|529)\b|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|endpoint.*unavailable/i.test(text));
  if (!quota && !rate && !unavailable) return null;
  const retryAfterMs = options.retryAfterMs;
  const relative = /resets? in\s+(\d+(?:\.\d+)?)\s*(seconds?|minutes?|hours?|days?)/i.exec(text);
  const now = options.now ?? Date.now();
  const relativeReset = relative ? now + Number(relative[1]) * ({ s: 1000, m: 60_000, h: 3600_000, d: 86400_000 }[relative[2][0].toLowerCase()]) : parseAllowanceResetTime(text, now);
  return {
    kind: quota ? 'quota' : rate ? 'rate_limit' : 'unavailable',
    // Billing refusals are account-wide. Ambiguous usage caps stay model-scoped.
    scope: options.scope || (options.status === 402 || /ECONNREFUSED|EHOSTUNREACH|insufficient[_ ](?:quota|credits?)|out of credits|credit balance|billing hard limit|HTTP 402/i.test(text) ? 'provider' : 'model'),
    ...(Number.isFinite(options.resetAt ?? relativeReset) ? { resetAt: options.resetAt ?? relativeReset } : {}),
    ...(Number.isFinite(retryAfterMs) ? { retryAfterMs } : {}),
  };
}

/** CLI clock reset hints include a timezone, e.g. "resets 11pm (America/Los_Angeles)". */
export function parseAllowanceResetTime(text, now = Date.now()) {
  const match = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)/i.exec(String(text));
  if (!match || Number(match[1]) < 1 || Number(match[1]) > 12 || Number(match[2] ?? 0) > 59) return undefined;
  try {
    const formatter = new Intl.DateTimeFormat('en-US', { timeZone: match[4], year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    const parts = (at) => Object.fromEntries(formatter.formatToParts(at).map((part) => [part.type, Number(part.value)]));
    const today = parts(now);
    const hour = Number(match[1]) % 12 + (match[3].toLowerCase() === 'pm' ? 12 : 0);
    for (let day = 0; day <= 1; day += 1) {
      const local = Date.UTC(today.year, today.month - 1, today.day + day, hour, Number(match[2] ?? 0));
      let candidate = local;
      for (let iteration = 0; iteration < 4; iteration += 1) {
        const value = parts(candidate);
        candidate += local - Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute, value.second);
      }
      if (candidate > now) return candidate;
    }
  } catch { /* Unknown zones remain unknown; the shared cooldown still applies. */ }
  return undefined;
}
