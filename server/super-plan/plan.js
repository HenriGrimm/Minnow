/** Pure scheduler: plan(state) returns the attempt that should be running. */

import { stepRecords } from './derive.js';

/**
 * The engine's task id for the current step. The epoch changes whenever the
 * user replaces running work (rework, skip, retry, resume), so the engine's
 * `sameWork` no longer matches the old attempt and stops it.
 * @param {import('./types').RunState} state
 * @returns {string}
 */
export function taskIdFor(state) {
  return `${state.runId}~${state.epoch}`;
}

/**
 * Which attempt should be running right now. The pipeline is sequential, so
 * this is zero or one Desired; checkpoints and pauses want nothing.
 *
 * A stage with an attempt in flight stays desired: the engine matches it back
 * to the live attempt through `sameWork`, so no duplicate starts.
 *
 * @param {import('./types').RunState} state
 * @returns {import('./types').Desired[]}
 */
export function plan(state) {
  if (!state || state.legacy || state.finished || state.status !== 'running') return [];
  if (state.step?.kind !== 'stage') return [];
  return [{ taskId: taskIdFor(state), role: state.step.stage, seedKind: seedKindFor(state) }];
}

/**
 * How the next attempt of the current step is seeded. A retry after a crash,
 * timeout or pause continues the same transcript; a retry after rejected work
 * continues it with the errors.
 * @param {import('./types').RunState} state
 * @returns {import('./types').SeedKind}
 */
export function seedKindFor(state) {
  if (state?.step?.kind !== 'stage') return 'initial';
  const records = stepRecords(state);
  const last = records[records.length - 1];
  if (!last) return state.step.seedKind;
  if (last.outcome === 'rejected') return 'errors';
  if (last.outcome === 'crashed' || last.outcome === 'timeout' || last.outcome === 'paused' || last.outcome === 'interrupted') return 'continue';
  return state.step.seedKind;
}

/**
 * The transcript an attempt of the current step writes. Retries of one step
 * share it; a new step (another draft, another review) starts a new one.
 * @param {import('./types').RunState} state
 * @returns {string}
 */
export function transcriptKeyFor(state) {
  if (state?.step?.kind !== 'stage') return '';
  return `${state.step.stage}-${state.step.iteration}`;
}
