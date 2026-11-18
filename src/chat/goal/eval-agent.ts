import { formatGenerationErrorMessage } from '../../api/generations';
import { loadGoalEvalConfig } from '../../config/goal-eval-meta';
import { sessionState } from '../../state/sessions';
import { resolveChatToolWorkspaceRoot } from '../../state/chat-worktree';
import type { ApiMessage, Chat, ToolCall } from '../../types';
import { ensureToolConfigReady } from '../../tools/config';
import { executeTool } from '../../tools/client';
import { runHeadlessToolBatch } from '../../tools/headless-tool-batch';
import type { ChatCompletionBody } from '../../api/chat';
import { extractGoalEvalCompletionText } from './completion-text';
import {
  getGoalEvalToolDefinitions,
  isGoalEvalVerificationTool,
  MAX_GOAL_EVAL_TOOL_ROUNDS,
  MAX_GOAL_EVAL_VERDICT_RETRIES,
} from './eval-tools';
import { buildGoalEvalMessages, GOAL_EVAL_VERDICT_NUDGE } from './prompt';
import { isGoalEvalVerdictResponse } from './parse-response';
import { createGoalEvalProviderPort } from './provider-port';
import { patchGoalEvalSession } from './eval-session';

export interface GoalEvalAgentResult {
  raw: string;
  verificationToolCalls: number;
  /** The evaluator could not produce a verdict (model/config/provider failure), not a NO. */
  failed?: true;
}

let goalEvalPortFactory: typeof createGoalEvalProviderPort = createGoalEvalProviderPort;

/** Replace evaluator port factory (unit tests). */
export function setGoalEvalPortFactoryForTests(
  factory: typeof createGoalEvalProviderPort | null,
): void {
  goalEvalPortFactory = factory ?? createGoalEvalProviderPort;
}

let goalEvalAgentImpl: typeof runGoalEvalAgentInner = runGoalEvalAgentInner;

/** Replace the full agentic evaluator (unit tests). */
export function setGoalEvalAgentImplForTests(
  impl: typeof runGoalEvalAgentInner | null,
): void {
  goalEvalAgentImpl = impl ?? runGoalEvalAgentInner;
}

