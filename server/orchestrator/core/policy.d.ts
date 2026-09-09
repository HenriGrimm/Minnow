import type { Action, Evidence, PolicyOutcome, PolicyRow, Role, SeedKind } from './types';

/**
 * The recovery policy, as data rather than control flow.
 */
export const POLICY_TABLE: readonly PolicyRow[];

/** What happens next. Total over every role, outcome, and attempt count. */
export function decide(input: {
  role: Role | string;
  outcome: PolicyOutcome | string;
  attemptCount: number;
  summary?: string | null;
  evidence?: Evidence | null;
}): Action;

export const SAME_WORKTREE_SEED_KINDS: readonly ['repair', 'continue', 'rebase', 'fix'];

/** Does this seed kind repair in place rather than in a fresh worktree? */
export function wantsSameWorktree(seedKind: string | null | undefined): boolean;

/** Render the table as markdown, so tests compare rather than restate. */
export function formatPolicyTable(): string;

export type { Action, PolicyOutcome, PolicyRow, SeedKind };
