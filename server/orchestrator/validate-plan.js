/** Shared workspace-aware validation for agent checks and board intake/resync. */
import { isParseErrors, parsePlan } from './core/parse-plan.js';
import { validatePlanDependencies } from './core/plan-dependencies.js';
import { listRepoFiles } from './touches.js';

/**
 * @param {string} markdown
 * @returns {Promise<
 *   { ok: true, graph: import('./core/types').TaskGraph, repoFiles: string[] } |
 *   { ok: false, error: string, errors: import('./core/types').ParseError[] }
 * >}
 */
export async function validateBoardPlan(markdown) {
  const graph = parsePlan(markdown);
  if (isParseErrors(graph)) {
    return { ok: false, error: 'the plan does not parse', errors: graph };
  }
  const repoFiles = await listRepoFiles();
  const errors = validatePlanDependencies(graph.tasks, repoFiles);
  if (errors.length > 0) {
    return { ok: false, error: 'the plan has missing task dependencies', errors };
  }
  return { ok: true, graph, repoFiles };
}
