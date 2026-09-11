import type { RunState, SuperPlanGraph } from './types';

/** Every pipeline stage is an agent role the engine can start. */
export function isSuperPlanRole(role: string): boolean;

/** The fold journals nothing on its own. */
export function impliedEvents(): Record<string, unknown>[];

export function isAlreadyEnded(state: RunState, attemptId: string): boolean;

/** Open attempts no effector is running, journaled as crashed so they retry. */
export function reapVanished(
  state: RunState,
  live: Set<string>,
  buffered: Set<string>,
): Record<string, unknown>[];

/** `stage.started` for a new attempt. */
export function eventsForStart(
  want: { taskId: string | null; role: string; seedKind?: string },
  handle: { attemptId: string; iteration?: number; transcriptKey?: string },
): Record<string, unknown>[];

/** Artifact, identity and findings facts, then `stage.ended`, in one batch. */
export function eventsForAttemptEnd(end: {
  attemptId: string;
  taskId: string | null;
  role: string;
  outcome: string;
  summary?: string;
  evidence?: Record<string, unknown> | null;
  usage?: Record<string, number>;
}): Record<string, unknown>[];

export function createSuperPlanGraph(): SuperPlanGraph;

export const superPlanGraph: SuperPlanGraph;
