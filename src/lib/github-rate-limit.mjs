export function isGithubRateLimitError(message) {
  return /rate limit|rate_limit|secondary limit|abuse detection/i.test(String(message ?? ''));
}

/** Server errors carry an absolute retry time so every renderer waits for the same reset. */
export function githubRetryAt(message, now = Date.now()) {
  if (!isGithubRateLimitError(message)) return 0;
  const match = /Retry after (\d{4}-\d{2}-\d{2}T[\d:.]+Z)/i.exec(message);
  const explicit = match ? Date.parse(match[1]) : NaN;
  if (Number.isFinite(explicit)) return explicit;
  return now + (/secondary|abuse/i.test(message) ? 60_000 : 60 * 60_000);
}
