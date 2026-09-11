/**
 * Compact token / count labels for the inference metrics strip.
 * Below 1M: locale commas. Millions / billions / trillions: short M / B / T forms.
 * Full precise value is returned for hover tooltips.
 */

export interface FormattedStatCount {
  /** Short label shown in the strip (e.g. "75.8M"). */
  display: string;
  /** Full precise count with grouping separators (e.g. "75,776,650"). */
  full: string;
}

/** Trim a single trailing ".0" so 76.0M becomes 76M. */
function trimTrailingPointZero(value: string): string {
  return value.replace(/\.0$/, '');
}

/**
 * Format a non-negative count for instrumentation surfaces.
 * Returns em-dash when the value is missing or not finite.
 */
export function formatStatCount(n: number | null | undefined): FormattedStatCount {
  if (n == null || !Number.isFinite(n)) {
    return { display: '—', full: '' };
  }

  const rounded = Math.round(n);
  const full = rounded.toLocaleString();
  const abs = Math.abs(rounded);

  if (abs >= 1_000_000_000_000) {
    return {
      display: `${trimTrailingPointZero((rounded / 1_000_000_000_000).toFixed(1))}T`,
      full,
    };
  }
  if (abs >= 1_000_000_000) {
    return {
      display: `${trimTrailingPointZero((rounded / 1_000_000_000).toFixed(1))}B`,
      full,
    };
  }
  if (abs >= 1_000_000) {
    return {
      display: `${trimTrailingPointZero((rounded / 1_000_000).toFixed(1))}M`,
      full,
    };
  }

  return { display: full, full };
}
