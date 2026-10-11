/**
 * Capability tiers for Auto model pools (policy `evaluate`).
 *
 * The task evaluator answers "how much model does this turn need" with one of
 * these tiers; it never names a model. Each pool entry carries a tier — set by
 * the user, or guessed from the model id here — and the router maps the
 * decision onto the entries. Shared by the server router and the Models UI.
 */

/** Ordered weakest → strongest. */
export const ROUTER_TIERS = /** @type {const} */ (['fast', 'balanced', 'frontier']);

/** Reasoning levels the evaluator chooses between. */
export const ROUTER_EFFORTS = /** @type {const} */ (['low', 'medium', 'high']);

/** @param {unknown} value */
export function isRouterTier(value) {
  return typeof value === 'string' && /** @type {readonly string[]} */ (ROUTER_TIERS).includes(value);
}

/** @param {unknown} value */
export function isRouterEffort(value) {
  return typeof value === 'string' && /** @type {readonly string[]} */ (ROUTER_EFFORTS).includes(value);
}

/** @param {string} tier */
export function formatRouterTierLabel(tier) {
  if (tier === 'fast') return 'Fast';
  if (tier === 'frontier') return 'Frontier';
  return 'Balanced';
}

const FAST_NAME = /(?:^|[^a-z])(?:nano|mini|tiny|lite|small|flash|haiku|instant|turbo)(?:[^a-z]|$)/i;
const FRONTIER_NAME = /(?:^|[^a-z])(?:opus|gpt-5(?![.-]?\d*-?(?:mini|nano))|o[34](?:-pro)?|gemini-[\d.]+-pro|grok-[45](?!.*(?:mini|fast))|deepseek-(?:r\d|v[34])|kimi-k2|glm-5|qwen3-(?:max|coder-480b)|ultra)(?:[^a-z]|$)/i;

/**
 * Best-effort tier from a model id or display name. Parameter count wins when
 * the id carries one (`qwen3-32b`, `gemma-4-27b-it`); otherwise name families.
 * @param {string} modelId
 * @returns {'fast' | 'balanced' | 'frontier'}
 */
export function guessRouterTier(modelId) {
  const id = String(modelId || '').toLowerCase();
  // First "<n>b" token: total parameters for MoE ids like 30b-a3b.
  const params = id.match(/(?:^|[^a-z0-9.])(\d+(?:\.\d+)?)b(?:[^a-z]|$)/);
  if (params) {
    const billions = Number(params[1]);
    if (billions <= 9) return 'fast';
    if (billions <= 40) return 'balanced';
    return 'frontier';
  }
  if (FAST_NAME.test(id)) return 'fast';
  if (FRONTIER_NAME.test(id)) return 'frontier';
  return 'balanced';
}

/**
 * Effective tier for a pool entry: the stored tag, else a guess.
 * @param {{ tier?: string, modelId: string, label?: string }} entry
 */
export function routerEntryTier(entry) {
  if (isRouterTier(entry.tier)) return /** @type {'fast' | 'balanced' | 'frontier'} */ (entry.tier);
  return guessRouterTier(entry.label || entry.modelId);
}

/**
 * Tiers to try for a target, nearest first; on a tie, stronger before weaker
 * so a missing tier never routes a hard task down.
 * @param {string} target
 * @returns {string[]}
 */
export function routerTierFallbackOrder(target) {
  const index = Math.max(0, ROUTER_TIERS.indexOf(/** @type {any} */ (target)));
  return [...ROUTER_TIERS]
    .map((tier, i) => ({ tier, distance: Math.abs(i - index), weaker: i < index }))
    .sort((a, b) => a.distance - b.distance || Number(a.weaker) - Number(b.weaker))
    .map((row) => row.tier);
}

/** Decision models answer typed questions through the Jev-compatible Decisions API. */
export function isDecisionModelId(modelId) {
  return /(?:^|[/~@])(?:typesafe\/)?jev(?:[-_.]|$)|(?:^|[/@])(?:cloudflare\/)?clef(?:[-_.]|$)/i.test(String(modelId || ''));
}
