/**
 * Navigation allowlist: glob-like origin patterns for browser_navigate.
 */

/** Origins allowed for a single navigation (user approved "once"). */
const ephemeralOrigins = new Set();

/**
 * @param {string} url
 * @returns {string}
 */
export function originFromUrl(url) {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.host}`;
}

/**
 * Suggested glob pattern to persist when the user approves an external origin.
 * @param {string} url
 * @returns {string}
 */
export function suggestAllowlistPattern(url) {
  const parsed = new URL(url);
  if (parsed.port) {
    return `${parsed.protocol}//${parsed.hostname}:*`;
  }
  return `${parsed.protocol}//${parsed.host}`;
}

/**
 * Allow one navigation to this origin (consumed after a successful navigate).
 * @param {string} originKey e.g. https://example.com
 */
export function grantEphemeralNavigation(originKey) {
  if (!originKey || typeof originKey !== 'string') return;
  ephemeralOrigins.add(originKey.trim().toLowerCase());
}

/** @param {string} originKey */
export function hasEphemeralNavigation(originKey) {
  return ephemeralOrigins.has(originKey.trim().toLowerCase());
}

/** @param {string} originKey */
export function consumeEphemeralNavigation(originKey) {
  const key = originKey.trim().toLowerCase();
  if (!ephemeralOrigins.has(key)) return false;
  ephemeralOrigins.delete(key);
  return true;
}

/** Test hook: clear ephemeral grants. */
export function resetEphemeralNavigation() {
  ephemeralOrigins.clear();
}

/**
 * Normalize a user-entered allowlist line to an origin glob (paths stripped).
 * @param {string} line
 * @returns {string}
 */
export function normalizeAllowlistPatternLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
    if (parsed.pathname && parsed.pathname !== '/') {
      return suggestAllowlistPattern(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
    }
    if (parsed.port) {
      return `${parsed.protocol}//${parsed.hostname}:*`;
    }
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return trimmed;
  }
}

/**
 * Normalize an array of allowlist patterns for persistence.
 * @param {string[]} patterns
 * @returns {string[]}
 */
export function normalizeAllowlistPatterns(patterns) {
  const out = [];
  const seen = new Set();
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

/**
 * Convert a simple glob pattern to a RegExp (supports * for any chars).
 * @param {string} pattern e.g. "http://localhost:*"
 */
function patternToRegExp(pattern) {
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

/**
 * @param {string} url
 * @param {string[]} patterns
 * @returns {boolean}
 */
export function isNavigationAllowed(url, patterns) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  const originKey = `${parsed.protocol}//${parsed.host}`;
  if (hasEphemeralNavigation(originKey)) {
    return true;
  }

  for (const pattern of patterns) {
    if (!pattern || typeof pattern !== 'string') continue;
    const trimmed = pattern.trim();
    if (!trimmed) continue;
    const candidates = [trimmed];
    try {
      const normalized = normalizeAllowlistPatternLine(trimmed);
      if (normalized && normalized !== trimmed) {
        candidates.push(normalized);
      }
    } catch {
      /* keep trimmed only */
    }
    for (const candidate of candidates) {
      if (patternToRegExp(candidate).test(originKey)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * @param {string} url
 * @param {string[]} patterns
 */
export function assertNavigationAllowed(url, patterns) {
  if (!isNavigationAllowed(url, patterns)) {
    const suggested = suggestAllowlistPattern(url);
    throw new Error(
      `navigation blocked by allowlist: ${url} (suggested pattern: ${suggested}). ` +
        'Call ask_question (options once / persist / deny), then request_browser_origin_access with decision once or persist, then retry browser_navigate.',
    );
  }
}
