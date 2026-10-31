const ZERO_RATES = { inputPer1M: 0, outputPer1M: 0 };
function resolveModelPricing(pricing, modelId) {
  if (!pricing) return { ...ZERO_RATES };
  const id = modelId.trim();
  const models = pricing.models;
  if (id && models?.[id]) return { ...models[id] };
  if (models?.["*"]) return { ...models["*"] };
  if (pricing.default) return { ...pricing.default };
  return { ...ZERO_RATES };
}
function usageTokenCounts(usage) {
  const prompt = usage.prompt_tokens ?? 0;
  const completion = usage.completion_tokens ?? 0;
  let total = usage.total_tokens ?? prompt + completion;
  if (total <= 0 && (prompt > 0 || completion > 0)) {
    total = prompt + completion;
  }
  if (prompt <= 0 && completion <= 0 && (usage.total_tokens ?? 0) > 0) {
    return {
      promptTokens: 0,
      completionTokens: usage.total_tokens ?? 0,
      totalTokens: usage.total_tokens ?? 0
    };
  }
  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: total > 0 ? total : prompt + completion
  };
}
function hasMeasurableUsage(usage) {
  if (!usage) return false;
  const { promptTokens, completionTokens, totalTokens } = usageTokenCounts(usage);
  return promptTokens + completionTokens + totalTokens > 0;
}
function computeCostUsd(usage, rates) {
  const { promptTokens, completionTokens } = usageTokenCounts(usage);
  if (promptTokens + completionTokens <= 0 && !(usage.total_tokens && usage.total_tokens > 0)) {
    return null;
  }
  const cost = promptTokens / 1e6 * rates.inputPer1M + completionTokens / 1e6 * rates.outputPer1M;
  if (!Number.isFinite(cost)) return null;
  if (rates.inputPer1M === 0 && rates.outputPer1M === 0) return null;
  return cost;
}
export {
  computeCostUsd,
  hasMeasurableUsage,
  resolveModelPricing,
  usageTokenCounts
};
