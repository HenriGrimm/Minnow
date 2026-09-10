import {
  buildClientStats,
  reconcileCompletionStats,
  type StreamMetaAccumulator,
} from '../api/chat';
import { resolveModelInfo } from '../api/models';
import { averageStatsSegments } from '../chat/plans/stats-math';
import { estimateTokensFromText } from './prompts/token-estimate-core';
import { getActiveChat, markChatDirty } from '../state/sessions';
import { buildLastStatsSnapshot, updateStrip } from '../ui/stats';
import { resolveLastTurnMetrics } from '../usage/chat-turn-metrics';
import type { Chat, LastStats, ModelInfo, Stats, Usage } from '../types';

/** Throttle DOM refresh so fast models do not repaint the strip every chunk. */
export const LIVE_STREAM_STATS_THROTTLE_MS = 100;

export interface StreamingStatsSnapshot {
  streamMeta: StreamMetaAccumulator;
  t0: number;
  tFirst: number | null;
  partialText: string;
  partialThinkingLength?: number;
  /** Completed stats + usage from earlier tool-loop rounds (weighted live tok/s). */
  priorStatsSegments?: Array<{ stats: Stats; usage: Usage }>;
  modelId?: string;
  modelInfo?: ModelInfo;
}

function hasLiveCompletionUsage(usage: Usage | undefined): boolean {
  if (!usage) return false;
  return (
    usage.completion_tokens != null &&
    Number.isFinite(usage.completion_tokens) &&
    usage.completion_tokens > 0
  );
}

/** Usage for the in-flight API round only (no prior tool-loop rollup). */
export function buildCurrentRoundUsage(
  input: StreamingStatsSnapshot,
  _now = performance.now(),
): Usage {
  const { streamMeta, partialText, priorStatsSegments } = input;
  const roundEstimate = estimateTokensFromText(partialText);
  const live = streamMeta.usage;

  if (hasLiveCompletionUsage(live)) {
    return { ...live! };
  }

  const out: Usage = {};
  if (live?.prompt_tokens != null && Number.isFinite(live.prompt_tokens)) {
    out.prompt_tokens = live.prompt_tokens;
  }
  if (roundEstimate > 0) {
    out.completion_tokens = roundEstimate;
  }
  if (out.prompt_tokens != null || out.completion_tokens != null) {
    out.total_tokens = (out.prompt_tokens ?? 0) + (out.completion_tokens ?? 0);
    return out;
  }

  // `round_end` flushes an empty accumulator before the next round opens. Hold
  // the round that just finished instead of blanking the strip and the ring
  // between every tool call.
  const justFinished = priorStatsSegments?.[priorStatsSegments.length - 1]?.usage;
  return justFinished ? { ...justFinished } : out;
}

/** Timing stats (TTFT, generation time, tok/s) for a stream still in flight. */
export function buildLiveStreamStats(
  input: StreamingStatsSnapshot,
  now = performance.now(),
): Stats {
  const { streamMeta, t0, tFirst, priorStatsSegments } = input;
  const roundUsage = buildCurrentRoundUsage(input, now);
  const clientStats = buildClientStats(t0, tFirst, now, roundUsage, undefined);
  const serverStats = streamMeta.stats ?? {};
  const roundStats = reconcileCompletionStats(clientStats, serverStats, roundUsage);

  const priorList = priorStatsSegments ?? [];
  if (!priorList.length) return roundStats;

  return averageStatsSegments([...priorList, { stats: roundStats, usage: roundUsage }]);
}

/**
 * Combined live stats + usage for the metrics strip.
 *
 * Rates average across the turn's rounds; token counts stay on the current round
 * so the strip, the last assistant chip, and the context ring agree.
 */
export function buildLiveStreamMeta(
  input: StreamingStatsSnapshot,
  now = performance.now(),
): { stats: Stats; usage: Usage } {
  const usage = buildCurrentRoundUsage(input, now);
  const stats = buildLiveStreamStats(input, now);
  return { stats, usage };
}

/**
 * Turn-end meta for the metrics strip and `chat.lastStats`.
 *
 * Same split as the live path: rates average across every round of the tool
 * loop, token counts stay on the final round. Summing completions across rounds
 * would double-count — each round's reply is already inside the next round's
 * prompt — and that rollup is what used to make the ring disagree with the
 * strip and with the last assistant chip.
 */
export function buildTurnDisplayMeta(
  turnStatsSegments: Array<{ stats: Stats; usage: Usage }>,
  lastRound: { stats: Stats; usage: Usage } | null,
): { stats: Stats; usage: Usage } | null {
  if (turnStatsSegments.length === 0) return lastRound;
  return {
    stats: averageStatsSegments(turnStatsSegments),
    usage: lastRound?.usage ?? turnStatsSegments[turnStatsSegments.length - 1].usage,
  };
}

export interface StreamingStatsPublisher {
  schedule: (input: StreamingStatsSnapshot) => void;
  flush: (input: StreamingStatsSnapshot) => void;
  reset: () => void;
}

/** Completion-only stream updates cannot replace a whole-context count. */
export function buildLiveLastStats(
  meta: { stats: Stats; usage: Usage },
  previous: LastStats | null,
): LastStats {
  const snapshot = buildLastStatsSnapshot(meta.stats, meta.usage);
  const hasPrompt = snapshot.prompt_tokens != null;
  const hasWholeTotal = snapshot.total_tokens != null &&
    snapshot.total_tokens > (snapshot.completion_tokens ?? 0);
  if (!hasPrompt && !hasWholeTotal) {
    snapshot.prompt_tokens = previous?.prompt_tokens ?? null;
    snapshot.completion_tokens = previous?.completion_tokens ?? null;
    snapshot.total_tokens = previous?.total_tokens ?? null;
  }
  return snapshot;
}

/** Throttled updater for chat.lastStats and the bottom metrics strip. */
export function createStreamingStatsPublisher(chat: Chat): StreamingStatsPublisher {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: StreamingStatsSnapshot | null = null;

  function apply(input: StreamingStatsSnapshot): void {
    const meta = buildLiveStreamMeta(input);
    chat.lastStats = buildLiveLastStats(meta, resolveLastTurnMetrics(chat));
    // lastStats is persisted session state; mark dirty so PATCH tracking sees it (MIN-584).
    // Not touchChat: this fires every 100 ms, and restamping updatedAt reorders the sidebar,
    // whose insertBefore move restarts the row's CSS animations (MIN-793).
    markChatDirty(chat);

    if (getActiveChat().id !== chat.id) return;

    const modelId = input.modelId ?? chat.modelId ?? '';
    const modelInfo = resolveModelInfo(modelId, input.modelInfo ?? chat.modelInfo ?? {});
    updateStrip(meta.stats, meta.usage, modelInfo);
  }

  function schedule(input: StreamingStatsSnapshot): void {
    pending = input;
    if (timer != null) return;
    timer = setTimeout(() => {
      timer = null;
      if (pending) apply(pending);
    }, LIVE_STREAM_STATS_THROTTLE_MS);
  }

  function flush(input: StreamingStatsSnapshot): void {
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
    pending = null;
    apply(input);
  }

  function reset(): void {
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
    pending = null;
  }

  return { schedule, flush, reset };
}
