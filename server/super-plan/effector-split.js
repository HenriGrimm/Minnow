/**
 * Split effector for the Super Plan run engine (W3-A).
 *
 * Routes every `Desired` the engine's one `plan()` produces to a
 * role-specific sub-effector, behind a single `Effector` surface. The seam is
 * proven by `server/orchestrator/effector-scripted.js`: a role-agnostic
 * scripted effector drives the whole pipeline, and `createSplitEffector`
 * accepts the same `script` / `clock` / `defaultOutcome` options so a test can
 * swap it in for `createScriptedEffector` unchanged.
 *
 * Production wiring routes the headless stages (`research`, `review`,
 * `polish` — see `effector-headless.js`) to headless sub-effectors and the
 * remaining stages (`interview`, `spec`, `draft`) to a `fallback`.
 */

import { createScriptedEffector } from '../orchestrator/effector-scripted.js';

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isEffector(value) {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    typeof /** @type {any} */ (value).inspect === 'function' &&
    typeof /** @type {any} */ (value).start === 'function' &&
    typeof /** @type {any} */ (value).stop === 'function'
  );
}

/**
 * Create a split effector.
 *
 * @param {{
 *   byRole?: Record<string, import('../orchestrator/engine.js').Effector | (() => import('../orchestrator/engine.js').Effector)>,
 *   fallback?: import('../orchestrator/engine.js').Effector | (() => import('../orchestrator/engine.js').Effector),
 *   script?: import('../orchestrator/effector-scripted.js').ScriptRule[],
 *   clock?: { now: () => number, setTimer: (fn: () => void, ms: number) => unknown,
 *             clearTimer: (handle: unknown) => void },
 *   defaultOutcome?: string,
 * }} [options]
 */
