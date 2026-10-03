import type { BoardState, Desired, PlanTask, WaveRef } from './core/types';
import type { AttemptEnd, Graph } from './engine';
import type { ReportComplete } from './report';

export function isBoardAgentRole(role: string): boolean;
export function boardRunSummary(state: BoardState): string;
export function boardImpliedEvents(state: BoardState): Record<string, unknown>[];
export function boardEventsForRunComplete(state: BoardState): Record<string, unknown>[];
export function boardIsAlreadyEnded(state: BoardState, attemptId: string): boolean;
export function boardReapVanished(
  state: BoardState,
  live: Set<string>,
  buffered: Set<string>,
): Record<string, unknown>[];
export function boardEventsForStart(
  want: Desired,
  handle: {
    attemptId: string;
    worktree?: string;
    discarded?: Record<string, unknown>[];
    gitInitialized?: Record<string, unknown>;
  },
): Record<string, unknown>[];
export function boardEventsForPreflight(
  result: { gitInitialized?: Record<string, unknown> } | void,
): Record<string, unknown>[];
export function boardEventsForAttemptEnd(
  end: AttemptEnd,
  ctx: { id: string; state: BoardState },
): Promise<Record<string, unknown>[]>;
export function boardOnLoad(ctx: {
  id: string;
  state: BoardState;
}): Promise<Record<string, unknown>[]>;
export function boardWriteReport(ctx: {
  id: string;
  state: BoardState;
  events: Record<string, unknown>[];
  complete: ReportComplete;
  signal?: AbortSignal;
}): Promise<{ relativePath: string; usedFallback: boolean } | null>;

/** Production graph. `createEngine` defaults to this. */
export const boardGraph: Graph;

export { isReadyForFinalTest } from './core/plan';
export { DEFAULT_BOARD_CONCURRENCY } from './core/derive';
export { defaultComplete, formatMechanicalReport } from './report';

export type { PlanTask, WaveRef };
