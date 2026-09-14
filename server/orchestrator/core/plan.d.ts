import type { BoardState, Desired, Evidence, NextAction } from './types';

/**
 * What should happen to a task that has nothing in flight.
 */
export function nextAction(state: BoardState, taskId: string): NextAction;

/**
 * What a hand-started task should begin, if anything.
 */
export function manualStart(
  state: BoardState,
  taskId: string,
  running?: ReadonlyArray<{ taskId: string | null; role: string }>,
): NextAction;

/** Tasks whose tester passed but which are not yet on the merge queue. */
export function pendingEnqueues(state: BoardState): string[];

/**
 * Tasks that can never run because something upstream was abandoned or skipped.
 */
export function pendingSkips(state: BoardState): Array<{ taskId: string; blockedBy: string }>;

/** Has the board finished everything it can, with final verification outstanding? */
export function isReadyForFinalTest(state: BoardState): boolean;

/** Has the run finished everything it is ever going to do? */
export function isRunComplete(state: BoardState): boolean;

/**
 * Task ids a rerun should reopen, in declared (wave, then insertion) order.
 */
export function reopenTargets(state: BoardState, requested?: readonly string[]): string[];

/**
 * Synthetic integration-fix task derived from the current (or previous) failed final test.
 */
export function buildIntegrationFixTask(state: BoardState): {
  task: import('./types').PlanTask;
  wave: import('./types').WaveRef;
};

/** `minnow/board/<boardId>/integration`. */
export function integrationBranchName(boardId: string): string;

/** Seed guidance: reproduce a final-test failure in the task worktree, not the integration checkout. */
export function integrationReproNote(state: BoardState): string;

/** Tasks the policy table has given up on, with the evidence for each. */
export function pendingAbandonments(
  state: BoardState,
): Array<{ taskId: string; reason: string; evidence: Evidence }>;

/**
 * Which attempts should be running right now.
 */
export function plan(state: BoardState): Desired[];

/** Declared task order, stably keyed on wave first. */
export function orderedTaskIds(state: BoardState): string[];

/**
 * Do two declared footprints overlap?
 */
export function touchesOverlap(a: readonly string[], b: readonly string[]): boolean;

/**
 * Scheduling clash: declared glob overlap, or intersection of journaled expanded file sets.
 */
export function footprintsClash(
  a: { touches?: readonly string[] | null; touchesExpanded?: readonly string[] | null },
  b: { touches?: readonly string[] | null; touchesExpanded?: readonly string[] | null },
): boolean;

export function expandedFilesOverlap(
  a: readonly string[] | null | undefined,
  b: readonly string[] | null | undefined,
): boolean;

/** Match declared globs against a file list. No I/O. */
export function expandTouches(
  globs: readonly string[],
  repoFiles: readonly string[],
): { expanded: string[]; emptyGlobs: string[] };

/** Changed paths that sit outside the declared globs. */
export function overflowPaths(declared: readonly string[], actual: readonly string[]): string[];

export function pathMatchesGlob(file: string, glob: string): boolean;

export function normalizeRepoPath(value: string): string;

/** Could these two globs match a common path? */
export function globsIntersect(a: string, b: string): boolean;
