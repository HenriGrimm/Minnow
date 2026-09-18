import { isGlm53ModelId, isQwen38ModelId } from "./reasoning-effort.js";
const LM_STUDIO_BEST_EFFORT = {
  bestEffort: true,
  message: "LM Studio may ignore API reasoning controls and use per-model Inference settings instead."
};
const ANTHROPIC_BUDGET_FLOOR = 1024;
const LOCAL_TEMPLATE_THINKING_OFF = {
  enable_thinking: false,
  chat_template_kwargs: { enable_thinking: false }
};
function mapHighEffortForQwen38(effort, modelId) {
  if (effort === "high" && isQwen38ModelId(modelId)) return "xhigh";
  return effort;
}
function glm53WireEffort(effort) {
  if (effort === "high") return "high";
  if (effort === "max") return "max";
  if (effort === "low") return "low";
  if (effort === "on") return "max";
  return "low";
}
function glm53CompletionPatch(effort, apiKind, budgetTokens, modelId) {
  const wireEffort = glm53WireEffort(effort);
  const body = {
    thinking: { type: "enabled" },
    reasoning_effort: wireEffort,
    reasoning: { effort: wireEffort }
  };
  if (budgetTokens != null && budgetTokens > 0) {
    body.thinking_budget_tokens = budgetTokens;
  }
  applyLocalTemplateThinkingOn(body, apiKind, wireEffort, modelId);
  if (apiKind !== "openai-v1") {
    body.enable_thinking = true;
    return { body, hint: LM_STUDIO_BEST_EFFORT };
  }
  return { body };
}
function templateKwargsOf(body) {
  return body.chat_template_kwargs && typeof body.chat_template_kwargs === "object" ? { ...body.chat_template_kwargs } : {};
}
function applyLocalTemplateThinkingOn(body, apiKind, wireEffort, modelId) {
  if (apiKind !== "openai-v1" && apiKind !== "lm-studio-v0") return;
  if (/kimi|moonshot/i.test(modelId ?? "")) return;
  const isQwen38 = isQwen38ModelId(modelId);
  if (apiKind === "lm-studio-v0" && isQwen38) {
    body.preserve_thinking = true;
  }
  if (apiKind === "openai-v1") {
    body.enable_thinking = true;
  }
  body.chat_template_kwargs = {
    ...templateKwargsOf(body),
    enable_thinking: true,
    ...wireEffort ? { reasoning_effort: wireEffort } : {},
    ...isQwen38 ? { preserve_thinking: true } : {}
  };
}
let lmStudioHintShown = false;
function wasLmStudioThinkingHintShown() {
  return lmStudioHintShown;
}
function markLmStudioThinkingHintShown() {
  lmStudioHintShown = true;
}
function resetLmStudioThinkingHint() {
  lmStudioHintShown = false;
}
function effortForResolved(mode) {
  return mode === "on" ? "medium" : "none";
}
function isLevelEffort(effort) {
  return effort === "low" || effort === "medium" || effort === "high";
}
function isWireLevelEffort(effort) {
  return isLevelEffort(effort) || effort === "max";
}
function reasoningBlocked(effort, modelCapabilities) {
  if (effort === "off") return false;
  const allowed = modelCapabilities?.reasoningAllowedOptions;
  if (allowed && allowed.length > 0 && !allowed.includes(effort)) {
    return true;
  }
  if (modelCapabilities?.reasoning === false) {
    return true;
  }
  return false;
}
const ANTHROPIC_BUDGET_BY_EFFORT = {
  low: 2048,
  medium: 10240,
  high: 32768
};
function anthropicUsesAdaptiveThinking(modelCapabilities) {
  return modelCapabilities?.reasoningThinkingEnabledValue === "adaptive";
}
function resolveAnthropicBudgetTokens(effort, explicitBudget) {
  if (explicitBudget != null && explicitBudget > 0) {
    return Math.max(ANTHROPIC_BUDGET_FLOOR, explicitBudget);
  }
  if (effort && isLevelEffort(effort)) {
    return ANTHROPIC_BUDGET_BY_EFFORT[effort];
  }
  return ANTHROPIC_BUDGET_BY_EFFORT.medium;
}
function anthropicThinkingPatch(thinking, effort, explicitBudget) {
  const anthropic = { thinking };
  if (effort && thinking.type === "adaptive") {
    anthropic.effort = effort;
  }
  const nativeBudgetApplied = thinking.type === "enabled" && explicitBudget != null && explicitBudget > 0;
  if (thinking.type === "enabled") {
    const budgetTokens = resolveAnthropicBudgetTokens(effort, explicitBudget);
    thinking = { ...thinking, budgetTokens };
    anthropic.thinking = thinking;
  }
  return {
    body: { providerOptions: { anthropic } },
    nativeBudgetApplied
  };
}
function reasoningEffortToCompletionBody(effort, apiKind, modelCapabilities, budgetTokens, modelId) {
  if (apiKind === "agent-cli-v1") {
    if (reasoningBlocked(effort, modelCapabilities)) return { body: {} };
    return { body: { reasoning_effort: effort === "on" ? "medium" : effort } };
  }
  if (isGlm53ModelId(modelId)) {
    return glm53CompletionPatch(effort, apiKind, budgetTokens, modelId);
  }
  if (reasoningBlocked(effort, modelCapabilities)) {
    return { body: {} };
  }
  const enabledValue = modelCapabilities?.reasoningThinkingEnabledValue ?? "enabled";
  if (apiKind === "anthropic-v1") {
    if (effort === "off") {
      return { body: {} };
    }
    if (anthropicUsesAdaptiveThinking(modelCapabilities)) {
      if (effort === "on") {
        return anthropicThinkingPatch({ type: "adaptive" });
      }
      if (isLevelEffort(effort)) {
        return anthropicThinkingPatch({ type: "adaptive" }, effort);
      }
      return anthropicThinkingPatch({ type: "adaptive" });
    }
    if (isLevelEffort(effort)) {
      return anthropicThinkingPatch(
        { type: "enabled" },
        effort,
        budgetTokens
      );
    }
    return anthropicThinkingPatch(
      { type: "enabled" },
      "medium",
      budgetTokens
    );
  }
  if (apiKind === "openai-v1") {
    if (effort === "off") {
      return {
        body: { thinking: { type: "disabled" }, ...LOCAL_TEMPLATE_THINKING_OFF }
      };
    }
    const body2 = {};
    if (budgetTokens != null && budgetTokens > 0) {
      body2.thinking_budget_tokens = budgetTokens;
    }
    if (isWireLevelEffort(effort)) {
      const wireEffort2 = mapHighEffortForQwen38(effort, modelId);
      body2.reasoning_effort = wireEffort2;
      const allowed = modelCapabilities?.reasoningAllowedOptions;
      if (allowed?.some((option) => isWireLevelEffort(option))) {
        body2.reasoning = { effort: wireEffort2 };
      }
      if (enabledValue === "adaptive") {
        body2.thinking = { type: "adaptive" };
      }
      applyLocalTemplateThinkingOn(body2, apiKind, wireEffort2, modelId);
      return { body: body2 };
    }
    body2.thinking = { type: enabledValue };
    const onEffort = isQwen38ModelId(modelId) ? "xhigh" : void 0;
    if (onEffort) body2.reasoning_effort = onEffort;
    applyLocalTemplateThinkingOn(body2, apiKind, onEffort, modelId);
    return { body: body2 };
  }
  if (effort === "off") {
    return {
      body: {
        enable_thinking: false,
        reasoning_effort: "none"
      },
      hint: LM_STUDIO_BEST_EFFORT
    };
  }
  if (effort === "on") {
    const wireEffort2 = isQwen38ModelId(modelId) ? "xhigh" : "medium";
    const body2 = {
      enable_thinking: true,
      reasoning_effort: wireEffort2,
      reasoning: { effort: wireEffort2 }
    };
    applyLocalTemplateThinkingOn(body2, apiKind, wireEffort2, modelId);
    return { body: body2, hint: LM_STUDIO_BEST_EFFORT };
  }
  const wireEffort = mapHighEffortForQwen38(effort, modelId);
  const body = {
    enable_thinking: true,
    reasoning_effort: wireEffort,
    reasoning: { effort: wireEffort }
  };
  applyLocalTemplateThinkingOn(body, apiKind, wireEffort, modelId);
  return { body, hint: LM_STUDIO_BEST_EFFORT };
}
function thinkingToCompletionBody(resolved, apiKind, modelCapabilities, budgetTokens, modelId) {
  if (apiKind === "agent-cli-v1") {
    if (modelCapabilities?.reasoning === false) return { body: {} };
    return { body: { reasoning_effort: resolved === "on" ? "medium" : "off" } };
  }
  if (isGlm53ModelId(modelId)) {
    return glm53CompletionPatch(resolved, apiKind, budgetTokens, modelId);
  }
  const allowed = modelCapabilities?.reasoningAllowedOptions;
  if (allowed && allowed.length > 0) {
    const target = resolved;
    if (!allowed.includes(target)) {
      const hasLevels = allowed.some((option) => isWireLevelEffort(option));
      if (target === "on" && hasLevels) {
        const fallback = isQwen38ModelId(modelId) ? "high" : "medium";
        return reasoningEffortToCompletionBody(
          fallback,
          apiKind,
          modelCapabilities,
          budgetTokens,
          modelId
        );
      }
      if (target === "off" && allowed.includes("off")) {
        return reasoningEffortToCompletionBody(
          "off",
          apiKind,
          modelCapabilities,
          budgetTokens,
          modelId
        );
      }
      return { body: {} };
    }
  } else if (modelCapabilities?.reasoning === false && resolved === "on") {
    return { body: {} };
  }
  if (apiKind === "anthropic-v1") {
    if (resolved === "off") {
      return { body: {} };
    }
    if (anthropicUsesAdaptiveThinking(modelCapabilities)) {
      return anthropicThinkingPatch({ type: "adaptive" });
    }
    return anthropicThinkingPatch({ type: "enabled" }, "medium", budgetTokens);
  }
  if (apiKind === "openai-v1") {
    if (resolved === "off") {
      return {
        body: { thinking: { type: "disabled" }, ...LOCAL_TEMPLATE_THINKING_OFF }
      };
    }
    const enabledValue = modelCapabilities?.reasoningThinkingEnabledValue ?? "enabled";
    const body2 = { thinking: { type: enabledValue } };
    if (budgetTokens != null && budgetTokens > 0) {
      body2.thinking_budget_tokens = budgetTokens;
    }
    const onEffort = isQwen38ModelId(modelId) ? "xhigh" : void 0;
    if (onEffort) body2.reasoning_effort = onEffort;
    applyLocalTemplateThinkingOn(body2, apiKind, onEffort, modelId);
    return { body: body2 };
  }
  const effort = resolved === "on" && isQwen38ModelId(modelId) ? "xhigh" : effortForResolved(resolved);
  const body = {
    reasoning_effort: effort,
    reasoning: { effort },
    enable_thinking: resolved === "on"
  };
  if (resolved === "on") {
    applyLocalTemplateThinkingOn(body, apiKind, effort, modelId);
  }
  return { body, hint: LM_STUDIO_BEST_EFFORT };
}
export {
  markLmStudioThinkingHintShown,
  reasoningEffortToCompletionBody,
  resetLmStudioThinkingHint,
  thinkingToCompletionBody,
  wasLmStudioThinkingHintShown
};
