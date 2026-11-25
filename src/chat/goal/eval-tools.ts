import { getEnabledToolDefinitions } from '../../tools/client';
import type { OpenAIFunctionDefinition } from '../../tools/definitions';

import { isGoalEvalVerificationTool } from './verification-tools';
export { GOAL_EVAL_TOOL_ALLOWLIST, isGoalEvalVerificationTool, type GoalEvalToolName } from './verification-tools';

/** Cannot mark the goal achieved on the first evaluator pass after setting /goal. */
export const MIN_GOAL_TURNS_BEFORE_PASS = 2;

/** Max times to re-prompt when the evaluator omits a YES/NO verdict line. */
export const MAX_GOAL_EVAL_VERDICT_RETRIES = 3;

/** Tool rounds per evaluation pass before tools are withdrawn and a verdict is required. */
export const MAX_GOAL_EVAL_TOOL_ROUNDS = 30;

/** Minimum independent verification tool calls before YES can stand. */
export const MIN_GOAL_EVAL_VERIFICATION_TOOL_CALLS = 4;

export function getGoalEvalToolDefinitions(): OpenAIFunctionDefinition[] {
  return getEnabledToolDefinitions().filter((def) =>
    isGoalEvalVerificationTool(def.function.name),
  );
}
