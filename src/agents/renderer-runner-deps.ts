import { postChatCompletions } from '../providers/fetch-chat';
import { runHeadlessToolBatch } from '../tools/headless-tool-batch';
import { resolveProvider } from '../providers/store';
import { getSubAgentTypeConfig } from './sub-agent-config';
import { resolveSamplerPreset } from './resolve-sampler';
import { resolveThinkingMode, resolveThinkingBudgetTokens } from './resolve-thinking';
import {
  getToolCallsMetaSync,
  isConstrainedDecodingEnabledForProvider,
  loadToolCallsMeta,
} from '../config/tool-calls-meta';
import {
  isStructuredOutcomeResponseFormatAvailable,
  readProviderCapabilities,
} from '../providers/capability-probe';
import { resolveSendCapabilities } from '../providers/model-capabilities';
import { getModelRowForSelectOrCanonicalId } from '../api/models';
import { contextLengthFromModelRow } from '../lib/context-length';
import { applyContextPolicy } from '../chat/context/apply-policy';
import { canSendImagesToModel } from '../providers/vision-model';
import { recordSubAgentTurnUsage } from '../usage/record-chat-usage';
import { reportBackgroundError } from '../boot/report-background-error';
import { createSessionTranscriptStore } from './session-transcript-store';
import type { TranscriptStore } from '../../server/runner/transcript-store';
import type {
  PostChatCompletionsOptions,
  RunnerDeps,
  RunnerProvider,
} from '../../server/runner/adapters';

function resolveModelContextLimit(modelId: string): number | null {
  const id = modelId.trim();
  if (!id) return null;
  const cached = getModelRowForSelectOrCanonicalId(id);
  if (!cached) return null;
  return contextLengthFromModelRow(cached) ?? null;
}

export function createRendererRunnerDeps(
  transcriptStore: TranscriptStore = createSessionTranscriptStore(),
): RunnerDeps {
  return {
    transcriptStore,
    postChatCompletions: (
      provider: RunnerProvider,
      body: Record<string, unknown>,
      signal: AbortSignal,
      options?: PostChatCompletionsOptions,
    ) =>
      postChatCompletions(
        provider as unknown as Parameters<typeof postChatCompletions>[0],
        body as unknown as Parameters<typeof postChatCompletions>[1],
        signal,
        options,
      ),
    runHeadlessToolBatch: (options: Parameters<RunnerDeps['runHeadlessToolBatch']>[0]) =>
      runHeadlessToolBatch(options as unknown as Parameters<typeof runHeadlessToolBatch>[0]),
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
    resolveModelContextLimit,
    getModelRow: getModelRowForSelectOrCanonicalId,
    applyContextPolicy,
    isVisionModel: canSendImagesToModel,
    recordTurnUsage: async (input: unknown, turn: unknown) => {
      const parentChatId =
        input && typeof input === 'object' && 'parentChatId' in input
          ? (input as { parentChatId?: string | null }).parentChatId
          : undefined;
      await recordSubAgentTurnUsage(
        parentChatId,
        turn as Parameters<typeof recordSubAgentTurnUsage>[1],
      );
    },
    reportBackgroundError,
  } as unknown as RunnerDeps;
}
