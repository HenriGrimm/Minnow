/** HTTP routes for /api/super-plan. */

import type { Engine, Effector } from '../orchestrator/engine';
import type { systemClock } from '../orchestrator/engine';
import type { RunState } from './types';

export const ROUTES: Array<{
  method: string;
  pattern: RegExp;
  name: string;
}>;

export function matchRoute(
  method: string,
  pathname: string,
): { name: string; params: string[] } | null;

export function handleSuperPlanRequest(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  pathname: string,
): Promise<boolean>;

export function setSuperPlanEffectorFactory(
  factory: (runId: string) => Effector,
): void;

export function getSuperPlanEngine(
  runId: string,
  options?: {
    clock?: typeof systemClock;
    tickMs?: number;
  },
): Promise<Engine>;

export function createSuperPlanMiddleware(): (
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  next: () => void,
) => Promise<void>;

export function bootSuperPlanRuntime(options?: {
  clock?: typeof systemClock;
  tickMs?: number;
}): Promise<void>;

export function resetSuperPlanMiddlewareForTests(): void;

export { disposeEngines } from '../orchestrator/engine';

export const MUTATING_ROUTES: Set<string>;

export type { RunState };
export function createProductionSuperPlanEffector(runId: string): Effector;
