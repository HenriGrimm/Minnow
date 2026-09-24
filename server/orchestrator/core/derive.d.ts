import type { Attempt, BoardState, Role, TaskState } from './types';

/**
 * First `board.started` when the caller omits N.
 */
export const DEFAULT_BOARD_CONCURRENCY: 2;

/** Fold a journal into board state. Total: never throws, whatever the input. */
export function derive(events: Iterable<unknown>): BoardState;

/** The state of a board with no journal at all. Pre-start concurrency is 1. */
export function emptyState(): BoardState;

/**
 * Fold events into an existing state, in place, and recompute phases.
 */
export function foldInto(state: BoardState, events: Iterable<unknown>): BoardState;

/** The most recent attempt that finished, or undefined if none has. */
export function lastEndedAttempt(task: TaskState): Attempt | undefined;

/** The role that last sent this task back to a builder, walking back over builder attempts. */
export function builderSentBackBy(task: TaskState): Role | null;

/**
 * How many attempts of a role have finished for a task.
 */
export function attemptCount(state: BoardState, taskId: string, role: Role): number;

/** Interruptions a task gets for free per role, since its last pass. */
export const FREE_INTERRUPTION_RETRIES: number;

/** Ended because Minnow or the model server went away, not because of the agent. */
export function isInterruption(attempt: Attempt | undefined | null): boolean;

/** Failed attempts of a role since its last pass; free interruptions excluded. */
export function retryBudgetUsed(state: BoardState, taskId: string, role: Role): number;

/** Free interruption retries this role has left on the task. */
export function freeInterruptionsLeft(state: BoardState, taskId: string, role: Role): number;

/** Was this ended attempt an interruption the task got for free? */
export function isFreeInterruption(state: BoardState, taskId: string, attempt: Attempt | undefined): boolean;

/** Newest ended attempt of `role` whose outcome is one of `outcomes`. */
export function lastAttemptWith(task: TaskState, role: Role, outcomes: readonly string[]): Attempt | undefined;

/**
 * Tasks whose every dependency has merged and which are not themselves finished, in declared order.
 */
export function readyTasks(state: BoardState): string[];

/**
 * Tasks that can never run because an upstream task is abandoned or skipped.
 */
export function deadEnded(state: BoardState): Map<string, string>;
