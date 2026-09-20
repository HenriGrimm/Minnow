import type { StreamMetaAccumulator } from '../api/chat';
import type { TurnEvent } from '../../server/runner/run-turn';
import type { LlamaPromptProgress, LlamaTimings, Stats, Usage } from '../types';
import {
  generatedTokensView,
  llamaRuntimeStatusView,
  type LlamaRuntimeStatusView,
} from './llama-runtime-status';

export type StreamMetaTurnEvent = Extract<TurnEvent, { type: 'stream_meta' }>;
export type RoundEndTurnEvent = Extract<TurnEvent, { type: 'round_end' }>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Narrow runner `usage` blobs onto the chat `Usage` shape. */
export function usageFromTurnEvent(value: unknown): Usage | undefined {
  if (!isPlainObject(value)) return undefined;
  return value as Usage;
}

/** Narrow runner `stats` blobs onto the chat `Stats` shape. */
export function statsFromTurnEvent(value: unknown): Stats | undefined {
  if (!isPlainObject(value)) return undefined;
  return value as Stats;
}

export function llamaRuntimeFromStreamMetaRuntime(
  runtime: unknown,
): { timings?: LlamaTimings; prompt_progress?: LlamaPromptProgress } | undefined {
  if (!isPlainObject(runtime)) return undefined;
  const timings = runtime.timings;
  const promptProgress = runtime.prompt_progress;
  const out: { timings?: LlamaTimings; prompt_progress?: LlamaPromptProgress } = {};
  if (isPlainObject(timings)) out.timings = timings as LlamaTimings;
  if (isPlainObject(promptProgress)) {
    out.prompt_progress = promptProgress as unknown as LlamaPromptProgress;
  }
  if (!out.timings && !out.prompt_progress) return undefined;
  return out;
}

export function runtimeStatusFromStreamMetaRuntime(
  runtime: unknown,
  hasOutput: boolean,
): LlamaRuntimeStatusView {
  const view = llamaRuntimeStatusView(llamaRuntimeFromStreamMetaRuntime(runtime), hasOutput);
  if (view.phase || !isPlainObject(runtime)) return view;
  // Hosted providers send no llama timings; the runner estimates output tokens
  // (prose, reasoning and tool-call args) so the live row still counts up.
  const estimate = Number(runtime.output_tokens_estimate);
  return Number.isFinite(estimate) && estimate > 0 ? generatedTokensView(estimate) : view;
}

export function applyStreamMetaEvent(
  acc: StreamMetaAccumulator,
  event: StreamMetaTurnEvent,
): StreamMetaAccumulator {
  const next: StreamMetaAccumulator = { ...acc };
  const usage = usageFromTurnEvent(event.usage);
  if (usage) next.usage = { ...next.usage, ...usage };
  const stats = statsFromTurnEvent(event.stats);
  if (stats) next.stats = { ...next.stats, ...stats };
  if (typeof event.model === 'string' && event.model.trim()) {
    next.model = event.model.trim();
  }
  if (typeof event.finishReason === 'string' && event.finishReason) {
    next.finish_reason = event.finishReason;
  }
  const runtime = llamaRuntimeFromStreamMetaRuntime(event.runtime);
  if (runtime?.timings) next.timings = { ...next.timings, ...runtime.timings };
  if (runtime?.prompt_progress) next.prompt_progress = runtime.prompt_progress;
  return next;
}

export function streamMetaFromRoundEnd(
  live: StreamMetaAccumulator,
  event: RoundEndTurnEvent,
): StreamMetaAccumulator {
  const usage = usageFromTurnEvent(event.usage);
  const stats = statsFromTurnEvent(event.stats);
  // Reasoning text on the round means those tokens decoded inside the measured
  // window; without it, `completion_tokens` counts thinking that never streamed.
  const streamedReasoning =
    live.streamed_reasoning === true ||
    (typeof event.reasoning === 'string' && event.reasoning.trim().length > 0);
  return {
    ...live,
    ...(usage ? { usage: { ...live.usage, ...usage } } : {}),
    ...(stats ? { stats: { ...live.stats, ...stats } } : {}),
    ...(event.finishReason ? { finish_reason: event.finishReason } : {}),
    ...(streamedReasoning ? { streamed_reasoning: true } : {}),
  };
}
