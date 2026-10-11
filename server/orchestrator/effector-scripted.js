/** Scripted effector for tests. No model calls. */
import { createPauseGate } from '../runner/pause-gate.js';

/**
 * @typedef {object} ScriptRule
 * @property {{ taskId?: string, role?: string, nth?: number }} [match]
 * @property {{
 *   outcome?: string,
 *   summary?: string,
 *   evidence?: Record<string, unknown>,
 *   sha?: string,
 *   files?: string[],
 *   delayMs?: number,
 *   vanish?: boolean,
 *   worktree?: string,
 * }} emit
 */

/**
 * Create a scripted effector.
 *
 * @param {{
 *   script?: ScriptRule[],
 *   clock?: { now: () => number, setTimer: (fn: () => void, ms: number) => unknown,
 *             clearTimer: (handle: unknown) => void },
 *   defaultOutcome?: string,
 * }} [options]
 */
export function createScriptedEffector(options = {}) {
  const script = options.script ?? [];
  const clock = options.clock ?? {
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(/** @type {NodeJS.Timeout} */ (handle)),
  };
  const defaultOutcome = options.defaultOutcome ?? 'pass';

  /** @type {Map<string, { taskId: string | null, role: string, attemptId: string, timer: unknown, controller: AbortController }>} */
  const running = new Map();
  const pauseGate = createPauseGate();
  /** @type {Array<(end: import('./engine.js').AttemptEnd) => void>} */
  const listeners = [];
  /** @type {number[]} */
  const ruleHits = script.map(() => 0);

  /** @type {Array<{ taskId: string | null, role: string, attemptId: string, seedKind?: string }>} */
  const startLog = [];

  let nextId = 0;

  /**
   * @param {import('./core/types').Desired} desired
   * @returns {ScriptRule['emit']}
   */
  function resolveRule(desired) {
    for (let i = 0; i < script.length; i += 1) {
      const rule = script[i];
      const match = rule.match ?? {};
      if (match.taskId !== undefined && match.taskId !== desired.taskId) continue;
      if (match.role !== undefined && match.role !== desired.role) continue;
      ruleHits[i] += 1;
      if (match.nth !== undefined && match.nth !== ruleHits[i]) continue;
      return rule.emit;
    }
    return { outcome: defaultOutcome };
  }

  return {
    setPaused: (paused) => pauseGate.setPaused(paused),
    /** @returns {Array<{ taskId: string | null, role: string, attemptId: string }>} */
    inspect() {
      return [...running.values()].map(({ taskId, role, attemptId }) => ({
        taskId,
        role,
        attemptId,
      }));
    },

    /**
     * @param {import('./core/types').Desired} desired
     * @returns {Promise<{ attemptId: string }>}
     */
    async start(desired) {
      const attemptId = `s${(nextId += 1)}`;
      const emit = resolveRule(desired);
      startLog.push({
        taskId: desired.taskId,
        role: desired.role,
        attemptId,
        seedKind: desired.seedKind,
      });

      const entry = { taskId: desired.taskId, role: desired.role, attemptId, timer: null, controller: new AbortController() };
      running.set(attemptId, entry);

      if (emit.vanish) {
        running.delete(attemptId);
        return { attemptId };
      }

      const fire = async () => {
        if (pauseGate.paused) await pauseGate.wait(entry.controller.signal).catch(() => {});
        if (!running.has(attemptId)) return;
        /** @type {import('./engine.js').AttemptEnd} */
        const end = {
          attemptId,
          taskId: desired.taskId,
          role: desired.role,
          outcome: emit.outcome ?? defaultOutcome,
          ...(emit.summary === undefined ? {} : { summary: emit.summary }),
          ...(emit.evidence === undefined ? {} : { evidence: emit.evidence }),
          ...(emit.sha === undefined ? {} : { sha: emit.sha }),
          ...(emit.files === undefined ? {} : { files: emit.files }),
        };
        if (desired.role === 'merge' && end.outcome === 'pass' && end.sha === undefined) {
          end.sha = `sha-${attemptId}`;
        }
        try {
          for (const listener of listeners) await listener(end);
        } finally {
          running.delete(attemptId);
        }
      };

      if (emit.delayMs) entry.timer = clock.setTimer(fire, emit.delayMs);
      else void Promise.resolve().then(fire);

      return {
        attemptId,
        ...(typeof emit.worktree === 'string' && emit.worktree ? { worktree: emit.worktree } : {}),
      };
    },

    /**
     * @param {string} attemptId
     * @returns {Promise<void>}
     */
    async stop(attemptId) {
      const entry = running.get(attemptId);
      if (!entry) return;
      entry.controller.abort();
      if (entry.timer !== null) clock.clearTimer(entry.timer);
      running.delete(attemptId);
    },

    /**
     * @param {(end: import('./engine.js').AttemptEnd) => void} handler
     * @returns {void}
     */
    onEnd(handler) {
      listeners.push(handler);
    },


    get started() {
      return startLog;
    },

    /**
     * Drop running attempts with no end events.
     * @returns {void}
     */
    vanishAll() {
      for (const entry of running.values()) {
        entry.controller.abort();
        if (entry.timer !== null) clock.clearTimer(entry.timer);
      }
      running.clear();
    },
  };
}
