import { runHeadlessToolBatch } from '../tools/headless-tool-batch';
import { resolveProvider } from '../providers/store';
import { getSubAgentTypeConfig } from '../agents/sub-agent-config';
import { resolveSamplerPreset } from '../agents/resolve-sampler';
import { resolveThinkingMode, resolveThinkingBudgetTokens } from '../agents/resolve-thinking';
import { getToolCallsMetaSync, isConstrainedDecodingEnabledForProvider, loadToolCallsMeta } from '../config/tool-calls-meta';
import { isStructuredOutcomeResponseFormatAvailable, readProviderCapabilities } from '../providers/capability-probe';
import { resolveSendCapabilities } from '../providers/model-capabilities';
import { createMemoryTranscriptStore } from '../../server/runner/transcript-store.js';
import { applyServerContextPolicy } from '../../server/runner/context-budget.js';
import type { RunnerDeps } from '../../server/runner/adapters';

/** Node-safe adapters: the CLI owns its transcript and never touches SPA sessions. */
export function createHeadlessRunnerDeps(postChatCompletions: RunnerDeps['postChatCompletions']): RunnerDeps {
  return {
    transcriptStore: createMemoryTranscriptStore(),
    postChatCompletions,
    runHeadlessToolBatch: (options: Parameters<RunnerDeps['runHeadlessToolBatch']>[0]) => runHeadlessToolBatch(options as Parameters<typeof runHeadlessToolBatch>[0]),
    resolveProvider,
    getSubAgentTypeConfig,
    resolveSamplerPreset,
    resolveThinkingMode,
    resolveThinkingBudgetTokens,
    loadToolCallsMeta,
    getToolCallsMetaSync,
    isConstrainedDecodingEnabledForProvider,
    readProviderCapabilities,
    isStructuredOutcomeResponseFormatAvailable,
    resolveSendCapabilities,
    resolveModelContextLimit: () => null,
    applyContextPolicy: async (input: unknown) => applyServerContextPolicy(input as Parameters<typeof applyServerContextPolicy>[0]),
  } as unknown as RunnerDeps;
}
