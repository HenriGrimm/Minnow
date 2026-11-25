/** Tools for independent verification in renderer and server goal evaluations. */
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

const allowlistSet = new Set<string>(GOAL_EVAL_TOOL_ALLOWLIST);

/** True when the tool name is part of the goal-eval verification allowlist. */
export function isGoalEvalVerificationTool(name: string): boolean {
  return allowlistSet.has(name);
}
