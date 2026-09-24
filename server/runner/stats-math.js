function aggregateTurnUsageSegments(segments) {
  if (segments.length === 0) return {};
  let completion = 0;
  let hasCompletion = false;
  let latestPrompt;
  for (const u of segments) {
    if (u.prompt_tokens != null && Number.isFinite(u.prompt_tokens)) {
      latestPrompt = u.prompt_tokens;
    }
    if (u.completion_tokens != null && Number.isFinite(u.completion_tokens)) {
      completion += u.completion_tokens;
      hasCompletion = true;
    }
  }
  const out = {};
  if (latestPrompt != null) out.prompt_tokens = latestPrompt;
  if (hasCompletion) out.completion_tokens = completion;
  if (out.prompt_tokens != null || out.completion_tokens != null) {
    out.total_tokens = (out.prompt_tokens ?? 0) + (out.completion_tokens ?? 0);
  }
  return out;
}
function sumUsageSegments(segments) {
  let prompt = 0;
  let completion = 0;
  let total = 0;
  let hasPrompt = false;
  let hasCompletion = false;
  let hasTotal = false;
  for (const u of segments) {
    let segPrompt = 0;
    let segCompletion = 0;
    let segHasPrompt = false;
    let segHasCompletion = false;
    if (u.prompt_tokens != null && Number.isFinite(u.prompt_tokens)) {
      segPrompt = u.prompt_tokens;
      segHasPrompt = true;
      prompt += u.prompt_tokens;
      hasPrompt = true;
    }
    if (u.completion_tokens != null && Number.isFinite(u.completion_tokens)) {
      segCompletion = u.completion_tokens;
      segHasCompletion = true;
      completion += u.completion_tokens;
      hasCompletion = true;
    }
    if (u.total_tokens != null && Number.isFinite(u.total_tokens)) {
      total += u.total_tokens;
      hasTotal = true;
    } else if (segHasPrompt || segHasCompletion) {
      total += segPrompt + segCompletion;
      hasTotal = true;
    }
  }
  const out = {};
  if (hasPrompt) out.prompt_tokens = prompt;
  if (hasCompletion) out.completion_tokens = completion;
  if (hasTotal) {
    out.total_tokens = total;
  } else if (hasPrompt || hasCompletion) {
    out.total_tokens = prompt + completion;
  }
  return out;
}
function mean(values) {
  if (values.length === 0) return void 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}
function averageStatsSegments(pairs) {
  let measuredTokens = 0;
  let measuredSeconds = 0;
  const tpsSimple = [];
  const ttft = [];
  const gen = [];
  for (const { stats, usage } of pairs) {
    const tps = stats.tokens_per_second;
    if (tps != null && Number.isFinite(tps)) {
      const seconds = stats.generation_time;
      if (seconds != null && Number.isFinite(seconds) && seconds > 0) {
        // Rates combine by total measured output over total measured time. A
        // token-weighted arithmetic mean systematically overstates throughput
        // whenever fast, short tool-call bursts sit beside longer rounds.
        measuredTokens += tps * seconds;
        measuredSeconds += seconds;
      } else {
        const completion = usage.completion_tokens;
        if (completion != null && Number.isFinite(completion) && completion > 0 && tps > 0) {
          measuredTokens += completion;
          measuredSeconds += completion / tps;
        } else {
          tpsSimple.push(tps);
        }
      }
    }
    if (stats.time_to_first_token != null && Number.isFinite(stats.time_to_first_token)) {
      ttft.push(stats.time_to_first_token);
    }
    if (stats.generation_time != null && Number.isFinite(stats.generation_time)) {
      gen.push(stats.generation_time);
    }
  }
  const out = {};
  const simpleTps = mean(tpsSimple);
  if (measuredSeconds > 0) {
    out.tokens_per_second = measuredTokens / measuredSeconds;
  } else if (simpleTps != null) {
    out.tokens_per_second = simpleTps;
  }
  const ttftMean = mean(ttft);
  if (ttftMean != null) out.time_to_first_token = ttftMean;
  const genMean = mean(gen);
  if (genMean != null) out.generation_time = genMean;
  return out;
}
function aggregateTurnMetaSegments(segments) {
  if (segments.length === 0) return { stats: {}, usage: {} };
  return {
    stats: averageStatsSegments(segments),
    usage: aggregateTurnUsageSegments(segments.map((segment) => segment.usage))
  };
}
function aggregateOrchestrateTurnMeta(parent, subRuns) {
  const segments = [{ stats: parent.stats, usage: parent.usage }];
  for (const run of subRuns) {
    if (!run.usage && !run.stats) continue;
    segments.push({
      stats: run.stats ?? {},
      usage: run.usage ?? {}
    });
  }
  const usageParts = segments.map((s) => s.usage);
  const stats = averageStatsSegments(segments);
  if (parent.stats.stop_reason) {
    stats.stop_reason = parent.stats.stop_reason;
  }
  return {
    stats,
    usage: sumUsageSegments(usageParts),
    model_info: parent.model_info
  };
}
export {
  aggregateOrchestrateTurnMeta,
  aggregateTurnMetaSegments,
  aggregateTurnUsageSegments,
  averageStatsSegments,
  sumUsageSegments
};
