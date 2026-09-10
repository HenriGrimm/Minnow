import type { Desired, RunState, SeedKind, StageId } from './types';

/**
 * Which attempt should be running right now. Strictly sequential — concurrency
 * 1 — so the answer is zero or one Desired. An open gate yields an empty plan
 * (the only thing keeping the pipeline from running is the user's answer), as
 * does a stage waiting for a non-agent event (`review.recorded`) after a
 * successful attempt. A stage with an attempt in flight re-desires that same
 * attempt (same taskId / role / seedKind) so the engine's reconcile loop does
 * not stop it — an unclaimed delegated lease is re-offered, never reset.
 */
export function plan(state: RunState): Desired[];

/** Why the next attempt of a stage is seeded the way it is. */
export function seedKindFor(state: RunState, stage: StageId): SeedKind;

export type { Desired, RunState, SeedKind, StageId };
