import { BUILT_IN_TOOLS } from '../tools/definitions';
import type { EvalTask } from './types';
import type { ToolExecutionResult } from '../types';
import { validateEvalToolFixtures } from '../../server/evals/tool-fixtures.js';

export interface EvalFixtureReport { pass: boolean; completedSteps: number; expectedSteps: number; actualCalls: number; violations: string[] }
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

/** Same eval runner boundary, with no live tool fallback even after script exhaustion. */
export function createScriptedEvalToolExecutor(task: EvalTask) {
  const script = validateEvalToolFixtures(task.toolFixtures, task.allowedTools, task.deniedTools, new Set(BUILT_IN_TOOLS.map(tool => tool.id)));
  let completed = 0, calls = 0;
  const violations: string[] = [];
  const execute = async (name: string, args: Record<string, unknown>): Promise<ToolExecutionResult> => {
    calls++;
    const definition = BUILT_IN_TOOLS.find(tool => tool.id === name)?.definition.function.parameters;
    const step = script.steps[completed];
    const valid = definition && task.allowedTools.includes(name) && !task.deniedTools.includes(name) &&
      Object.keys(args).every(key => Object.hasOwn(definition.properties, key)) &&
      (definition.required ?? []).every(key => Object.hasOwn(args, key)) && step?.name === name &&
      Object.entries(step.matchArgs).every(([key, expected]) => canonical(args[key]) === canonical(expected));
    if (!valid) {
      const message = `Unexpected fixture call ${calls}: ${name} at step ${completed + 1}`;
      if (violations.length < 20) violations.push(message);
      return { content: `Error: ${message}; no real operation was performed.` };
    }
    completed++;
    return { content: typeof step.result === 'string' ? step.result : JSON.stringify(step.result) };
  };
  return Object.assign(execute, { fixtureReport(): EvalFixtureReport {
    return { pass: violations.length === 0 && completed === script.steps.length, completedSteps: completed,
      expectedSteps: script.steps.length, actualCalls: calls,
      violations: completed === script.steps.length ? [...violations] : [...violations, 'Required fixture calls were not completed'] };
  } });
}
