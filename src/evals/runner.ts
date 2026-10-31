/**
 * Isolated eval runner (headless tool loop, no parent chat history).
 */

import {
  extractMessageText,
  extractStreamDelta,
  finalizeToolCalls,
  mergeStreamMeta,
  mergeToolCallDelta,
  parseSsePayloads,
  tryNonStreamingFallback,
  type StreamMetaAccumulator,
} from '../api/chat';
import { postChatCompletions } from '../providers/fetch-chat';
import { getActiveProvider } from '../providers/store';
import { runHeadlessToolBatch } from '../tools/headless-tool-batch';
import { sumUsageSegments } from '../chat/plans/stats-math';
import type { ApiMessage, ChatCompletionChunk, ToolCallAccumulator, Usage } from '../types';
import type { OpenAIFunctionDefinition } from '../tools/definitions';
import type { EvalTask } from './types';

export interface EvalRunnerInput {
  task: EvalTask;
  systemPrompt: string;
  tools: OpenAIFunctionDefinition[];
  providerId: string;
  modelId: string;
  signal: AbortSignal;
  executeTool: (
    name: string,
    args: Record<string, unknown>,
    toolContext?: import('../tools/client').ExecuteToolContext,
  ) => Promise<import('../types').ToolExecutionResult>;
}

export interface EvalRunnerOutput {
  summary: string;
  toolTurns: number;
  messages: ApiMessage[];
  usage?: Usage;
  error?: string;
}

export interface EvalRunner {
  run(input: EvalRunnerInput): Promise<EvalRunnerOutput>;
}

interface EvalCompletionBody {
  model?: string;
  messages: ApiMessage[];
  temperature: number;
  max_tokens: number;
  stream?: boolean;
  tools?: OpenAIFunctionDefinition[];
  tool_choice?: 'auto';
}

async function streamEvalTurn(
  providerId: string,
  body: EvalCompletionBody,
  signal: AbortSignal,
): Promise<{
  fullText: string;
  finishReason: string | undefined;
  toolCalls: ReturnType<typeof finalizeToolCalls>;
  streamMeta: StreamMetaAccumulator;
}> {
  const provider = await getActiveProvider(providerId);
  const res = await postChatCompletions(provider, body, signal);

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`HTTP ${res.status}: ${err}`);
  }

  let fullText = '';
  let streamMeta: StreamMetaAccumulator = {};
  let toolAcc: ToolCallAccumulator = {};

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  function handleChunk(chunk: ChatCompletionChunk): void {
    streamMeta = mergeStreamMeta(streamMeta, chunk);
    toolAcc = mergeToolCallDelta(toolAcc, chunk);
    const delta = extractStreamDelta(chunk);
    if (delta) fullText += delta;
  }

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    parseSsePayloads(lines.join('\n'), handleChunk);
  }

  if (buffer.trim()) parseSsePayloads(buffer, handleChunk);

  const finishReason =
    streamMeta.finish_reason ||
    (Object.keys(toolAcc).length > 0 ? 'tool_calls' : undefined);

  return {
    fullText,
    finishReason,
    toolCalls: finalizeToolCalls(toolAcc),
    streamMeta,
  };
}

/** Default eval runner: SSE tool loop without structured outcome finalization. */
export const defaultEvalRunner: EvalRunner = {
  async run(input): Promise<EvalRunnerOutput> {
    const messages: ApiMessage[] = [
      { role: 'system', content: input.systemPrompt },
      { role: 'user', content: input.task.prompt },
    ];

    let toolTurns = 0;
    const usageSegments: Usage[] = [];

    for (let turn = 0; ; turn++) {
      if (input.task.toolFixtures && toolTurns > input.task.toolFixtures.steps.length + 1) return {
        summary: '', toolTurns, messages, error: 'Scripted eval tool-round budget exhausted',
      };
      const body: EvalCompletionBody = {
        model: input.modelId || undefined,
        messages,
        temperature: 0.4,
        max_tokens: 2048,
        stream: true,
      };

      if (input.tools.length > 0) {
        body.tools = input.tools;
        body.tool_choice = 'auto';
      }

      let turnResult: Awaited<ReturnType<typeof streamEvalTurn>>;
      try {
        turnResult = await streamEvalTurn(input.providerId, body, input.signal);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          summary: '',
          toolTurns,
          messages,
          error: message,
        };
      }

      const turnUsage = turnResult.streamMeta.usage ?? {};
      if (Object.keys(turnUsage).length > 0) usageSegments.push(turnUsage);

      if (
        turnResult.finishReason === 'tool_calls' &&
        turnResult.toolCalls.length > 0
      ) {
        toolTurns += 1;
        messages.push({
          role: 'assistant',
          content: turnResult.fullText || null,
          tool_calls: turnResult.toolCalls,
        });

        const outcomes = await runHeadlessToolBatch({
          toolCalls: turnResult.toolCalls,
          constrained: false,
          signal: input.signal,
          execute: (name, args, ctx) =>
            input.executeTool(name, args as Record<string, unknown>, {
              chatId: 'eval-run',
              subAgentType: 'eval',
              toolCallId: ctx.toolCallId,
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
        continue;
      }

      let prose = turnResult.fullText.trim();
      if (!prose) {
        const { stream: _stream, ...fallbackBody } = body;
        try {
          const fallback = await tryNonStreamingFallback(
            fallbackBody,
            input.signal,
            input.providerId,
          );
          prose = extractMessageText(fallback.choices?.[0]?.message).trim();
        } catch {}
      }

      if (prose) {
        messages.push({ role: 'assistant', content: prose });
      }

      return {
        summary: prose || '(empty response)',
        toolTurns,
        messages,
        usage: usageSegments.length ? sumUsageSegments(usageSegments) : undefined,
      };
    }
  },
};

let runnerFactory: () => EvalRunner = () => defaultEvalRunner;

export function setEvalRunnerFactory(factory: () => EvalRunner): void {
  runnerFactory = factory;
}

export function resetEvalRunnerFactory(): void {
  runnerFactory = () => defaultEvalRunner;
}

export function getEvalRunner(): EvalRunner {
  return runnerFactory();
}
