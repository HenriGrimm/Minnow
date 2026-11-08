import {
  modelUsesComposerReasoningDropdown,
  resolveEffectiveReasoningEffort
} from "./reasoning-effort.js";
import { LLAMA_CPP_LOCAL_PROVIDER_ID } from "./provider-ids.js";
import {
  markLmStudioThinkingHintShown,
  reasoningEffortToCompletionBody,
  thinkingToCompletionBody,
  wasLmStudioThinkingHintShown
} from "./thinking-to-body.js";
import { DEFAULT_LLAMA_THINKING_BUDGET_TOKENS } from "./thinking-types.js";
function applyUtilityThinkingOff(body, provider, modelCapabilities, modelApi) {
  const apiKind = modelApi ?? modelCapabilities?.api ?? provider.apiKind;
  // CLI models may require reasoning. Without an advertised off option, leave
  // their default alone instead of translating an optional helper to `none`.
  if (apiKind === "agent-cli-v1" && !modelCapabilities?.reasoningAllowedOptions?.includes("off")) return;
  mergeThinkingIntoCompletionBody(
    body,
    "off",
    provider,
    modelCapabilities,
    "off",
    modelApi
  );
}
function mergeThinkingIntoCompletionBody(body, resolved, provider, modelCapabilities, reasoningEffort, modelApi, budgetTokens, options) {
  const apiKind = modelApi ?? modelCapabilities?.api ?? provider.apiKind;
  const modelId = options?.modelId ?? (typeof body.model === "string" ? body.model : void 0);
  const useEffortDropdown = modelUsesComposerReasoningDropdown(modelCapabilities);
  let effortForSend = reasoningEffort ?? void 0;
  if (useEffortDropdown) {
    if (resolved === "off") {
      effortForSend = "off";
    } else {
      effortForSend = resolveEffectiveReasoningEffort(
        { reasoningEffort: reasoningEffort ?? void 0 },
        modelCapabilities ?? null,
        resolved
      ) ?? effortForSend;
    }
  }
  const patch = useEffortDropdown && effortForSend ? reasoningEffortToCompletionBody(
    effortForSend,
    apiKind,
    modelCapabilities,
    budgetTokens,
    modelId
  ) : thinkingToCompletionBody(resolved, apiKind, modelCapabilities, budgetTokens, modelId);
  Object.assign(body, patch.body);
  let nativeBudgetApplied = patch.nativeBudgetApplied === true;
  if (!nativeBudgetApplied && provider.id === LLAMA_CPP_LOCAL_PROVIDER_ID && options?.llamaSupportsThinkingBudget === true && budgetTokens != null && budgetTokens > 0 && typeof body.thinking_budget_tokens === "number") {
    nativeBudgetApplied = true;
  }
  if (resolved === "on" && provider.id === LLAMA_CPP_LOCAL_PROVIDER_ID && options?.llamaSupportsThinkingBudget === true && (budgetTokens == null || budgetTokens <= 0) && typeof body.thinking_budget_tokens !== "number") {
    body.thinking_budget_tokens = DEFAULT_LLAMA_THINKING_BUDGET_TOKENS;
    nativeBudgetApplied = true;
  }
  if (patch.hint?.bestEffort && provider.apiKind === "lm-studio-v0" && !wasLmStudioThinkingHintShown()) {
    markLmStudioThinkingHintShown();
    options?.onStatusHint?.(patch.hint.message);
  }
  return { body, nativeBudgetApplied };
}
export {
  applyUtilityThinkingOff,
  mergeThinkingIntoCompletionBody
};
