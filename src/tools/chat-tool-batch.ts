import { patchMainTurnActivity } from '../chat/main-turn-activity.ts';
import { notifyChatStreamActivity } from '../chat/streaming-state.ts';
import { normalizeModeId } from '../chat/modes/types.ts';
import {
  recordChatMessage,
  scheduleSaveSessions,
  sessionState,
} from '../state/sessions.ts';
import { resolveChatToolWorkspaceRoot } from '../state/chat-worktree.ts';
import type { Chat, ToolCall, TurnRunId } from '../types.ts';
import { appendChatTranscriptNode, getActiveChatMountElement } from '../ui/chat-mount.ts';
import { scrollChatIfPinned } from '../ui/chat-scroll.ts';
import { attachShellKillUi } from '../ui/shell-run-ui.ts';
import type { ThoughtBubbleController } from '../ui/thought-bubbles.ts';
import { renderToolCall, renderToolResult } from '../ui/tool-messages.ts';
import { assertUiDesignerToolAllowed } from '../agents/ui-designer/tools.ts';
import type { UiDesignerMode } from '../agents/ui-designer/constants.ts';
import { setBugBoardExecutorContext } from './bug-board-tools.ts';
import { executeTool, type ExecuteToolContext } from './client.ts';
import {
  executeToolCallBatch,
  type ToolCallOutcome,
} from './execute-tool-batch.ts';
import { parallelToolsActivityLabel } from './parallel-tool-policy.ts';
import { parseToolArguments } from './parse-tool-arguments.ts';
import { setSubAgentExecutorContext } from './sub-agent-executor.ts';
import { findToolWrapInDom } from './tool-wrap-dom.ts';
import { scheduleRenderSidebar } from '../ui/sidebar.ts';
import { notifyMemorySavedFromTool } from '../ui/memory-saved-toast.ts';

export interface RunChatToolBatchOptions {
  chat: Chat;
  toolCalls: ToolCall[];
  signal: AbortSignal;
  constrained: boolean;
  paintInChat: boolean;
  parentTurnId: string;
  turnRunId?: TurnRunId;
  uiDesignerActive: boolean;
  uiDesignerMode: UiDesignerMode;
  livePartialText: string;
  thoughtController: ThoughtBubbleController | null;
  syncContextUsage: (pendingToolCallsJson?: string) => void;
  trackHistoryPush: () => void;
  /** Resume path: reuse existing `.tool-call-msg` rows when present. */
  ensureToolWrap?: (
    toolName: string,
    args: unknown,
    toolCallId: string,
  ) => HTMLElement;
}

// ── Context ──────────────────────────────────────────────────────────────────

function buildChatToolExecuteContext(
  chat: Chat,
  toolCallId: string,
  toolLoopModeId: ReturnType<typeof normalizeModeId>,
  signal: AbortSignal,
): ExecuteToolContext {
  const scopedWorkspaceRoot = resolveChatToolWorkspaceRoot(chat, sessionState?.groups);
  return {
    chatId: chat.id,
    toolCallId,
    modeId: toolLoopModeId,
    workAgentId: chat.workAgentId ?? null,
    signal,
    ...(scopedWorkspaceRoot ? { workspaceRoot: scopedWorkspaceRoot } : {}),
  };
}

export function resolveLiveToolWrap(toolCallId: string, captured: HTMLElement): HTMLElement {
  if (captured.isConnected) return captured;
  return findToolWrapInDom(toolCallId) ?? captured;
}

// ── Outcome ──────────────────────────────────────────────────────────────────

function applyToolOutcome(
  options: RunChatToolBatchOptions,
  outcome: ToolCallOutcome,
  toolWrap: HTMLElement,
  args: unknown,
): void {
  const { chat } = options;
  const tc = outcome.toolCall;
  const toolName = tc.function.name;
  const toolArgsRecord =
    args && typeof args === 'object' && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : undefined;

  if (outcome.parseError) {
    renderToolResult(toolWrap, outcome.parseError, undefined, args);
    chat.history.push({
      role: 'tool',
      tool_call_id: tc.id,
      content: outcome.parseError,
    });
    options.trackHistoryPush();
    options.syncContextUsage();
    recordChatMessage(chat);
    scheduleSaveSessions();
    return;
  }

  const toolOut = outcome.result ?? { content: '' };
  const toolContent = toolOut.content;

  renderToolResult(
    toolWrap,
    toolContent,
    toolOut.attachments,
    args,
    toolOut.codeChange,
  );
  attachShellKillUi(
    toolWrap,
    toolName,
    tc.id,
    toolArgsRecord,
    toolContent,
    chat.id,
  );

  chat.history.push({
    role: 'tool',
    tool_call_id: tc.id,
    content: toolContent,
    ...(toolOut.attachments?.length ? { attachments: toolOut.attachments } : {}),
    ...(toolOut.codeChange ? { codeChange: toolOut.codeChange } : {}),
  });
  notifyMemorySavedFromTool(toolName, args, toolContent);
  options.trackHistoryPush();
  options.syncContextUsage();

  if (toolWrap.isConnected) {
    scrollChatIfPinned();
  }
}

