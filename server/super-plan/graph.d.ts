import type { RunState, SuperPlanGraph } from './types';

/** Every pipeline stage is an agent role the engine can start. */
export function isSuperPlanRole(role: string): boolean;

/** Events the engine should append without an agent: gates and terminal runs. */
export function impliedEvents(state: RunState): Record<string, unknown>[];

export function isAlreadyEnded(state: RunState, attemptId: string): boolean;

export function reapVanished(
  state: RunState,
  live: Set<string>,
  buffered: Set<string>,
): Record<string, unknown>[];

/** `eventsForStart` maps onto `stage.started`. */
export function eventsForStart(
  want: { taskId: string | null; role: string; seedKind?: string },
  handle: { attemptId: string },
): Record<string, unknown>[];

/** `eventsForAttemptEnd` maps onto `stage.ended`. */
export function eventsForAttemptEnd(end: {
  attemptId: string;
  taskId: string | null;
  role: string;
  outcome: string;
  summary?: string;
  evidence?: Record<string, unknown> | null;
}): Record<string, unknown>[];

export function createSuperPlanGraph(): SuperPlanGraph;

export const superPlanGraph: SuperPlanGraph;
