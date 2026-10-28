/**
 * Single last-turn token/timing snapshot for every chat metrics surface.
 *
 * Provider usage is ground truth. Character estimates must not invent a second
 * “total tokens” number once a round has reported prompt/completion counts.
 */

import { normalizeUsageTotals } from './pricing.ts';
import type { Chat, LastStats, Message, Stats, Usage } from '../types.ts';

/** LastStats with every field explicitly null. */
export function emptyLastStats(): LastStats {
  return {
    tokens_per_second: null,
    time_to_first_token: null,
    generation_time: null,
    stop_reason: null,
    total_tokens: null,
    prompt_tokens: null,
    completion_tokens: null,
  };
}

function finiteOrNull(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) ? value : null;
}

/** True when the snapshot has anything the metrics strip / ring can paint. */
export function lastStatsHasMetrics(ls: LastStats | null | undefined): ls is LastStats {
  if (!ls) return false;
  return (
    ls.tokens_per_second != null ||
    ls.time_to_first_token != null ||
    ls.generation_time != null ||
    ls.total_tokens != null ||
    ls.prompt_tokens != null ||
    ls.completion_tokens != null ||
    (typeof ls.stop_reason === 'string' && ls.stop_reason.length > 0)
  );
}

/**
 * Usage object for strip/chip painters. Fills `total_tokens` from prompt+completion
 * only when the provider omitted it.
 */
export function lastStatsToUsage(ls: LastStats): Usage {
  const usage: Usage = {};
  if (ls.prompt_tokens != null) usage.prompt_tokens = ls.prompt_tokens;
  if (ls.completion_tokens != null) usage.completion_tokens = ls.completion_tokens;
  if (ls.total_tokens != null) usage.total_tokens = ls.total_tokens;
  return normalizeUsageTotals(usage);
}

/** Timing fields for strip/chip painters. */
export function lastStatsToStats(ls: LastStats): Stats {
  const stats: Stats = {};
  if (ls.tokens_per_second != null) stats.tokens_per_second = ls.tokens_per_second;
  if (ls.time_to_first_token != null) stats.time_to_first_token = ls.time_to_first_token;
  if (ls.generation_time != null) stats.generation_time = ls.generation_time;
  if (ls.stop_reason) stats.stop_reason = ls.stop_reason;
  return stats;
}

/**
 * Persistable snapshot from a round’s stats/usage.
 * Always derive `total_tokens` the same way chips do.
 */
export function buildLastStatsSnapshot(
  stats: Stats | undefined,
  usage: Usage | undefined,
): LastStats {
  const s = stats || {};
  const u = normalizeUsageTotals(usage || {});
  return {
    tokens_per_second: finiteOrNull(s.tokens_per_second),
    time_to_first_token: finiteOrNull(s.time_to_first_token),
    generation_time: finiteOrNull(s.generation_time),
    stop_reason: s.stop_reason != null ? s.stop_reason : null,
    total_tokens: finiteOrNull(u.total_tokens),
    prompt_tokens: finiteOrNull(u.prompt_tokens),
    completion_tokens: finiteOrNull(u.completion_tokens),
  };
}

/**
 * Prompt-only snapshots used to synthesize `total_tokens === prompt`.
 * Treat that total as missing so a richer history row can fill completion.
 */
function totalIsPromptOnlyPlaceholder(ls: LastStats): boolean {
  return (
    ls.completion_tokens == null &&
    ls.prompt_tokens != null &&
    ls.total_tokens === ls.prompt_tokens
  );
}

function promptsCompatible(a: number | null, b: number | null): boolean {
  if (a == null || b == null) return true;
  return a === b;
}

/**
 * Both snapshots priced the same API round.
 * Needs two real prompt sizes — a null prompt is "unknown", not "matching".
 */
function describesSameRound(a: LastStats, b: LastStats): boolean {
  return (
    a.prompt_tokens != null &&
    b.prompt_tokens != null &&
    a.prompt_tokens === b.prompt_tokens
  );
}

/**
 * Fill null fields from fallback when both snapshots describe the same request.
 * Different `prompt_tokens` means a different round — keep primary as-is.
 *
 * When both price the same round, the history row wins on token counts: it is
 * always one API round, whereas a snapshot persisted by an older build may be a
 * tool-loop rollup (latest prompt + summed completions) that over-reports the
 * context window. Timings still come from the stored snapshot, which averages
 * the whole turn.
 */
