import type { ParseError, PlanTask } from './types';

export function validatePlanDependencies(
  tasks: PlanTask[],
  repoFiles: readonly string[],
): ParseError[];
