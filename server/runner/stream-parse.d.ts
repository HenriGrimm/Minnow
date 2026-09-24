import type {
  ChatCompletionChunk,
  LlamaTimings,
  Stats,
  ToolCall,
  ToolCallAccumulator,
} from '../../src/types';

export interface StreamMetaAccumulator {
  stats?: Stats;
  usage?: import('../../src/types').Usage;
  model_info?: import('../../src/types').ModelInfo;
  model?: string;
  finish_reason?: string;
  error?: string;
  timings?: LlamaTimings;
  prompt_progress?: import('../../src/types').LlamaPromptProgress;
  /** Set once reasoning text has streamed, so its tokens count toward tok/s. */
  streamed_reasoning?: boolean;
}

export function extractStreamErrorMessage(chunk: ChatCompletionChunk): string | undefined;
export function extractStreamDelta(chunk: ChatCompletionChunk): string;
export function mergeToolCallDelta(
  acc: ToolCallAccumulator,
  chunk: ChatCompletionChunk,
): ToolCallAccumulator;
export function finalizeToolCalls(acc: ToolCallAccumulator): ToolCall[];
export function extractMessageText(
  message: { content?: string | unknown } | null | undefined,
): string;
export function extractAssistantCompletionText(
  message:
    | {
        content?: string | unknown;
        parsed?: unknown;
        refusal?: string;
      }
    | null
    | undefined,
): string;
export function statsFromLlamaTimings(timings: LlamaTimings | undefined): Stats | null;
/** Fill missing usage fields from llama.cpp `prompt_n` / `predicted_n`. */
export function fillUsageFromLlamaTimings(
  usage: import('../../src/types').Usage | undefined,
  timings: LlamaTimings | undefined,
): import('../../src/types').Usage;
export function mergeStreamMeta(
  acc: StreamMetaAccumulator | null | undefined,
  chunk: ChatCompletionChunk,
): StreamMetaAccumulator;
