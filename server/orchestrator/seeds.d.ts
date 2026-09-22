import type { BoardState, SeedKind } from './core/types';

/** The kinds, in the order the policy table names them, then the rerun seed. */
export const SEED_KINDS: readonly SeedKind[];

/**
 * Build the user-message seed for one attempt.
 */
export function buildSeed(
  kind: SeedKind,
  input: {
    state: BoardState;
    taskId: string;
    /** Digest of the attempt a `continue` picks up (see `resume-digest.js`). */
    resume?: string;
  },
): string;
