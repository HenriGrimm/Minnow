import type { LlamaPromptProgress, LlamaTimings } from '../types';

export interface LlamaRuntimeStatusView {
  /** Which stream phase this implies, or null when it implies nothing. */
  phase: 'prompt_processing' | 'generating' | null;
  /** Text for the status row. Empty when there is nothing worth saying. */
  detail: string;
}

const EMPTY: LlamaRuntimeStatusView = { phase: null, detail: '' };

/**
 * @param meta Latest merged stream meta.
 * @param hasOutput True once any prose or reasoning token has been shown — after that
 *   prefill is over regardless of what the last chunk said.
 */
export function llamaRuntimeStatusView(
  meta: { timings?: LlamaTimings; prompt_progress?: LlamaPromptProgress } | null | undefined,
  hasOutput: boolean,
): LlamaRuntimeStatusView {
  if (!meta) return EMPTY;

  const progress = meta.prompt_progress;
  if (!hasOutput && progress && progress.total > 0 && progress.processed < progress.total) {
    if (progress.cache > 0 && progress.cache >= progress.processed) {
      return {
        phase: 'prompt_processing',
        detail: `${progress.cache.toLocaleString()} of ${progress.total.toLocaleString()} cached`,
      };
    }
    const percent = Math.min(99, Math.floor((progress.processed / progress.total) * 100));
    return { phase: 'prompt_processing', detail: `${percent}%` };
  }

  const predicted = Number(meta.timings?.predicted_n);
  if (Number.isFinite(predicted) && predicted > 0) {
    return generatedTokensView(predicted);
  }

  return EMPTY;
}

/** "N tokens" generating status — llama `predicted_n` or the runner's estimate. */
export function generatedTokensView(count: number): LlamaRuntimeStatusView {
  return {
    phase: 'generating',
    detail: count === 1 ? '1 token' : `${count.toLocaleString()} tokens`,
  };
}
