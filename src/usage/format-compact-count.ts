/** Trim a single trailing ".0" so 2.0M becomes 2M. */
function trimTrailingPointZero(value: string): string {
  return value.replace(/\.0$/, '');
}

/**
 * Compact count labels for hub tiles and overview surfaces.
 * Uses k / M / B / T suffixes above 1k; raw integers below.
 */
export function formatCompactCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';

  const abs = Math.abs(n);
  if (abs >= 1_000_000_000_000) {
    return `${trimTrailingPointZero((n / 1_000_000_000_000).toFixed(1))}T`;
  }
  if (abs >= 1_000_000_000) {
    return `${trimTrailingPointZero((n / 1_000_000_000).toFixed(1))}B`;
  }
  if (abs >= 1_000_000) {
    return `${trimTrailingPointZero((n / 1_000_000).toFixed(1))}M`;
  }
  if (abs >= 10_000) return `${Math.round(n / 1_000)}k`;
  if (abs >= 1_000) return `${trimTrailingPointZero((n / 1_000).toFixed(1))}k`;
  return String(Math.round(n));
}
