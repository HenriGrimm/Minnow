/** Origin key for a URL, e.g. https://example.com */
export function originFromUrl(url: string): string {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.host}`;
}

/** Suggested glob when persisting an approved external origin. */
export function suggestAllowlistPattern(url: string): string {
  const parsed = new URL(url);
  if (parsed.port) {
    return `${parsed.protocol}//${parsed.hostname}:*`;
  }
  return `${parsed.protocol}//${parsed.host}`;
}

/** Normalize a settings line to an origin glob (strip URL paths). */
export function normalizeAllowlistPatternLine(line: string): string {
  const trimmed = line.trim();
  if (!trimmed) return '';
  try {
    const withScheme = trimmed.includes('://') ? trimmed : `https://${trimmed}`;
    const parsed = new URL(withScheme);
    if (parsed.pathname && parsed.pathname !== '/') {
      return suggestAllowlistPattern(withScheme);
    }
    if (parsed.port) {
      return `${parsed.protocol}//${parsed.hostname}:*`;
    }
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return trimmed;
  }
}

/** Deduplicated normalized patterns for persistence. */
export function normalizeAllowlistPatterns(patterns: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of patterns) {
    const normalized = normalizeAllowlistPatternLine(line);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

function patternToRegExp(pattern: string): RegExp {
  let re = '^';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '*') {
      re += '.*';
    } else if ('.+^${}()|[]\\'.includes(ch)) {
      re += `\\${ch}`;
    } else {
      re += ch;
    }
  }
  re += '$';
  return new RegExp(re, 'i');
}

/** Whether `url` matches any allowlist pattern (origin globs). */
export function isNavigationAllowed(url: string, patterns: string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  const originKey = `${parsed.protocol}//${parsed.host}`;

  for (const pattern of patterns) {
    if (!pattern?.trim()) continue;
    const trimmed = pattern.trim();
    const candidates = [trimmed];
    try {
      const normalized = normalizeAllowlistPatternLine(trimmed);
      if (normalized && normalized !== trimmed) {
        candidates.push(normalized);
      }
    } catch {}
    for (const candidate of candidates) {
      if (patternToRegExp(candidate).test(originKey)) {
        return true;
      }
    }
  }
  return false;
}
