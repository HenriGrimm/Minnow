/** Pure scheduler: plan(state) returns Desired[] — the 8-line pipeline. */

import { lastEndedStage } from './derive.js';

/**
 * Which attempt should be running right now.
 *
 * The pipeline is strictly sequential — concurrency 1 — so the answer is zero
 * or one Desired. The review iterate-loop lives in the fold
 * (`advanceAfterReview`); plan only turns the derived stage into a Desired.
 *
 * @param {import('./types').RunState} state
 * @returns {import('./types').Desired[]}
 */
export function plan(state) {
  if (!state) return [];
  if (state.finished || state.status !== 'running') return [];
  const gateAttempt = state.attempts.find((a) => a.stage === 'gate' && !a.ended);
  if (gateAttempt || state.pendingGate || state.gate?.kind === 'spec' || state.gate?.kind === 'accept') {
    return [{ taskId: state.runId, role: 'gate', seedKind: gateAttempt?.seedKind ?? state.pendingGate ?? state.gate.kind }];
  }
  if (!state.stage) return [];

  // A stage with an attempt in flight stays desired — return the *same*
  // Desired the running attempt was started from. The engine reconciles
  // `inspect()` against this plan and stops any running attempt the plan does
  // not name, so an empty plan would kill the attempt on the very next tick.
  // That is the D5 regression: a delegated `interview`/`draft` lease sits
  // unclaimed while the renderer catches up, and the engine must keep offering
  // it rather than resetting the stage. `sameWork` (engine.js) matches the
  // re-desired role back to the live attempt, so no duplicate `stage.started`
  // is journaled; a crash-and-reload still reaps the vanished attempt as
  // `crashed` before this branch (reapVanished runs first) and re-plans it.
  const inFlight = state.attempts.find((a) => a.stage === state.stage && !a.ended);
  if (inFlight) {
    return [{ taskId: state.runId, role: state.stage, seedKind: seedKindFor(state, state.stage) }];
  }

  return [{ taskId: state.runId, role: state.stage, seedKind: seedKindFor(state, state.stage) }];
}

/**
 * Why the next attempt of a stage is seeded the way it is.
 * @param {import('./types').RunState} state
 * @param {import('./types').StageId} stage
 * @returns {import('./types').SeedKind}
 */
export function seedKindFor(state, stage) {
  if (stage === 'interview' && state.interviewSeed) return state.interviewSeed;
  if (stage === 'draft' && state.draftSeed) return state.draftSeed;
  const last = lastEndedStage(state, stage);
  if (last && (last.outcome === 'crashed' || last.outcome === 'timeout')) return 'continue';
  return 'initial';
}