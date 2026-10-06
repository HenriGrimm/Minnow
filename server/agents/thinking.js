/**
 * Shared thinking mode normalization for work-agents and sub-agents APIs.
 */

const TRI_STATES = new Set(['inherit', 'on', 'off']);
const GLOBAL_MODES = new Set(['on', 'off']);

/**
 * @param {unknown} value
 * @returns {'inherit' | 'on' | 'off' | null}
 */
export function normalizeThinkingTriState(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && TRI_STATES.has(value)) return value;
  return null;
}

/**
 * @param {unknown} value
 * @returns {'on' | 'off' | null}
 */
export function normalizeThinkingGlobalDefault(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && GLOBAL_MODES.has(value)) return value;
  return null;
}

/**
 * Coerce thinking budget tokens: null = inherit, 0 = off, positive clamped [10, 200_000].
 * @param {unknown} value
 * @returns {number | null}
 */
export function clampThinkingBudgetTokens(value) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  if (rounded < 0) return null;
  if (rounded === 0) return 0;
  return Math.min(200_000, Math.max(10, rounded));
}

/**
 * Settings → Thinking default for headless turns that carry no mode of their
 * own (board attempts with no reasoning picked). Mirrors the SPA's fallback:
 * an unset or unreadable config means `'on'`.
 * @returns {Promise<'on' | 'off'>}
 */
export async function readGlobalThinkingModeForTurn() {
  try {
    const { readResource } = await import('../config/store.js');
    const meta = await readResource('meta');
    const thinking =
      meta && typeof meta === 'object'
        ? /** @type {Record<string, unknown>} */ (meta).thinking
        : null;
    const mode =
      thinking && typeof thinking === 'object'
        ? normalizeThinkingGlobalDefault(/** @type {Record<string, unknown>} */ (thinking).defaultMode)
        : null;
    return mode ?? 'on';
  } catch {
    return 'on';
  }
}
