const REASONING_EFFORT_OPTIONS = [
  "off",
  "on",
  "low",
  "medium",
  "high",
  "max"
];
const EFFORT_SET = new Set(REASONING_EFFORT_OPTIONS);
const COMPOSER_REASONING_LEVELS = [
  "low",
  "medium",
  "high",
  "max"
];
const QWEN38_REASONING_OPTIONS = [
  "off",
  "low",
  "medium",
  "high"
];
const GLM53_REASONING_OPTIONS = [
  "low",
  "high",
  "max"
];
const DEEPSEEK_V4_REASONING_OPTIONS = [
  "off",
  "low",
  "high",
  "max"
];
function isDeepSeekV4ModelId(modelId) {
  if (!modelId) return false;
  return /(?:^|\/)deepseek-(?:flash|v4(?:[._-]\d+)?-(?:flash|pro))$/i.test(modelId);
}
function isQwen38ModelId(modelId) {
  if (!modelId) return false;
  return /(?:^|[^a-z0-9])qwen3[._]8(?![0-9])/i.test(modelId);
}
function isGlm53ModelId(modelId) {
  if (!modelId) return false;
  return /(?:^|[^a-z0-9])glm[-_.]?5[._-]?3(?:[^0-9]|$)/i.test(modelId);
}
function isComposerReasoningLevel(value) {
  return value === "low" || value === "medium" || value === "high" || value === "max";
}
function normalizeReasoningCatalogValue(value, modelId) {
  if (value === "xhigh" || value === "extra_high" || value === "extra high") {
    return isGlm53ModelId(modelId) ? "max" : "high";
  }
  if (value === "none") return "off";
  return isReasoningEffortOption(value) ? value : void 0;
}
function isReasoningEffortOption(value) {
  return typeof value === "string" && EFFORT_SET.has(value);
}
function normalizeReasoningAllowedOptions(raw, modelId) {
  const seen = /* @__PURE__ */ new Set();
  for (const value of raw) {
    if (typeof value !== "string") continue;
    const mapped = normalizeReasoningCatalogValue(value, modelId) ?? value;
    seen.add(mapped);
  }
  return REASONING_EFFORT_OPTIONS.filter((option) => seen.has(option));
}
function modelHasSelectableReasoningEffort(caps) {
  return (caps?.reasoningAllowedOptions?.length ?? 0) >= 2;
}
function modelHasReasoningEffortLevels(caps) {
  const allowed = caps?.reasoningAllowedOptions ?? [];
  return allowed.some((o) => isComposerReasoningLevel(o));
}
function modelUsesComposerReasoningDropdown(caps) {
  return modelUsesComposerReasoningLevelDropdown(caps);
}
function modelUsesComposerThinkingToggle(caps) {
  if (modelUsesComposerReasoningDropdown(caps)) return false;
  const allowed = caps?.reasoningAllowedOptions ?? [];
  if (allowed.includes("off") && allowed.includes("on")) return true;
  return allowed.length === 0 && caps?.reasoning !== false;
}
function modelUsesAlwaysOnReasoning(caps) {
  const allowed = caps?.reasoningAllowedOptions ?? [];
  if (allowed.length === 0) return false;
  return !allowed.includes("off") && allowed.includes("max");
}
function modelShowsComposerBrainToggle(caps) {
  if (modelUsesAlwaysOnReasoning(caps)) return false;
  return modelUsesComposerReasoningDropdown(caps) || modelUsesComposerThinkingToggle(caps);
}
function getComposerReasoningLevelOptions(allowed) {
  return COMPOSER_REASONING_LEVELS.filter((o) => allowed.includes(o));
}
function getComposerReasoningBinaryOptions(allowed) {
  const normalized = normalizeReasoningAllowedOptions(allowed);
  const options = [];
  if (normalized.includes("off")) options.push("off");
  if (normalized.includes("on")) options.push("on");
  return options;
}
function modelUsesComposerReasoningLevelDropdown(caps) {
  return modelHasReasoningEffortLevels(caps);
}
function modelUsesComposerReasoningBinaryDropdown(_caps) {
  return false;
}
function defaultComposerReasoningLevel(caps) {
  const levels = getComposerReasoningLevelOptions(caps?.reasoningAllowedOptions ?? []);
  if (levels.length === 0) return void 0;
  const catalogDefault = caps?.reasoningDefault;
  if (catalogDefault && levels.includes(catalogDefault)) return catalogDefault;
  if (levels.includes("medium")) return "medium";
  return levels[0];
}
function formatReasoningEffortLabel(option) {
  switch (option) {
    case "off":
      return "Off";
    case "on":
      return "On";
    case "low":
      return "Low";
    case "medium":
      return "Medium";
    case "high":
      return "High";
    case "max":
      return "Max";
    default:
      return option;
  }
}
function isThinkingTypeOnlyOpenAiModel(modelId) {
  const id = modelId.trim().toLowerCase();
  return /kimi|moonshot|deepseek|minimax/.test(id);
}
function inferReasoningOptionsFromModelId(modelId, apiKind) {
  if (isGlm53ModelId(modelId)) {
    return [...GLM53_REASONING_OPTIONS];
  }
  if (isQwen38ModelId(modelId)) {
    return [...QWEN38_REASONING_OPTIONS];
  }
  if (apiKind !== "openai-v1") return [];
  if (isDeepSeekV4ModelId(modelId)) {
    return [...DEEPSEEK_V4_REASONING_OPTIONS];
  }
  if (isThinkingTypeOnlyOpenAiModel(modelId)) {
    return ["off", "on"];
  }
  return ["off", "low", "medium", "high"];
}
function ensureQwen38ReasoningAllowedOptions(modelId, allowed) {
  if (!isQwen38ModelId(modelId)) return allowed;
  const hasLevels = allowed.some((o) => isComposerReasoningLevel(o));
  if (hasLevels) {
    return normalizeReasoningAllowedOptions(
      [...allowed, ...QWEN38_REASONING_OPTIONS],
      modelId
    );
  }
  return [...QWEN38_REASONING_OPTIONS];
}
function ensureGlm53ReasoningAllowedOptions(modelId, allowed) {
  if (!isGlm53ModelId(modelId)) return allowed;
  return [...GLM53_REASONING_OPTIONS];
}
function ensureDeepSeekV4ReasoningAllowedOptions(modelId, allowed) {
  if (!isDeepSeekV4ModelId(modelId)) return allowed;
  if (allowed.some((option) => isComposerReasoningLevel(option))) return allowed;
  return [...DEEPSEEK_V4_REASONING_OPTIONS];
}
function resolveEffectiveReasoningEffort(chat, caps, inheritedResolved) {
  const allowed = caps?.reasoningAllowedOptions ?? [];
  if (allowed.length === 0) return void 0;
  if (chat.reasoningEffort === "off" && !modelUsesAlwaysOnReasoning(caps)) {
    return "off";
  }
  if (chat.reasoningEffort && allowed.includes(chat.reasoningEffort)) {
    return chat.reasoningEffort;
  }
  if (inheritedResolved === "on") {
    const catalogDefault2 = caps?.reasoningDefault;
    if (catalogDefault2 && catalogDefault2 !== "off" && allowed.includes(catalogDefault2)) {
      return catalogDefault2;
    }
    if (allowed.includes("medium")) return "medium";
    if (allowed.includes("max")) return "max";
    if (allowed.includes("on")) return "on";
  }
  const catalogDefault = caps?.reasoningDefault;
  if (catalogDefault && allowed.includes(catalogDefault)) {
    return catalogDefault;
  }
  if (inheritedResolved === "off" && allowed.includes("off")) {
    return "off";
  }
  return allowed[0];
}
export {
  DEEPSEEK_V4_REASONING_OPTIONS,
  GLM53_REASONING_OPTIONS,
  QWEN38_REASONING_OPTIONS,
  REASONING_EFFORT_OPTIONS,
  defaultComposerReasoningLevel,
  ensureGlm53ReasoningAllowedOptions,
  ensureDeepSeekV4ReasoningAllowedOptions,
  ensureQwen38ReasoningAllowedOptions,
  formatReasoningEffortLabel,
  getComposerReasoningBinaryOptions,
  getComposerReasoningLevelOptions,
  inferReasoningOptionsFromModelId,
  isComposerReasoningLevel,
  isGlm53ModelId,
  isDeepSeekV4ModelId,
  isQwen38ModelId,
  isReasoningEffortOption,
  modelHasReasoningEffortLevels,
  modelHasSelectableReasoningEffort,
  modelShowsComposerBrainToggle,
  modelUsesAlwaysOnReasoning,
  modelUsesComposerReasoningBinaryDropdown,
  modelUsesComposerReasoningDropdown,
  modelUsesComposerReasoningLevelDropdown,
  modelUsesComposerThinkingToggle,
  normalizeReasoningAllowedOptions,
  normalizeReasoningCatalogValue,
  resolveEffectiveReasoningEffort
};
