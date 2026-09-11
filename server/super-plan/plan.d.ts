import type { Desired, RunState, SeedKind } from './types';

/** Engine task id for the current step; changes with the epoch so replaced work is stopped. */
export function taskIdFor(state: RunState): string;

/**
 * Which attempt should be running right now: zero or one Desired. Checkpoints,
 * pauses, halts and finished runs want nothing.
 */
export function plan(state: RunState): Desired[];

/** How the next attempt of the current step is seeded. */
export function seedKindFor(state: RunState): SeedKind;

/** Transcript key shared by every attempt of the current step. */
export function transcriptKeyFor(state: RunState): string;

export type { Desired, RunState, SeedKind };
