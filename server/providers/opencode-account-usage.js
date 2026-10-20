/**
 * OpenCode Go's read-only account quota endpoint.
 * Contract: anomalyco/opencode PR #16513 (merged 2026-08-11); the current
 * console inference-proxy retains GET /zen/go/v1/usage -> /go/v1/usage.
 * Never derive dollar balances from plan prices or locally observed tokens.
 */
export const OPENCODE_GO_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage';

export function normalizeOpenCodeAccountUsage(data, checkedAt) {
  const metrics = [];
  for (const [key, label] of [
    ['rollingUsage', 'Rolling allowance'],
    ['weeklyUsage', 'Weekly allowance'],
    ['monthlyUsage', 'Monthly allowance'],
  ]) {
    const row = data?.[key];
    const used = row?.usagePercent;
    if (typeof used !== 'number' || !Number.isFinite(used) || used < 0 || used > 100) continue;
    const seconds = row.resetInSec;
    const reset = typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0
      ? new Date(Date.parse(checkedAt) + seconds * 1000) : null;
    metrics.push({
      label, used, remaining: 100 - used, limit: 100, unit: '%',
      ...(reset && Number.isFinite(reset.getTime()) ? { resetsAt: reset.toISOString() } : {}),
    });
  }
  return metrics;
}
