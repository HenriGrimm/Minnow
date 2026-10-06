/**
 * Build eval tool allowlist and executeTool wrapper for isolated runs.
 */

import { resolveSubAgentTools } from '../agents/sub-agent-tools';
import type { SubAgentTypeConfig } from '../agents/types';
import { getEnabledToolDefinitionsForMode } from '../tools/client';
import { executeTool } from '../tools/client';
import type { OpenAIFunctionDefinition } from '../tools/definitions';
import type { EvalConfig, EvalTask } from './types';
import type { ToolExecutionResult } from '../types';

/** Synthetic sub-agent config from task allow/deny lists. */
function taskToTypeConfig(task: EvalTask): SubAgentTypeConfig {
  return {
    enabled: true,
    providerId: '',
    modelId: '',
    maxConcurrent: 1,
    workAgentId: null,
    allowedTools: task.allowedTools.length > 0 ? task.allowedTools : null,
    deniedTools: task.deniedTools,
    systemPromptPath: null,
  };
}

/** Resolve OpenAI tool defs for an eval task (Build mode baseline). */
export function resolveEvalTaskTools(
  task: EvalTask,
  modeId = 'build',
): OpenAIFunctionDefinition[] {
  const parentEnabled = getEnabledToolDefinitionsForMode(modeId);
  const typeConfig = taskToTypeConfig(task);
  return resolveSubAgentTools(typeConfig, 'eval', parentEnabled);
}

/** Execute tool during eval with optional approval skip. */
export function createEvalExecuteTool(
  _config: EvalConfig,
  _workspacePath: string,
): (
  name: string,
  args: Record<string, unknown>,
  toolContext?: import('../tools/client').ExecuteToolContext,
) => Promise<ToolExecutionResult> {
  return async (name, args, toolContext) => {
    return executeTool(name, args, {
      ...toolContext,
      chatId: toolContext?.chatId ?? 'eval-run',
      subAgentType: 'eval',
      modeId: toolContext?.modeId ?? 'build',
    });
  };
}
