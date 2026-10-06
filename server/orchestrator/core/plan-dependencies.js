/** Catch plan edges that isolated worktrees cannot infer from wave numbers. */

import { normalizeRepoPath, pathMatchesGlob } from './plan.js';

const EXPORT = /\bexport\s+(?:type|interface|class|function|const|enum)\s+([A-Za-z_$][\w$]*)\b/g;
const PATH = /`((?:[\w.-]+\/)+[\w.-]+\.[\w]+)`/g;
const CREATED_PATH = /\bCREATE\s+`((?:[\w.-]+\/)+[\w.-]+\.[\w]+)`/gi;
const SCRIPT = /["']([a-z][\w:-]*)["']\s*:\s*["'][^"']+["']/g;
const NPM_RUN = /\bnpm\s+(?:run\s+)?([a-z][\w:-]*)\b/g;

/**
 * @param {import('./types').PlanTask[]} tasks
 * @param {readonly string[]} repoFiles
 * @returns {import('./types').ParseError[]}
 */
export function validatePlanDependencies(tasks, repoFiles) {
  const existing = new Set(repoFiles.map(normalizeRepoPath));
  const byId = new Map(tasks.map((task) => [task.id, task]));
  /** @type {Map<string, Set<string>>} */
  const exportsByTask = new Map();
  /** @type {Map<string, Set<string>>} */
  const scriptsByTask = new Map();
  for (const task of tasks) {
    exportsByTask.set(task.id, new Set([...task.build.matchAll(EXPORT)].map((match) => match[1])));
    scriptsByTask.set(task.id, task.touches.some((path) => pathMatchesGlob('package.json', path))
      ? new Set([...task.build.matchAll(SCRIPT)].map((match) => match[1]))
      : new Set());
  }

  /** @type {import('./types').ParseError[]} */
  const errors = [];
  for (const [index, task] of tasks.entries()) {
    const spec = `${task.build}\n${task.test}\n${task.accept}`;
    const words = new Set(spec.match(/[A-Za-z_$][\w$]*/g) ?? []);
    const required = new Set();
    for (const other of tasks.slice(0, index)) {
      if (other.id === task.id || dependsOn(task, other.id, byId)) continue;
      const producedPaths = [...new Set([
        ...other.touches.filter((path) => !/[?*\[\]{}]/.test(path)),
        ...[...other.build.matchAll(CREATED_PATH)].map((match) => match[1])
          .filter((path) => other.touches.some((glob) => pathMatchesGlob(path, glob))),
      ].map(normalizeRepoPath).filter((path) => !existing.has(path)))];
      const referencedPath = [...spec.matchAll(PATH)].some((match) =>
        producedPaths.some((path) => normalizeRepoPath(match[1]) === normalizeRepoPath(path)));
      const referencedExport = [...(exportsByTask.get(other.id) ?? [])].some((name) =>
        name.length >= 4 && words.has(name));
      const referencedScript = [...spec.matchAll(NPM_RUN)].some((match) =>
        scriptsByTask.get(other.id)?.has(match[1]));
      if (referencedPath || (producedPaths.length > 0 && referencedExport) || referencedScript) {
        required.add(other.id);
      }
    }
    for (const id of required) {
      errors.push({
        line: task.line,
        column: 1,
        message: `task ${task.id} uses work introduced by ${id} without depending on it`,
        hint: `add \`- **Depends on:** ${id}\` (or include ${id} in the existing list) so its files are merged before ${task.id} starts`,
      });
    }
  }
  return errors;
}

/** @param {import('./types').PlanTask} task @param {string} id @param {Map<string, import('./types').PlanTask>} byId */
function dependsOn(task, id, byId) {
  const pending = [...task.dependsOn];
  const seen = new Set();
  while (pending.length > 0) {
    const next = pending.pop();
    if (next === id) return true;
    if (!next || seen.has(next)) continue;
    seen.add(next);
    pending.push(...(byId.get(next)?.dependsOn ?? []));
  }
  return false;
}
