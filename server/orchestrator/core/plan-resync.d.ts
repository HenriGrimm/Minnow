import type { BoardState, PlanResync } from './types';

type Spec = {
  title: string;
  build: string | null;
  test: string | null;
  accept: string | null;
  touches: string[];
};

/** The spec each plan-sourced card had when it last came from the plan. */
export function planBaseSpecs(events: Iterable<unknown>): Map<string, Spec>;

/** What re-syncing the plan would do to the board (three-way, per spec field). */
export function planResync(
  state: BoardState,
  events: Iterable<unknown>,
  planTasks: ReadonlyArray<Record<string, any>>,
  planWaves: ReadonlyArray<{ n: number; name: string }>,
): PlanResync;

/** True when applying the re-sync would journal anything. */
export function resyncHasWork(result: PlanResync): boolean;
