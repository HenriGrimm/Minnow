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
  return STAGES.includes(role);
}

/**
 * Events the engine should append without an agent: gates that just opened and
 * runs that just reached a terminal outcome.
 *
 * @param {import('./types').RunState} state
 * @returns {Record<string, unknown>[]}
 */
export function impliedEvents(state) {
  if (!state || state.finished || state.status !== 'running') return [];
  /** @type {Record<string, unknown>[]} */
  const decisions = [];

  if (state.pendingFinish && !state.finished) {
    decisions.push(
      makeEvent('run.finished', {
        outcome: state.pendingFinish,
        summary: summaryFor(state.pendingFinish),
      }),
    );
  }

  return decisions;
}

/**
 * @param {string} outcome
 * @returns {string}
 */
function summaryFor(outcome) {
  if (outcome === 'pass') return 'the plan passed the accept gate';
  if (outcome === 'fail') return 'the pipeline exhausted its retries';
  return 'the pipeline skipped the remaining work';
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
 * Stage attempts that are neither live nor buffered have vanished; journal
 * them as crashed so replay converges on the same state as a live observer.
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
    if (live.has(attempt.attemptId)) continue;
    if (buffered.has(attempt.attemptId)) continue;
    ended.push(
      makeEvent('stage.ended', {
        stage: attempt.stage,
        attemptId: attempt.attemptId,
        outcome: 'crashed',
        summary: 'the process was no longer running',
      }),
    );
  }
  return ended;
}

/**
 * `eventsForStart` maps onto `stage.started`. `want.taskId` is the runId.
 *
 * @param {{ taskId: string | null, role: string, seedKind?: string }} want
 * @param {{ attemptId: string }} handle
 * @returns {Record<string, unknown>[]}
 */
export function eventsForStart(want, handle) {
  if (!isSuperPlanRole(want.role) || !want.taskId) return [];
  /** @type {Record<string, unknown>} */
  const payload = { stage: want.role, attemptId: handle.attemptId };
  if (want.seedKind) payload.seedKind = want.seedKind;
  return [makeEvent('stage.started', payload)];
}

/**
 * `eventsForAttemptEnd` maps onto `stage.ended`. The runner's canonical
 * outcomes are translated onto the stage vocabulary (`pass` → `ok`);
 * anything else that is not already a stage outcome is recorded as
 * `rejected`, which the policy table routes.
 *
 * @param {{
 *   attemptId: string,
 *   taskId: string | null,
 *   role: string,
 *   outcome: string,
 *   summary?: string,
 *   evidence?: Record<string, unknown> | null,
 * }} end
 * @returns {Record<string, unknown>[]}
 */
export function eventsForAttemptEnd(end) {
  if (!isSuperPlanRole(end.role) || !end.taskId) return [];
  const outcome = end.role === 'review' && stageOutcomeOf(end.outcome) === 'ok' && !Array.isArray(end.evidence?.findings) ? 'rejected' : stageOutcomeOf(end.outcome);
  /** @type {Record<string, unknown>} */
  const payload = { stage: end.role, attemptId: end.attemptId, outcome };
  if (end.summary !== undefined) payload.summary = end.summary;
  const errors = end.evidence?.errors;
  if (Array.isArray(errors)) payload.errors = errors.map(String);
  // A draft's `addressed` claim (findingIds + dispositions) rides the same
  // evidence channel, so the fold can record what the draft says it fixed.
  const addressed = end.evidence?.addressed;
  if (addressed !== undefined && addressed !== null) payload.addressed = addressed;
  const events = [makeEvent('stage.ended', payload)];
  if (outcome === 'ok' && Array.isArray(end.evidence?.findings)) events.push(makeEvent('review.recorded', { round: 1, findings: end.evidence.findings }));
  if (outcome === 'ok' && end.evidence?.artifact) events.unshift(makeEvent(end.role === 'interview' ? 'spec.written' : end.role === 'research' ? 'research.written' : 'plan.written', end.evidence.artifact));
  return events;
}

/**
 * @param {string} outcome
 * @returns {string}
 */
function stageOutcomeOf(outcome) {
  if (STAGE_OUTCOMES.includes(/** @type {any} */ (outcome))) return outcome;
  if (outcome === 'pass') return 'ok';
  if (outcome === 'crashed') return 'crashed';
  if (outcome === 'timeout') return 'timeout';
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