/** Engine-facing graph for the Super Plan run engine, mirroring `server/sub-agents/graph.js`. */

import { foldInto } from './derive.js';
import { makeEvent, STAGES, STAGE_OUTCOMES } from './events.js';
import { plan } from './plan.js';

/**
 * Every pipeline stage is an agent role the engine can start.
 * @param {string} role
 * @returns {boolean}
 */
export function isSuperPlanRole(role) {
  return STAGES.includes(/** @type {any} */ (role));
}

/**
 * The fold journals nothing on its own: checkpoints are state, not events,
 * and every transition follows a fact some caller appended.
 * @returns {Record<string, unknown>[]}
 */
export function impliedEvents() {
  return [];
}

/**
 * @param {import('./types').RunState} state
 * @param {string} attemptId
 * @returns {boolean}
 */
export function isAlreadyEnded(state, attemptId) {
  for (const attempt of state?.attempts ?? []) {
    if (attempt.attemptId === attemptId) return attempt.ended;
  }
  return false;
}

/**
 * Attempts the journal still has open that no effector is running (the
 * process restarted) are journaled as `interrupted`, so replay converges on
 * what a live observer saw. The stage continues from its transcript, and an
 * interruption does not count against its failure budget.
 *
 * @param {import('./types').RunState} state
 * @param {Set<string>} live
 * @param {Set<string>} buffered
 * @returns {Record<string, unknown>[]}
 */
export function reapVanished(state, live, buffered) {
  /** @type {Record<string, unknown>[]} */
  const ended = [];
  if (!state) return ended;
  for (const attempt of state.attempts) {
    if (attempt.ended) continue;
    if (live.has(attempt.attemptId) || buffered.has(attempt.attemptId)) continue;
    ended.push(
      makeEvent('stage.ended', {
        stage: attempt.stage,
        attemptId: attempt.attemptId,
        outcome: 'interrupted',
        summary: 'Interrupted before it finished; it picks up from where it stopped.',
      }),
    );
  }
  return ended;
}

/**
 * `stage.started` for a new attempt. The effector returns the iteration and
 * transcript key it was started for.
 *
 * @param {{ taskId: string | null, role: string, seedKind?: string }} want
 * @param {{ attemptId: string, iteration?: number, transcriptKey?: string }} handle
 * @returns {Record<string, unknown>[]}
 */
export function eventsForStart(want, handle) {
  if (!isSuperPlanRole(want.role) || !want.taskId) return [];
  return [
    makeEvent('stage.started', {
      stage: want.role,
      attemptId: handle.attemptId,
      seedKind: want.seedKind,
      ...(Number.isSafeInteger(handle.iteration) && /** @type {number} */ (handle.iteration) >= 1
        ? { iteration: handle.iteration }
        : {}),
      ...(typeof handle.transcriptKey === 'string' && handle.transcriptKey ? { transcriptKey: handle.transcriptKey } : {}),
    }),
  ];
}

/**
 * Facts for an attempt that ended. Everything the stage produced is journaled
 * before `stage.ended` in the same batch, so the fold decides the next step
 * with the artifact, identity and findings already in state.
 *
 * @param {{
 *   attemptId: string,
 *   taskId: string | null,
 *   role: string,
 *   outcome: string,
 *   summary?: string,
 *   evidence?: Record<string, any> | null,
 *   usage?: Record<string, number>,
 * }} end
 * @returns {Record<string, unknown>[]}
 */
export function eventsForAttemptEnd(end) {
  if (!isSuperPlanRole(end.role) || !end.taskId) return [];
  const outcome = stageOutcomeOf(end.outcome);
  const evidence = end.evidence && typeof end.evidence === 'object' ? end.evidence : {};
  /** @type {Record<string, unknown>[]} */
  const events = [];
  if (outcome === 'ok') {
    if (evidence.slug && typeof evidence.slug.slug === 'string') {
      events.push(makeEvent('slug.assigned', { slug: evidence.slug.slug, title: evidence.slug.title }));
    }
    if (evidence.artifact && typeof evidence.artifact.path === 'string') {
      events.push(makeEvent('artifact.written', { ...evidence.artifact, attemptId: end.attemptId }));
    }
    if (end.role === 'review' && evidence.review && Array.isArray(evidence.review.findings)) {
      events.push(
        makeEvent('review.recorded', {
          round: Number.isSafeInteger(evidence.review.round) && evidence.review.round >= 1 ? evidence.review.round : 1,
          summary: typeof evidence.review.summary === 'string' ? evidence.review.summary : '',
          findings: evidence.review.findings.filter((f) => f && typeof f === 'object' && !Array.isArray(f)),
          attemptId: end.attemptId,
        }),
      );
    }
  }
  events.push(
    makeEvent('stage.ended', {
      stage: end.role,
      attemptId: end.attemptId,
      outcome,
      ...(typeof end.summary === 'string' && end.summary ? { summary: end.summary.slice(0, 4000) } : {}),
      ...(Array.isArray(evidence.errors) && evidence.errors.length
        ? { errors: evidence.errors.map((e) => String(e).slice(0, 4000)) }
        : {}),
      ...(evidence.addressed && typeof evidence.addressed === 'object' && !Array.isArray(evidence.addressed)
        ? { addressed: evidence.addressed }
        : {}),
      ...(end.usage && typeof end.usage === 'object' ? { usage: end.usage } : {}),
    }),
  );
  return events;
}

/**
 * @param {string} outcome
 * @returns {string}
 */
function stageOutcomeOf(outcome) {
  if (STAGE_OUTCOMES.includes(/** @type {any} */ (outcome))) return outcome;
  if (outcome === 'pass') return 'ok';
  return 'rejected';
}

/**
 * @returns {import('./types').SuperPlanGraph}
 */
export function createSuperPlanGraph() {
  return {
    foldInto,
    plan,
    impliedEvents,
    isAgentRole: isSuperPlanRole,
    isAlreadyEnded,
    reapVanished,
    eventsForStart,
    eventsForAttemptEnd,
    defaultConcurrency: 1,
  };
}

/** @type {import('./types').SuperPlanGraph} */
export const superPlanGraph = createSuperPlanGraph();
