import { getEnabledToolDefinitions } from '../../tools/client';
import type { OpenAIFunctionDefinition } from '../../tools/definitions';

/** Read-only verification tools the goal evaluator may invoke. */
export const GOAL_EVAL_TOOL_ALLOWLIST = [
  'read_file',
  'read_file_range',
  'list_directory',
  'find_files',
  'get_file_metadata',
  'search_in_file',
  'execute_command',
  'git_status',
  'git_diff',
  'git_log',
  'browser_list',
  'browser_navigate',
  'browser_snapshot',
  'browser_click',
  'browser_fill',
  'browser_eval',
  'browser_screenshot',
  'browser_new_tab',
  'browser_switch_tab',
] as const;

export type GoalEvalToolName = (typeof GOAL_EVAL_TOOL_ALLOWLIST)[number];

/** Cannot mark the goal achieved on the first evaluator pass after setting /goal. */
export const MIN_GOAL_TURNS_BEFORE_PASS = 2;

/** Max times to re-prompt when the evaluator omits a YES/NO verdict line. */
export const MAX_GOAL_EVAL_VERDICT_RETRIES = 3;

/** Tool rounds per evaluation pass before tools are withdrawn and a verdict is required. */
export const MAX_GOAL_EVAL_TOOL_ROUNDS = 30;

/** Minimum independent verification tool calls before YES can stand. */
export const MIN_GOAL_EVAL_VERIFICATION_TOOL_CALLS = 4;

const allowlistSet = new Set<string>(GOAL_EVAL_TOOL_ALLOWLIST);

/** True when the tool name is part of the goal-eval verification allowlist. */
export function isGoalEvalVerificationTool(name: string): boolean {
  return allowlistSet.has(name);
}

export function getGoalEvalToolDefinitions(): OpenAIFunctionDefinition[] {
  return getEnabledToolDefinitions().filter((def) =>
    allowlistSet.has(def.function.name),
  );
}
