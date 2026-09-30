import type { BoardState } from '../../server/orchestrator/core/types';
import type { Stats, Usage } from '../types';

export interface RoundMetrics {
  usage?: Record<string, unknown>;
  stats?: Record<string, unknown>;
  tFirst?: number | null;
  tEnd?: number | null;
}

export type LiveRoundMetrics = ReadonlyMap<string, ReadonlyMap<number, RoundMetrics>>;

export interface BoardUsage {
  stats: Stats;
  usage: Usage;
  active: number;
  measured: number;
}

function finiteCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Output speed uses the model round's generation window, never tool or queue time. */
export function roundSpeed(round: RoundMetrics): { tokens: number; seconds: number } | null {
  const tps = finiteCount(round.stats?.tokens_per_second);
  const generationSeconds = finiteCount(round.stats?.generation_time);
  if (tps !== null && generationSeconds !== null && generationSeconds > 0) {
    return { tokens: tps * generationSeconds, seconds: generationSeconds };
  }
  const completion = finiteCount(round.usage?.completion_tokens);
  if (tps !== null && tps > 0 && completion !== null && completion > 0) {
    return { tokens: completion, seconds: completion / tps };
  }
  const details = round.usage?.completion_tokens_details;
  const reasoning = details && typeof details === 'object'
    ? finiteCount((details as Record<string, unknown>).reasoning_tokens) : null;
  if (reasoning !== null && reasoning > 0) return null;
  const first = finiteCount(round.tFirst);
  const end = finiteCount(round.tEnd);
  if (completion !== null && completion > 0 && first !== null && end !== null && end > first) {
    return { tokens: completion, seconds: (end - first) / 1000 };
  }
  return null;
}

/** Roll up provider token counts from completed attempts and live model rounds. */
export function boardUsage(state: BoardState, liveRounds?: LiveRoundMetrics): BoardUsage {
  let prompt = 0;
  let completion = 0;
  let total = 0;
  let hasPrompt = false;
  let hasCompletion = false;
  let hasTotal = false;
  let completePrompt = true;
  let completeCompletion = true;
  let completeTotal = true;
  let measured = 0;
  let active = 0;
  let speedTokens = 0;
  let speedSeconds = 0;

  const addUsage = (usage: Record<string, unknown> | undefined): void => {
    if (!usage) return;
    const p = finiteCount(usage.prompt_tokens);
    const c = finiteCount(usage.completion_tokens);
    const t = finiteCount(usage.total_tokens);
    if (p === null && c === null && t === null) return;
    measured += 1;
    if (p === null) completePrompt = false;
    if (c === null) completeCompletion = false;
    if (t === null && (p === null || c === null)) completeTotal = false;
    if (p !== null) { prompt += p; hasPrompt = true; }
    if (c !== null) { completion += c; hasCompletion = true; }
    if (t !== null) { total += t; hasTotal = true; }
    else if (p !== null && c !== null) { total += p + c; hasTotal = true; }
  };
  const addSpeed = (speed: { tokens: number; seconds: number } | null | undefined): void => {
    if (!speed || !Number.isFinite(speed.tokens) || !Number.isFinite(speed.seconds) || speed.seconds <= 0) return;
    speedTokens += speed.tokens;
    speedSeconds += speed.seconds;
  };

  for (const task of state.tasks.values()) {
    for (const attempt of task.attempts) {
      if (attempt.role === 'merge') continue;
      if (attempt.ended) {
        addUsage(attempt.usage);
        addSpeed(attempt.speed);
        continue;
      }
      active += 1;
      for (const round of liveRounds?.get(attempt.attemptId)?.values() ?? []) {
        addUsage(round.usage);
        addSpeed(roundSpeed(round));
      }
    }
  }
  const usage: Usage = {};
  if (hasPrompt && completePrompt) usage.prompt_tokens = prompt;
  if (hasCompletion && completeCompletion) usage.completion_tokens = completion;
  if (hasTotal && completeTotal) usage.total_tokens = total;
  return {
    stats: speedSeconds > 0 ? { tokens_per_second: speedTokens / speedSeconds } : {},
    usage,
    active,
    measured,
  };
}
