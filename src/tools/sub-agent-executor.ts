import {
  assertSubAgentRunReadableByParent,
  buildSubAgentStatusPayload,
  cancelSubAgent,
  formatAggregateResult,
  formatSubAgentListToolResultForChat,
  spawnSubAgent,
} from '../agents/orchestrator';
import { resolveSubAgentRunForParentSession } from '../agents/sub-agent-completion-push';
import { findChatById } from '../state/sessions';
import type { BoardCategory } from '../types';
import { getSubAgentExecutorContext } from './sub-agent-executor-context';
import type { ExecuteToolContext } from './client';
import { validateModelSelection } from '../../server/chats/contracts.js';

export {
  getSubAgentExecutorContext,
  setSubAgentExecutorContext,
} from './sub-agent-executor-context';

const BOARD_CATEGORIES = new Set<BoardCategory>(['build', 'fix', 'test', 'research']);

export async function executeSubAgentTool(
  name: string,
  args: Record<string, unknown>,
  context: ExecuteToolContext = {},
): Promise<string> {
  if (name === 'spawn_sub_agent') {
    const type = typeof args.type === 'string' ? args.type.trim() : '';
    const task = typeof args.task === 'string' ? args.task.trim() : '';
    const wait = args.wait === true;

    if (!type) return 'Error: spawn_sub_agent requires "type"';
    if (!task) return 'Error: spawn_sub_agent requires "task"';

    const categoryRaw = typeof args.category === 'string' ? args.category.trim() : '';
    const category = BOARD_CATEGORIES.has(categoryRaw as BoardCategory)
      ? (categoryRaw as BoardCategory)
      : undefined;
    const boardTaskId =
      typeof args.board_task_id === 'string'
        ? args.board_task_id.trim()
        : typeof args.boardTaskId === 'string'
          ? args.boardTaskId.trim()
          : undefined;

    try {
      const storedParent = getSubAgentExecutorContext();
      const parent = context.chatId && storedParent?.parentChatId !== context.chatId ? null : storedParent;
      const target = args.target === undefined ? null : validateModelSelection(args.target);
      if (target && !target.ok) return `Error: ${target.error.message}`;
      const result = await spawnSubAgent({
        type,
        task,
        wait,
        parentTurnId: parent?.parentTurnId ?? null,
        parentChatId: context.chatId ?? parent?.parentChatId ?? null,
        parentToolCallId: context.toolCallId ?? parent?.parentToolCallId ?? null,
        modeId: context.modeId ?? parent?.modeId,
        ...(context.signal ? { signal: context.signal } : {}),
        ...(typeof args.title === 'string' ? { title: args.title } : {}),
        ...(target?.ok ? { target: target.value } : {}),
        ...(typeof args.client_request_id === 'string' ? { clientRequestId: args.client_request_id } : {}),
        ...(typeof args.workspace_strategy === 'string' ? { workspaceStrategy: args.workspace_strategy as 'shared' | 'new_worktree' | 'existing_worktree' } : {}),
        ...(typeof args.workspace_id === 'string' ? { workspaceId: args.workspace_id } : {}),
        ...(category ? { category } : {}),
        ...(boardTaskId ? { boardTaskId } : {}),
      });

      if ('summary' in result && 'toolTurns' in result) {
        return formatAggregateResult(result);
      }

      return JSON.stringify(result, null, 2);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return message.startsWith('Error:') ? message : `Error: ${message}`;
    }
  }

  if (name === 'cancel_sub_agent') {
    const runId =
      typeof args.run_id === 'string'
        ? args.run_id.trim()
        : typeof args.runId === 'string'
          ? args.runId.trim()
          : '';
    const reason =
      typeof args.reason === 'string' && args.reason.trim()
        ? args.reason.trim()
        : 'cancelled';

    if (!runId) return 'Error: cancel_sub_agent requires "run_id"';

    const result = cancelSubAgent(runId, reason);
    return JSON.stringify(result, null, 2);
  }

  if (name === 'list_sub_agents') {
    const parentChatId = context.chatId ?? getSubAgentExecutorContext()?.parentChatId?.trim();
    if (!parentChatId) {
      return 'Error: list_sub_agents requires an active parent chat';
    }
    const chat = findChatById(parentChatId);
    return formatSubAgentListToolResultForChat(parentChatId, chat?.subAgentRuns);
  }

  if (name === 'get_sub_agent_status') {
    const storedParent = getSubAgentExecutorContext();
    const parent = context.chatId && storedParent?.parentChatId !== context.chatId ? null : storedParent;
    const parentChatId = context.chatId ?? parent?.parentChatId?.trim();
    if (!parentChatId) {
      return 'Error: get_sub_agent_status requires an active parent chat';
    }
    const runId =
      typeof args.run_id === 'string'
        ? args.run_id.trim()
        : typeof args.runId === 'string'
          ? args.runId.trim()
          : '';
    if (!runId) return 'Error: get_sub_agent_status requires "run_id"';

    try {
      const run = assertSubAgentRunReadableByParent(
        resolveSubAgentRunForParentSession(runId, parentChatId),
        { parentChatId, parentTurnId: parent?.parentTurnId },
      );
      return JSON.stringify(buildSubAgentStatusPayload(run), null, 2);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return message.startsWith('Error:') ? message : `Error: ${message}`;
    }
  }

  return `Error: unknown sub-agent tool "${name}"`;
}