// ── Batch ────────────────────────────────────────────────────────────────────

/**
 * Pre-render tool rows, run the batch executor, append tool history, and refresh board chrome.
 */
export async function runChatToolBatch(
  options: RunChatToolBatchOptions,
): Promise<void> {
  const {
    chat,
    toolCalls,
    signal,
    constrained,
    paintInChat,
    parentTurnId,
    uiDesignerActive,
    uiDesignerMode,
  } = options;

  const toolLoopModeId = normalizeModeId(chat.modeId);
  const wrapById = new Map<string, HTMLElement>();
  const argsById = new Map<string, unknown>();
  const area = getActiveChatMountElement();

  patchMainTurnActivity(chat.id, { phase: 'tools' });
  notifyChatStreamActivity(chat.id);

  for (const tc of toolCalls) {
    const { args, parseError } = parseToolArguments(tc.function.arguments, { constrained });
    // Preserve rejected input for the failure row without passing it to execution.
    const presentationArgs = parseError ? tc.function.arguments : args;
    argsById.set(tc.id, presentationArgs);

    const toolWrap = options.ensureToolWrap
      ? options.ensureToolWrap(tc.function.name, presentationArgs, tc.id)
      : (() => {
          const wrap = renderToolCall(tc.function.name, presentationArgs);
          wrap.dataset.toolCallId = tc.id;
          return wrap;
        })();

    wrapById.set(tc.id, toolWrap);

    const toolArgsRecord =
      presentationArgs &&
      typeof presentationArgs === 'object' &&
      !Array.isArray(presentationArgs)
        ? (presentationArgs as Record<string, unknown>)
        : undefined;
    attachShellKillUi(
      toolWrap,
      tc.function.name,
      tc.id,
      toolArgsRecord,
      undefined,
      chat.id,
    );

    if (paintInChat && !options.ensureToolWrap) {
      appendChatTranscriptNode(toolWrap, area);
    }
  }

  if (paintInChat) {
    scrollChatIfPinned();
  }

  let parallelAggregateLabel: string | null = null;

  await executeToolCallBatch({
    toolCalls,
    constrained,
    signal,
    onParallelSegmentStart: (calls) => {
      if (calls.length > 1) {
        parallelAggregateLabel = parallelToolsActivityLabel(calls.length);
        patchMainTurnActivity(chat.id, {
          phase: 'tools',
          currentTool: parallelAggregateLabel,
        });
        notifyChatStreamActivity(chat.id);
      } else {
        parallelAggregateLabel = null;
      }
    },
    onToolStart: (tc) => {
      notifyChatStreamActivity(chat.id);
      if (!parallelAggregateLabel) {
        patchMainTurnActivity(chat.id, {
          phase: 'tools',
          currentTool: tc.function.name,
        });
      }
    },
    execute: async (toolName, args, ctx) => {
      const planBlock = uiDesignerActive
        ? assertUiDesignerToolAllowed(toolName, uiDesignerMode)
        : null;
      if (planBlock) {
        return { content: planBlock };
      }

      setSubAgentExecutorContext({
        parentTurnId,
        modeId: toolLoopModeId,
        parentChatId: chat.id,
        parentToolCallId: ctx.toolCallId,
      });
      setBugBoardExecutorContext({ chatId: chat.id });

      return executeTool(
        toolName,
        args as Record<string, unknown>,
        buildChatToolExecuteContext(chat, ctx.toolCallId, toolLoopModeId, signal),
      );
    },
    onToolDone: (outcome) => {
      const captured = wrapById.get(outcome.toolCall.id);
      if (!captured) {
        return;
      }
      const toolWrap = resolveLiveToolWrap(outcome.toolCall.id, captured);
      if (toolWrap !== captured) {
        wrapById.set(outcome.toolCall.id, toolWrap);
      }
      applyToolOutcome(options, outcome, toolWrap, argsById.get(outcome.toolCall.id));
    },
  });

  recordChatMessage(chat);
  scheduleSaveSessions();
  scheduleRenderSidebar();

  if (signal.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
}
