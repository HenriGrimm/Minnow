/**
 * The Super Plan effector: one per run, every stage on the server.
 *
 * `start()` returns at once with the attempt id; the work runs in the
 * background and reports through `onEnd`. An attempt stays in `inspect()`
 * until every end handler has settled (the engine contract), and the engine
 * is ticked right after so a retry or the next stage starts immediately
 * rather than on the next safety tick.
 *
 * I/O module: excluded from the pure-core guard.
 */

import { randomUUID } from 'node:crypto';

import { peekEngine } from '../orchestrator/engine.js';
import { runAgentStage } from './agent-stage.js';
import { runResearchStage } from './research.js';
import { STAGES } from './events.js';

export const SUPERPLAN_ENGINE_NAMESPACE = 'superplan';

/** How long an attempt waits for the engine to journal its start. */
const START_JOURNAL_WAIT_MS = 5000;

/**
 * @param {unknown} err
 * @returns {string}
 */
function errorMessage(err) {
  if (err instanceof Error && err.message) return err.message;
  return String(err ?? 'unknown error');
}

/**
 * Resolve once `stage.started` for this attempt is folded, so nothing the
 * attempt journals can land before its own start.
 * @param {{ getState: () => any, subscribe: (fn: (event: any) => void) => () => void }} engine
 * @param {string} attemptId
 * @returns {Promise<void>}
 */
function startJournaled(engine, attemptId) {
  const known = () => engine.getState().attempts.some((a) => a.attemptId === attemptId);
  if (known()) return Promise.resolve();
  return new Promise((resolve) => {
    let unsubscribe = () => {};
    const timer = setTimeout(() => {
      unsubscribe();
      resolve();
    }, START_JOURNAL_WAIT_MS);
    timer.unref?.();
    unsubscribe = engine.subscribe(() => {
      if (!known()) return;
      clearTimeout(timer);
      unsubscribe();
      resolve();
    });
  });
}

/**
 * @param {{
 *   runId: string,
 *   getEngine?: () => any,
 *   runStage?: (input: Record<string, any>) => Promise<{ outcome: string, summary?: string, evidence?: Record<string, unknown>, usage?: Record<string, number> }>,
 * }} options
 */
export function createSuperPlanEffector(options) {
  const runId = options.runId;
  const getEngine = options.getEngine ?? (() => peekEngine(runId, SUPERPLAN_ENGINE_NAMESPACE));

  /**
   * @typedef {object} LiveAttempt
   * @property {string} attemptId
   * @property {string | null} taskId
   * @property {string} role
   * @property {AbortController} controller
   * @property {boolean} stopped
   */

  /** @type {Map<string, LiveAttempt>} */
  const running = new Map();
  /** @type {Array<(end: import('../orchestrator/engine.js').AttemptEnd) => Promise<void> | void>} */
  const listeners = [];
  /** @type {Array<{ taskId: string | null, role: string, attemptId: string, seedKind?: string }>} */
  const startLog = [];

  /**
   * @param {Record<string, any>} input
   */
  async function defaultRunStage(input) {
    if (input.role === 'research') return runResearchStage(input);
    return runAgentStage(/** @type {any} */ (input));
  }
  const runStage = options.runStage ?? defaultRunStage;

  return {
    inspect() {
      return [...running.values()].map(({ taskId, role, attemptId }) => ({ taskId, role, attemptId }));
    },

    /**
     * @param {{ taskId: string | null, role: string, seedKind?: string }} desired
     * @returns {Promise<{ attemptId: string, iteration?: number, transcriptKey?: string }>}
     */
    async start(desired) {
      const role = String(desired.role);
      if (!STAGES.includes(/** @type {any} */ (role))) {
        throw new Error(`super plan effector: unsupported role ${role}`);
      }
      const engine = getEngine();
      if (!engine) throw new Error(`super plan effector: engine for ${runId} is not loaded`);
      const state = engine.getState();
      const step = state.step?.kind === 'stage' && state.step.stage === role ? state.step : null;
      const iteration = step?.iteration ?? 1;
      const transcriptKey = `${role}-${iteration}`;
      const seedKind = desired.seedKind ?? 'initial';
      const attemptId = `sp-${role}-${randomUUID().slice(0, 12)}`;
      const controller = new AbortController();
      /** @type {LiveAttempt} */
      const entry = { attemptId, taskId: desired.taskId ?? null, role, controller, stopped: false };
      running.set(attemptId, entry);
      startLog.push({ taskId: entry.taskId, role, attemptId, seedKind });

      void (async () => {
        /** @type {{ outcome: string, summary?: string, evidence?: Record<string, unknown>, usage?: Record<string, number> }} */
        let end;
        try {
          await startJournaled(engine, attemptId);
          end = await runStage({ engine, runId, attemptId, role, seedKind, transcriptKey, signal: controller.signal });
        } catch (err) {
          end = { outcome: 'crashed', summary: errorMessage(err) };
        }
        if (entry.stopped) return;
        try {
          for (const listener of listeners) {
            await listener({
              attemptId,
              taskId: entry.taskId,
              role,
              outcome: end.outcome,
              ...(end.summary ? { summary: end.summary } : {}),
              ...(end.evidence ? { evidence: end.evidence } : {}),
              ...(end.usage ? { usage: end.usage } : {}),
            });
          }
        } catch (err) {
          console.warn(`[super-plan] ${runId}: recording the end of ${attemptId} failed:`, errorMessage(err));
        } finally {
          running.delete(attemptId);
          void getEngine()?.tick().catch(() => {});
        }
      })();

      return { attemptId, iteration, transcriptKey };
    },

    /**
     * @param {string} attemptId
     * @returns {Promise<void>}
     */
    async stop(attemptId) {
      const entry = running.get(attemptId);
      if (!entry) return;
      entry.stopped = true;
      entry.controller.abort();
      running.delete(attemptId);
    },

    /**
     * @param {(end: import('../orchestrator/engine.js').AttemptEnd) => Promise<void> | void} handler
     */
    onEnd(handler) {
      listeners.push(handler);
    },

    get started() {
      return startLog;
    },

    /** Drop every attempt without an end: the crash analogue for tests. */
    vanishAll() {
      for (const entry of running.values()) {
        entry.stopped = true;
        entry.controller.abort();
      }
      running.clear();
    },
  };
}
