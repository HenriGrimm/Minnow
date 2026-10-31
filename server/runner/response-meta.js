/** Shared response accounting. No renderer, session, or provider side effects. */
function normalizeUsageTotals(usage) {
  const out = { ...usage };
  if (out.total_tokens != null && Number.isFinite(out.total_tokens)) {
    return out;
  }
  const hasPrompt = out.prompt_tokens != null && Number.isFinite(out.prompt_tokens);
  const hasCompletion = out.completion_tokens != null && Number.isFinite(out.completion_tokens);
  if (!hasPrompt && !hasCompletion) return out;
  out.total_tokens = (out.prompt_tokens ?? 0) + (out.completion_tokens ?? 0);
  return out;
}
function statsFromLlamaTimings(timings) {
  if (!timings) return null;
  const predictedN = Number(timings.predicted_n);
  const predictedMs = Number(timings.predicted_ms);
  if (!(predictedN >= 2) || !(predictedMs > 0)) return null;
  const out = {
    generation_time: predictedMs / 1e3,
    tokens_per_second: Number(timings.predicted_per_second) > 0 ? Number(timings.predicted_per_second) : predictedN / predictedMs * 1e3
  };
  if (Number(timings.prompt_ms) > 0) out.time_to_first_token = Number(timings.prompt_ms) / 1e3;
  if (Number(timings.prompt_per_second) > 0) {
    out.prompt_tokens_per_second = Number(timings.prompt_per_second);
  }
  const draftN = Number(timings.draft_n);
  const draftAccepted = Number(timings.draft_n_accepted);
  if (draftN > 0 && Number.isFinite(draftAccepted)) {
    out.draft_acceptance = draftAccepted / draftN;
  }
  return out;
}
function fillUsageFromLlamaTimings(usage, timings) {
  const out = { ...usage || {} };
  if (!timings) return normalizeUsageTotals(out);
  const promptN = Number(timings.prompt_n);
  const cacheN = Number(timings.cache_n);
  const predictedN = Number(timings.predicted_n);
  if (out.prompt_tokens == null && Number.isFinite(promptN) && promptN >= 0) {
    out.prompt_tokens = promptN + (Number.isFinite(cacheN) && cacheN > 0 ? cacheN : 0);
  }
  if (out.completion_tokens == null && Number.isFinite(predictedN) && predictedN >= 0) {
    out.completion_tokens = predictedN;
  }
  return normalizeUsageTotals(out);
}
const MAX_PLAUSIBLE_TOKENS_PER_SECOND = 2e3;
const MIN_DECODE_SECONDS = 1e-3;
function decodeWindowCompletionTokens(usage, streamedReasoning) {
  const completion = usage?.completion_tokens;
  if (completion == null || !Number.isFinite(completion) || completion <= 0) return null;
  if (streamedReasoning === true) return completion;
  const reasoning = usage?.completion_tokens_details?.reasoning_tokens;
  if (reasoning == null || !Number.isFinite(reasoning) || reasoning <= 0) return completion;
  const visible = completion - reasoning;
  return visible > 0 ? visible : null;
}
function plausibleTokensPerSecond(tps) {
  if (tps == null || !Number.isFinite(tps) || tps <= 0) return null;
  return tps <= MAX_PLAUSIBLE_TOKENS_PER_SECOND ? tps : null;
}
function resolveDecodeSeconds(t0, tFirst, tEnd, completionTokens, window = "decode") {
  if (tFirst == null) return null;
  const ttft = (tFirst - t0) / 1e3;
  const streamSec = Math.max((tEnd - t0) / 1e3, MIN_DECODE_SECONDS);
  if (window === "request") {
    return { ttft, genTime: streamSec };
  }
  let genTime = Math.max((tEnd - tFirst) / 1e3, MIN_DECODE_SECONDS);
  if (completionTokens != null && completionTokens > 0) {
    const burstTps = completionTokens / genTime;
    if (burstTps > MAX_PLAUSIBLE_TOKENS_PER_SECOND) {
      genTime = streamSec;
    }
  }
  return { ttft, genTime };
}
function buildClientStats(t0, tFirst, tEnd, usage, finishReason, streamedReasoning, window = "decode") {
  const completionTokens = decodeWindowCompletionTokens(usage, streamedReasoning);
  const timings = resolveDecodeSeconds(t0, tFirst, tEnd, completionTokens, window);
  if (!timings) return {};
  const tps = plausibleTokensPerSecond(
    completionTokens != null ? completionTokens / timings.genTime : null
  );
  const stats = {
    time_to_first_token: timings.ttft,
    generation_time: timings.genTime
  };
  if (tps != null) stats.tokens_per_second = tps;
  if (finishReason) stats.stop_reason = finishReason;
  return stats;
}
const USAGE_TIMING_TOLERANCE = 0.35;
function serverTimingMatchesUsage(server, usage) {
  const completion = decodeWindowCompletionTokens(usage);
  const tps = server.tokens_per_second;
  const gen = server.generation_time;
  if (completion == null || completion <= 0) return true;
  if (tps == null || gen == null || !Number.isFinite(tps) || !Number.isFinite(gen) || gen <= 0) {
    return true;
  }
  if (tps > MAX_PLAUSIBLE_TOKENS_PER_SECOND) return false;
  const implied = tps * gen;
  return Math.abs(implied - completion) / completion <= USAGE_TIMING_TOLERANCE;
}
function serverGenerationTimeMatchesUsage(server, usage) {
  const completion = decodeWindowCompletionTokens(usage);
  const gen = server.generation_time;
  if (completion == null || completion <= 0) return false;
  if (gen == null || !Number.isFinite(gen) || gen <= 0) return false;
  return completion / gen <= MAX_PLAUSIBLE_TOKENS_PER_SECOND;
}
function serverTimingMatchesClientWallClock(server, client) {
  const serverGen = server.generation_time;
  const clientGen = client.generation_time;
  if (serverGen == null || clientGen == null || !Number.isFinite(serverGen) || !Number.isFinite(clientGen) || clientGen <= 0) {
    return true;
  }
  if (clientGen < 1) return true;
  const serverTtft = server.time_to_first_token;
  const serverElapsed = serverGen + (serverTtft != null && Number.isFinite(serverTtft) && serverTtft > 0 ? serverTtft : 0);
  return serverElapsed >= clientGen * 0.2;
}
function applyServerTimingFields(out, serverStats) {
  if (serverStats.time_to_first_token != null) {
    out.time_to_first_token = serverStats.time_to_first_token;
  }
  if (serverStats.generation_time != null) out.generation_time = serverStats.generation_time;
  if (serverStats.tokens_per_second != null) out.tokens_per_second = serverStats.tokens_per_second;
}
function applyLlamaOnlyServerFields(out, serverStats) {
  if (serverStats.prompt_tokens_per_second != null) {
    out.prompt_tokens_per_second = serverStats.prompt_tokens_per_second;
  }
  if (serverStats.draft_acceptance != null) {
    out.draft_acceptance = serverStats.draft_acceptance;
  }
}
function recomputeTokensPerSecond(out, usage, streamedReasoning) {
  const completion = decodeWindowCompletionTokens(usage, streamedReasoning);
  const gen = out.generation_time;
  if (completion == null || gen == null || gen <= 0) {
    delete out.tokens_per_second;
    return;
  }
  const tps = plausibleTokensPerSecond(completion / gen);
  if (tps == null) delete out.tokens_per_second;
  else out.tokens_per_second = tps;
}
function clampReconciledTokensPerSecond(out) {
  if (out.tokens_per_second == null) return out;
  const tps = plausibleTokensPerSecond(out.tokens_per_second);
  if (tps == null) delete out.tokens_per_second;
  else out.tokens_per_second = tps;
  return out;
}
function reconcileCompletionStats(clientStats, serverStats, usage, streamedReasoning) {
  const out = { ...clientStats };
  if (serverStats.stop_reason) out.stop_reason = serverStats.stop_reason;
  applyLlamaOnlyServerFields(out, serverStats);
  const hasServerTiming = serverStats.tokens_per_second != null || serverStats.generation_time != null || serverStats.time_to_first_token != null;
  if (!hasServerTiming) return clampReconciledTokensPerSecond(out);
  const fullTrust = serverTimingMatchesUsage(serverStats, usage) && serverTimingMatchesClientWallClock(serverStats, clientStats);
  if (fullTrust) {
    applyServerTimingFields(out, serverStats);
    return clampReconciledTokensPerSecond(out);
  }
  if (serverGenerationTimeMatchesUsage(serverStats, usage)) {
    if (serverStats.time_to_first_token != null) {
      out.time_to_first_token = serverStats.time_to_first_token;
    }
    if (serverStats.generation_time != null) out.generation_time = serverStats.generation_time;
    recomputeTokensPerSecond(out, usage, streamedReasoning);
    return clampReconciledTokensPerSecond(out);
  }
  recomputeTokensPerSecond(out, usage, streamedReasoning);
  return clampReconciledTokensPerSecond(out);
}
function finalizeResponseMeta(streamMeta, t0, tFirst, tEnd) {
  const usage = fillUsageFromLlamaTimings(streamMeta.usage, streamMeta.timings);
  const serverStats = streamMeta.stats || {};
  const streamedReasoning = streamMeta.streamed_reasoning === true;
  const clientStats = buildClientStats(
    t0,
    tFirst,
    tEnd,
    usage,
    streamMeta.finish_reason,
    streamedReasoning,
    "request"
  );
  const stats = reconcileCompletionStats(clientStats, serverStats, usage, streamedReasoning);
  return {
    stats,
    usage,
    model_info: streamMeta.model_info || {}
  };
}
export {
  MAX_PLAUSIBLE_TOKENS_PER_SECOND,
  buildClientStats,
  decodeWindowCompletionTokens,
  fillUsageFromLlamaTimings,
  finalizeResponseMeta,
  normalizeUsageTotals,
  plausibleTokensPerSecond,
  reconcileCompletionStats,
  resolveDecodeSeconds,
  statsFromLlamaTimings
};
