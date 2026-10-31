import type { LlamaTimings, ModelInfo, Stats, Usage } from '../../src/types';

export interface ResponseMetaAccumulator {
  stats?: Stats;
  usage?: Usage;
  model_info?: ModelInfo;
  timings?: LlamaTimings;
  finish_reason?: string;
  streamed_reasoning?: boolean;
}

export function normalizeUsageTotals(usage: Usage): Usage;
export function statsFromLlamaTimings(timings: LlamaTimings | undefined): Stats | null;
export function fillUsageFromLlamaTimings(usage: Usage | undefined, timings: LlamaTimings | undefined): Usage;
export const MAX_PLAUSIBLE_TOKENS_PER_SECOND: number;
export function decodeWindowCompletionTokens(usage: Usage | undefined, streamedReasoning?: boolean): number | null;
export function plausibleTokensPerSecond(tps: number | null | undefined): number | null;
export function resolveDecodeSeconds(t0: number, tFirst: number | null, tEnd: number, completionTokens: number | null | undefined, window?: 'decode' | 'request'): { ttft: number; genTime: number } | null;
export function buildClientStats(t0: number, tFirst: number | null, tEnd: number, usage: Usage | undefined, finishReason: string | undefined, streamedReasoning?: boolean, window?: 'decode' | 'request'): Stats;
export function reconcileCompletionStats(clientStats: Stats, serverStats: Stats, usage: Usage | undefined, streamedReasoning?: boolean): Stats;
export function finalizeResponseMeta(meta: ResponseMetaAccumulator, t0: number, tFirst: number | null, tEnd: number): { stats: Stats; usage: Usage; model_info: ModelInfo };
