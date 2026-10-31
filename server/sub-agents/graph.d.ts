import type { Caps } from './types';
import type { Graph } from '../orchestrator/engine';
import type { AttemptEnd } from '../orchestrator/engine';
import type { Desired } from '../orchestrator/core/types';
import type { AgentsState } from './types';

export function isSubAgentRole(role: string): boolean;
export function impliedEvents(state: AgentsState): Record<string, unknown>[];
export function isAlreadyEnded(state: AgentsState, attemptId: string): boolean;
export function reapVanished(
  state: AgentsState,
  live: Set<string>,
  buffered: Set<string>,
): Record<string, unknown>[];
export function eventsForStart(
  want: Pick<Desired, 'taskId' | 'role' | 'seedKind'>,
  handle: { attemptId: string; model?: { providerId: string; id: string }; executionId?: string; commandId?: string },
): Record<string, unknown>[];
export function eventsForAttemptEnd(end: AttemptEnd): Record<string, unknown>[];
export function createSubAgentGraph(caps?: Caps): Graph;
export const subAgentGraph: Graph;
