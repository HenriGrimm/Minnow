import { createMemoryTranscriptStore } from '../runner/transcript-store.js';
import { applyServerContextPolicy } from '../runner/context-budget.js';
import { getProvider } from '../providers/store.js';
import { getSubAgentTypeRow } from '../sub-agents/config.js';
import { DEFAULT_AGENT_MAX_TOKENS } from '../agents/sampler.js';

/** Application bindings shared by delegated tasks and durable conversations. */
export function createServerRunnerDeps(postChatCompletions) {
  return {
    transcriptStore: createMemoryTranscriptStore(), postChatCompletions,
    runHeadlessToolBatch: async () => [],
    resolveProvider: async providerId => {
      if (providerId === 'minnow-router') return { id: providerId, label: 'Router', baseUrl: '', apiKind: 'openai-v1' };
      const row = await getProvider(providerId);
      return { id: row.id, label: row.label, baseUrl: row.baseUrl, apiKind: row.apiKind, chatCompletionsPath: row.chatCompletionsPath,
        pricing: row.pricing ?? null };
    },
    getSubAgentTypeConfig: async typeId => (await getSubAgentTypeRow(String(typeId))) ?? {},
    resolveSamplerPreset: () => ({ preset: {}, maxTokens: DEFAULT_AGENT_MAX_TOKENS }),
    resolveThinkingMode: () => ({ mode: 'off' }),
    resolveThinkingBudgetTokens: () => ({ budgetTokens: null }),
    loadToolCallsMeta: async () => {}, getToolCallsMetaSync: () => ({ useConstrainedDecoding: false }),
    isConstrainedDecodingEnabledForProvider: () => false,
    readProviderCapabilities: async () => null, isStructuredOutcomeResponseFormatAvailable: () => false,
    resolveSendCapabilities: () => ({}), resolveModelContextLimit: () => null,
    applyContextPolicy: async input => applyServerContextPolicy(input),
  };
}