export function mergeLastStats(
  primary: LastStats | null | undefined,
  fallback: LastStats | null | undefined,
): LastStats | null {
  if (!primary && !fallback) return null;
  if (!primary) return fallback ? { ...fallback } : null;
  if (!fallback) return { ...primary };
  if (!promptsCompatible(primary.prompt_tokens, fallback.prompt_tokens)) {
    return { ...primary };
  }

  const primaryTotal = totalIsPromptOnlyPlaceholder(primary) ? null : primary.total_tokens;
  const roundTokensWin =
    describesSameRound(primary, fallback) && fallback.completion_tokens != null;

  return {
    tokens_per_second: primary.tokens_per_second ?? fallback.tokens_per_second,
    time_to_first_token: primary.time_to_first_token ?? fallback.time_to_first_token,
    generation_time: primary.generation_time ?? fallback.generation_time,
    stop_reason: primary.stop_reason ?? fallback.stop_reason,
    prompt_tokens: primary.prompt_tokens ?? fallback.prompt_tokens,
    completion_tokens: roundTokensWin
      ? fallback.completion_tokens
      : (primary.completion_tokens ?? fallback.completion_tokens),
    total_tokens: roundTokensWin
      ? (fallback.total_tokens ?? primaryTotal)
      : (primaryTotal ?? fallback.total_tokens),
  };
}

function isAssistantMetricsRow(
  msg: Message,
): msg is Message & { role: 'assistant'; stats?: Stats; usage?: Usage } {
  return msg.role === 'assistant' && (msg.stats != null || msg.usage != null);
}

/** Last assistant bubble that stored stats/usage (skips unloaded lazy history). */
export function lastStatsFromHistory(chat: Chat): LastStats | null {
  if (chat.historyLoaded === false) return null;
  const history = chat.history;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const msg = history[i];
    if (!msg || !isAssistantMetricsRow(msg)) continue;
    const snapshot = buildLastStatsSnapshot(msg.stats, msg.usage);
    if (lastStatsHasMetrics(snapshot)) return snapshot;
  }
  return null;
}

/**
 * Canonical last-turn metrics: stored `lastStats` plus the last assistant row
 * when the stored snapshot is missing completion/total/timing.
 */
export function resolveLastTurnMetrics(chat: Chat): LastStats | null {
  const merged = mergeLastStats(chat.lastStats, lastStatsFromHistory(chat));
  if (!merged) return null;
  const normalized = buildLastStatsSnapshot(lastStatsToStats(merged), lastStatsToUsage(merged));
  return lastStatsHasMetrics(normalized) ? normalized : null;
}

/** Context details show one provider request; ledger/history usage may aggregate
 * several native CLI requests across a tool handoff. Never infer a request from
 * such an aggregate when the CLI explicitly reports it as unavailable.
 */
export function resolveLastRequestMetrics(chat: Chat): LastStats | null {
  if (chat.historyLoaded !== false) {
    for (let i = chat.history.length - 1; i >= 0; i -= 1) {
      const row = chat.history[i];
      if (row.role !== 'assistant' || !row.usage) continue;
      if (row.usage.last_request_usage !== undefined) {
        return buildLastStatsSnapshot(row.stats, row.usage.last_request_usage ?? {});
      }
      // Preserve ordinary API hydration of partial snapshots from lastStats.
      return resolveLastTurnMetrics(chat);
    }
  }
  return resolveLastTurnMetrics(chat);
}

/** True when persisting `resolved` would fill fields `stored` is missing. */
export function lastStatsNeedsHydration(
  stored: LastStats | null | undefined,
  resolved: LastStats,
): boolean {
  if (!stored) return lastStatsHasMetrics(resolved);
  if (totalIsPromptOnlyPlaceholder(stored) && resolved.completion_tokens != null) return true;
  // A stale tool-loop rollup from an older build: same counts, different values.
  if (
    stored.completion_tokens != null &&
    resolved.completion_tokens != null &&
    stored.completion_tokens !== resolved.completion_tokens
  ) {
    return true;
  }
  if (
    stored.total_tokens != null &&
    resolved.total_tokens != null &&
    stored.total_tokens !== resolved.total_tokens
  ) {
    return true;
  }
  return (
    (stored.total_tokens == null && resolved.total_tokens != null) ||
    (stored.prompt_tokens == null && resolved.prompt_tokens != null) ||
    (stored.completion_tokens == null && resolved.completion_tokens != null) ||
    (stored.tokens_per_second == null && resolved.tokens_per_second != null) ||
    (stored.time_to_first_token == null && resolved.time_to_first_token != null) ||
    (stored.generation_time == null && resolved.generation_time != null) ||
    (!stored.stop_reason && !!resolved.stop_reason)
  );
}