async function completeGoalEvalWithRetry(
  port: ReturnType<typeof createGoalEvalProviderPort>,
  body: ChatCompletionBody,
  signal: AbortSignal,
) {
  try {
    return await port.complete(body, signal);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const transientFetch = err instanceof TypeError && message.includes('Failed to fetch');
    if (!transientFetch) {
      throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    return port.complete(body, signal);
  }
}

function countVerificationToolCalls(toolCalls: ToolCall[]): number {
  return toolCalls.filter((tc) => isGoalEvalVerificationTool(tc.function.name)).length;
}

/** Run the agentic verifier loop for one evaluation pass. */
export async function runGoalEvalAgent(
  chat: Chat,
  conditionText: string,
  signal: AbortSignal,
): Promise<GoalEvalAgentResult> {
  return goalEvalAgentImpl(chat, conditionText, signal);
}

async function runGoalEvalAgentInner(
  chat: Chat,
  conditionText: string,
  signal: AbortSignal,
): Promise<GoalEvalAgentResult> {
  const config = await loadGoalEvalConfig();
  const modelId = config.modelId.trim() || chat.modelId.trim();
  const messages: ApiMessage[] = buildGoalEvalMessages(chat, conditionText);

  if (!modelId) {
    const raw = 'NO: No model configured for goal evaluation.';
    patchGoalEvalSession(chat.id, {
      messages: [...messages, { role: 'assistant', content: raw }],
      rawVerdict: raw,
      liveCurrentToolName: undefined,
    });
    return {
      raw,
      verificationToolCalls: 0,
      failed: true,
    };
  }

  await ensureToolConfigReady();

  const providerId = config.providerId.trim() || chat.providerId?.trim() || undefined;
  const port = goalEvalPortFactory(providerId);
  const tools = getGoalEvalToolDefinitions();
  const workspaceRoot =
    resolveChatToolWorkspaceRoot(chat, sessionState?.groups ?? undefined) ?? undefined;

  let verificationToolCalls = 0;
  let verdictRetries = 0;
  let toolRounds = 0;

  const syncSession = (liveCurrentToolName?: string): void => {
    patchGoalEvalSession(chat.id, {
      messages: [...messages],
      verificationToolCalls,
      liveCurrentToolName,
    });
  };

  syncSession();

  try {
    for (;;) {
      const toolsAllowed = tools.length > 0 && toolRounds < MAX_GOAL_EVAL_TOOL_ROUNDS;
      const body: ChatCompletionBody = {
        model: modelId,
        messages,
        temperature: config.temperature,
        max_tokens: config.maxTokens,
        ...(toolsAllowed ? { tools, tool_choice: 'auto' as const } : {}),
      };

      const chunk = await completeGoalEvalWithRetry(port, body, signal);
      const message = chunk.choices?.[0]?.message;
      const toolCalls: ToolCall[] =
        message && Array.isArray((message as { tool_calls?: ToolCall[] }).tool_calls)
          ? ((message as { tool_calls?: ToolCall[] }).tool_calls ?? [])
          : [];

      if (toolCalls.length > 0 && toolsAllowed) {
        toolRounds += 1;
        verificationToolCalls += countVerificationToolCalls(toolCalls);
        messages.push({
          role: 'assistant',
          content: extractGoalEvalCompletionText(message) || null,
          tool_calls: toolCalls,
        });
        syncSession(toolCalls[0]?.function.name);

        const outcomes = await runHeadlessToolBatch({
          toolCalls,
          signal,
          execute: (name, args, ctx) =>
            executeTool(name, args as Record<string, unknown>, {
              chatId: chat.id,
              toolCallId: ctx.toolCallId,
              modeId: chat.modeId,
              workspaceRoot,
            }),
        });

        for (const outcome of outcomes) {
          const tc = outcome.toolCall;
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: outcome.parseError ?? outcome.result?.content ?? '',
          });
        }
        syncSession();
        if (toolRounds >= MAX_GOAL_EVAL_TOOL_ROUNDS) {
          messages.push({ role: 'user', content: GOAL_EVAL_VERDICT_NUDGE });
          syncSession();
        }
        continue;
      }

      const raw = extractGoalEvalCompletionText(message);
      const trimmed = raw.trim();
      if (trimmed) {
        if (!isGoalEvalVerdictResponse(trimmed)) {
          if (verdictRetries < MAX_GOAL_EVAL_VERDICT_RETRIES) {
            verdictRetries += 1;
            messages.push({ role: 'assistant', content: trimmed });
            messages.push({ role: 'user', content: GOAL_EVAL_VERDICT_NUDGE });
            syncSession();
            continue;
          }

          const fallback = `NO: Evaluator did not return a YES/NO verdict after ${MAX_GOAL_EVAL_VERDICT_RETRIES} attempts.`;
          patchGoalEvalSession(chat.id, {
            messages: [...messages, { role: 'assistant', content: fallback }],
            verificationToolCalls,
            liveCurrentToolName: undefined,
            rawVerdict: fallback,
          });
          return { raw: fallback, verificationToolCalls, failed: true };
        }

        patchGoalEvalSession(chat.id, {
          messages: [...messages, { role: 'assistant', content: trimmed }],
          verificationToolCalls,
          liveCurrentToolName: undefined,
          rawVerdict: trimmed,
        });
        return { raw: trimmed, verificationToolCalls };
      }

      return {
        raw: 'NO: Evaluator returned an empty response.',
        verificationToolCalls,
        failed: true,
      };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const raw = `NO: Goal evaluator failed: ${formatGenerationErrorMessage(message)}`;
    patchGoalEvalSession(chat.id, {
      messages: [...messages, { role: 'assistant', content: raw }],
      rawVerdict: raw,
      liveCurrentToolName: undefined,
      verificationToolCalls,
    });
    return {
      raw,
      verificationToolCalls,
      failed: true,
    };
  }
}