export function createSplitEffector(options = {}) {
  const byRole = options.byRole ?? {};
  const script = options.script;
  const clock = options.clock;
  const defaultOutcome = options.defaultOutcome;

  /** @type {Map<string, import('../orchestrator/engine.js').Effector>} */
  const effectors = new Map();
  /** @type {Array<(end: import('../orchestrator/engine.js').AttemptEnd) => Promise<void> | void>} */
  const listeners = [];
  /** @type {import('../orchestrator/engine.js').Effector | null} */
  let sharedFallback = null;
  /** @type {Map<string, import('../orchestrator/engine.js').Effector>} */
  const ownerByAttempt = new Map();

  /**
   * The fallback sub-effector: the explicit `fallback` when given, otherwise a
   * single scripted effector shared by every unrouted role. Sharing one
   * instance keeps `nth` rule counting and the start log identical to a plain
   * `createScriptedEffector` — that is the swappability contract.
   *
   * @returns {import('../orchestrator/engine.js').Effector}
   */
  function resolveFallback() {
    if (sharedFallback) return sharedFallback;
    let created;
    if (options.fallback !== undefined) {
      created =
        typeof options.fallback === 'function' && !isEffector(options.fallback)
          ? /** @type {() => import('../orchestrator/engine.js').Effector} */ (options.fallback)()
          : /** @type {import('../orchestrator/engine.js').Effector} */ (options.fallback);
    } else {
      created = createScriptedEffector({ script, clock, defaultOutcome });
    }
    if (!isEffector(created)) {
      throw new Error('split effector: fallback is not an Effector');
    }
    for (const handler of listeners) created.onEnd?.(handler);
    sharedFallback = created;
    return created;
  }

  /**
   * Resolve the sub-effector for one role, creating it on first use.
   *
   * @param {string} role
   * @returns {import('../orchestrator/engine.js').Effector}
   */
  function effectorFor(role) {
    const existing = effectors.get(role);
    if (existing) return existing;

    const entry = byRole[role];
    let created;
    if (entry !== undefined) {
      created =
        typeof entry === 'function' && !isEffector(entry)
          ? /** @type {() => import('../orchestrator/engine.js').Effector} */ (entry)()
          : /** @type {import('../orchestrator/engine.js').Effector} */ (entry);
      if (!isEffector(created)) {
        throw new Error(`split effector: no usable sub-effector for role ${role}`);
      }
      if (![...effectors.values()].includes(created)) for (const handler of listeners) created.onEnd?.(handler);
      effectors.set(role, created);
      return created;
    }

    const fallback = resolveFallback();
    effectors.set(role, fallback);
    return fallback;
  }

  /**
   * @param {string} attemptId
   * @returns {import('../orchestrator/engine.js').Effector | undefined}
   */
  function ownerOf(attemptId) {
    const known = ownerByAttempt.get(attemptId);
    if (known) return known;
    for (const eff of effectors.values()) {
      if (eff.inspect().some((row) => row.attemptId === attemptId)) {
        ownerByAttempt.set(attemptId, eff);
        return eff;
      }
    }
    return undefined;
  }

  /**
   * Distinct sub-effectors. A shared fallback is registered under every
   * unrouted role key, so aggregation must dedupe by identity or `started` /
   * `inspect` would repeat the shared instance once per role.
   *
   * @returns {import('../orchestrator/engine.js').Effector[]}
   */
  function distinctEffectors() {
    return [...new Set(effectors.values())];
  }

  return {
    /** @returns {Array<{ taskId: string | null, role: string, attemptId: string, handle?: unknown }>} */
    inspect() {
      /** @type {Array<{ taskId: string | null, role: string, attemptId: string, handle?: unknown }>} */
      const all = [];
      for (const eff of distinctEffectors()) {
        for (const row of eff.inspect()) {
          all.push({
            taskId: row.taskId ?? null,
            role: row.role,
            attemptId: row.attemptId,
            ...(row.handle !== undefined ? { handle: row.handle } : {}),
          });
        }
      }
      return all;
    },

    /**
     * @param {{ taskId: string | null, role: string, seedKind?: string }} desired
     * @returns {Promise<{ attemptId: string, worktree?: string }>}
     */
    async start(desired) {
      const eff = effectorFor(String(desired.role));
      const handle = await eff.start({
        taskId: desired.taskId,
        role: desired.role,
        ...(desired.seedKind !== undefined ? { seedKind: desired.seedKind } : {}),
      });
      if (handle?.attemptId) {
        ownerByAttempt.set(handle.attemptId, eff);
        if (handle.worktree !== undefined) return { attemptId: handle.attemptId, worktree: handle.worktree };
        return { attemptId: handle.attemptId };
      }
      return handle;
    },

    /**
     * @param {string} attemptId
     * @returns {Promise<void>}
     */
    async stop(attemptId) {
      const eff = ownerOf(attemptId);
      if (eff) {
        await eff.stop(attemptId);
        ownerByAttempt.delete(attemptId);
        return;
      }
      for (const candidate of distinctEffectors()) await candidate.stop(attemptId);
    },

    /**
     * @param {(end: import('../orchestrator/engine.js').AttemptEnd) => Promise<void> | void} handler
     * @returns {void}
     */
    onEnd(handler) {
      listeners.push(handler);
      for (const eff of distinctEffectors()) eff.onEnd?.(handler);
    },

    get started() {
      /** @type {Array<{ taskId: string | null, role: string, attemptId: string, seedKind?: string }>} */
      const all = [];
      for (const eff of distinctEffectors()) {
        const started = /** @type {{ started?: unknown }} */ (/** @type {unknown} */ (eff)).started;
        if (Array.isArray(started)) {
          for (const row of started) {
            all.push({
              taskId: row.taskId ?? null,
              role: row.role,
              attemptId: row.attemptId,
              ...(row.seedKind !== undefined ? { seedKind: row.seedKind } : {}),
            });
          }
        }
      }
      return all;
    },

    /**
     * Drop running attempts on every sub-effector.
     * @returns {void}
     */
    vanishAll() {
      for (const eff of distinctEffectors()) eff.vanishAll?.();
      ownerByAttempt.clear();
    },
  };
}