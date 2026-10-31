import { createServerRunnerDeps } from '../runtime/server-runner-deps.js';
import { postChatCompletionsInProcess } from '../runner/generation-binding.js';
import { readCapabilities } from '../providers/capabilities-store.js';
import { resolveServerModelContextLimit } from '../models/context-window.js';

/** The same Node runner dependencies, supplied with this admission's verified model facts. */
export async function createChatRunnerDeps(prepared) {
  const base = createServerRunnerDeps(postChatCompletionsInProcess);
  const model = prepared.model;
  const capabilities = prepared.providerCapabilities ??
    (model.providerId === 'minnow-router' ? {} : await readCapabilities(model.providerId));
  const sendCapabilities = prepared.sendCapabilities ?? (model.providerId === 'minnow-router' ? {
    reasoning: true, reasoningAllowedOptions: model.options?.reasoningEffort ? [model.options.reasoningEffort] : [],
  } : {});
  const limit = prepared.limits?.modelContextLimit ?? await resolveServerModelContextLimit(model);
  return { ...base,
    readProviderCapabilities: providerId => providerId === model.providerId ? Promise.resolve(capabilities) : readCapabilities(providerId),
    resolveSendCapabilities: (providerId, modelId) => providerId === model.providerId && modelId === model.id ? sendCapabilities : {},
    resolveModelContextLimit: () => limit,
    isVisionModel: modelId => modelId === model.id && model.vision === true,
  };
}
