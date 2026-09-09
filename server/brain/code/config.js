/**
 * Default settings for the Brain code index (config.brain.code.*).
 */

/** @typedef {'on-demand' | 'on-switch' | 'git-hook'} CodeReindexCadence */

/** Lower bound for repo_map token budget (settings + tool override). */
export const REPO_MAP_TOKEN_BUDGET_MIN = 200;
/** Upper bound for repo_map token budget (settings + tool override). */
export const REPO_MAP_TOKEN_BUDGET_MAX = 128_000;

/**
 * Default budget for a `repo_map` **tool call**, capped by `repoMapTokenBudget`.
 *
 * `repoMapTokenBudget` sizes the Brain → Code map *panel*, where a 32k map costs
 * nothing but a scrollbar. The same number spent inside an agent's context is a
 * third of a small model's window for a map it did not ask to be that large, so
 * the tool defaults low and an agent that wants more passes `token_budget`.
 */
export const REPO_MAP_TOOL_DEFAULT_TOKEN_BUDGET = 4000;

export const DEFAULT_BRAIN_CODE_CONFIG = {
  enabled: true,
  includeGlobs: [
    '**/*.{ts,tsx,js,jsx,mjs,cjs,py,rs,go,java,kt,rb,php,cs,swift}',
    '**/*.{fake}',
  ],
  excludeGlobs: [
    '**/node_modules/**',
    '**/.git/**',
    '**/dist/**',
    '**/build/**',
    '**/.minnow/**',
  ],
  /** Approximate token budget for repo_map tool and Brain Code map panel. */
  repoMapTokenBudget: 32000,
  /**
   * Token budget for per-send code-map injection (injection profile).
   *
   * Orientation, not a substitute for `repo_map` / `find_symbol`. Measured on
   * this repo, 10k bought ~2.6k lines whose tail no model reads before it
   * navigates with a tool anyway; 4k keeps the ranked head that actually gets
   * used and returns the rest of the window to the conversation.
   */
  repoMapInjectionTokenBudget: 4000,
  /** When to trigger background reindex (MIN-B10 wires automation). */
  reindexCadence: /** @type {CodeReindexCadence} */ ('on-demand'),
  /** Reserved for MIN-B11 semantic code search. */
  codeEmbeddingsEnabled: false,
  /** Write .minnow/jsconfig.json when a JS/TS workspace has no ts/js config. */
  autoScaffoldIndexConfig: true,
};

/**
 * Clamp repo_map token budget to the supported range.
 * @param {unknown} budget
 */
export function clampRepoMapTokenBudget(budget) {
  const n = Number(budget);
  if (!Number.isFinite(n)) return DEFAULT_BRAIN_CODE_CONFIG.repoMapTokenBudget;
  return Math.min(
    REPO_MAP_TOKEN_BUDGET_MAX,
    Math.max(REPO_MAP_TOKEN_BUDGET_MIN, Math.floor(n)),
  );
}

/**
 * Clamp injection-only repo map budget (same numeric range as tool budget).
 * @param {unknown} budget
 */
export function clampRepoMapInjectionTokenBudget(budget) {
  const n = Number(budget);
  if (!Number.isFinite(n)) return DEFAULT_BRAIN_CODE_CONFIG.repoMapInjectionTokenBudget;
  return clampRepoMapTokenBudget(n);
}

/**
 * Merge partial code-index settings with defaults.
 * @param {Record<string, unknown> | undefined | null} raw
 */
export function normalizeBrainCodeConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const includeGlobs = Array.isArray(src.includeGlobs)
    ? src.includeGlobs.map((g) => String(g).trim()).filter(Boolean)
    : DEFAULT_BRAIN_CODE_CONFIG.includeGlobs;
  const excludeGlobs = Array.isArray(src.excludeGlobs)
    ? src.excludeGlobs.map((g) => String(g).trim()).filter(Boolean)
    : DEFAULT_BRAIN_CODE_CONFIG.excludeGlobs;
  const cadence = String(src.reindexCadence ?? DEFAULT_BRAIN_CODE_CONFIG.reindexCadence);
  const validCadence =
    cadence === 'on-switch' || cadence === 'git-hook' ? cadence : 'on-demand';
  const budget = Number(src.repoMapTokenBudget ?? DEFAULT_BRAIN_CODE_CONFIG.repoMapTokenBudget);
  const injectionBudget = Number(
    src.repoMapInjectionTokenBudget ?? DEFAULT_BRAIN_CODE_CONFIG.repoMapInjectionTokenBudget,
  );
  return {
    ...DEFAULT_BRAIN_CODE_CONFIG,
    enabled: src.enabled !== false,
    includeGlobs,
    excludeGlobs,
    repoMapTokenBudget: clampRepoMapTokenBudget(budget),
    repoMapInjectionTokenBudget: clampRepoMapInjectionTokenBudget(injectionBudget),
    reindexCadence: validCadence,
    codeEmbeddingsEnabled: src.codeEmbeddingsEnabled === true,
    autoScaffoldIndexConfig: src.autoScaffoldIndexConfig !== false,
  };
}
