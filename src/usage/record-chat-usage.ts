/**
 * Record provider-reported usage on a chat ledger with pricing lookup.
 */

import { finalizeResponseMeta, type StreamMetaAccumulator } from '../api/chat';
import { normalizeModeId } from '../chat/modes/types';
import { findChatById } from '../state/sessions';
import { listProviders } from '../providers/store';
import type { Chat, Stats, Usage } from '../types';
import { computeCostUsd, hasMeasurableUsage, resolveModelPricing } from './pricing';
import { recordTokenUsage, type RecordTokenUsageInput } from './token-ledger';
import type { TokenLedgerWriteSource } from './types.ts';

export interface RecordChatCompletionUsageInput {
  source: TokenLedgerWriteSource;
  providerId: string;
  modelId: string;
  usage: Usage;
  reportedCostUsd?: number;
  stats?: Stats;
  id?: string;
  at?: number;
}

/** Resolve provider pricing from the cached registry and append a ledger row. */
export async function recordChatCompletionUsage(
  chat: Chat,
  input: RecordChatCompletionUsageInput,
): Promise<void> {
  if (!hasMeasurableUsage(input.usage)) return;

  let pricing = null;
  try {
    const { providers } = await listProviders();
    pricing = providers.find((p) => p.id === input.providerId)?.pricing ?? null;
  } catch {
    pricing = null;
  }

  const rates = resolveModelPricing(pricing, input.modelId);
  const costUsd = input.reportedCostUsd != null && Number.isFinite(input.reportedCostUsd) && input.reportedCostUsd >= 0
    ? input.reportedCostUsd : computeCostUsd(input.usage, rates);

  const payload: RecordTokenUsageInput = {
    source: input.source,
    providerId: input.providerId,
    modelId: input.modelId,
    usage: input.usage,
    costUsd,
    ...(input.stats ? { stats: input.stats } : {}),
    ...(input.id ? { id: input.id } : {}),
    ...(input.at != null ? { at: input.at } : {}),
  };

  recordTokenUsage(chat, payload);
}

/** Synchronous record when pricing is already known (unit tests). */
export function recordChatCompletionUsageWithPricing(
  chat: Chat,
  input: RecordChatCompletionUsageInput,
  pricing: import('./types').ProviderPricing | null | undefined,
): void {
  if (!hasMeasurableUsage(input.usage)) return;
  const rates = resolveModelPricing(pricing, input.modelId);
  const costUsd = input.reportedCostUsd != null && Number.isFinite(input.reportedCostUsd) && input.reportedCostUsd >= 0
    ? input.reportedCostUsd : computeCostUsd(input.usage, rates);
  recordTokenUsage(chat, {
    ...input,
    costUsd,
    ...(input.stats ? { stats: input.stats } : {}),
  });
}

/** Record one main-chat streamed turn (tool loop or legacy send). */
export async function recordMainChatTurnUsage(
  chat: Chat,
  opts: {
    providerId: string;
    modelId: string;
    streamMeta: StreamMetaAccumulator;
    t0: number;
    tFirst: number | null;
    tEnd: number;
    workAgentId?: string | null;
  },
): Promise<void> {
  const usage = opts.streamMeta.usage;
  if (!hasMeasurableUsage(usage)) return;
  const measuredUsage = usage as Usage;
  const { stats } = finalizeResponseMeta(
    opts.streamMeta,
    opts.t0,
    opts.tFirst ?? opts.tEnd,
    opts.tEnd,
  );
  await recordChatCompletionUsage(chat, {
    source: {
      kind: 'main',
      modeId: normalizeModeId(chat.modeId),
      workAgentId: opts.workAgentId ?? chat.workAgentId ?? null,
    },
    providerId: opts.providerId,
    modelId: opts.modelId,
    usage: measuredUsage,
    reportedCostUsd: opts.streamMeta.minnow_cli?.cost_usd,
    stats,
  });
}

/** Record a sub-agent LLM turn on the parent chat ledger. */
export async function recordSubAgentTurnUsage(
  parentChatId: string | null | undefined,
  opts: {
    subAgentType: string;
    runId: string;
    providerId: string;
    modelId: string;
    streamMeta: StreamMetaAccumulator;
    t0: number;
    tFirst: number | null;
    tEnd: number;
  },
): Promise<void> {
  const chatId = parentChatId?.trim();
  if (!chatId) return;
  const chat = findChatById(chatId);
  if (!chat) return;
  const usage = opts.streamMeta.usage;
  if (!hasMeasurableUsage(usage)) return;
  const measuredUsage = usage as Usage;
  const { stats } = finalizeResponseMeta(
    opts.streamMeta,
    opts.t0,
    opts.tFirst ?? opts.tEnd,
    opts.tEnd,
  );
  await recordChatCompletionUsage(chat, {
    source: {
      kind: 'sub-agent',
      subAgentType: opts.subAgentType,
      runId: opts.runId,
    },
    providerId: opts.providerId,
    modelId: opts.modelId,
    usage: measuredUsage,
    reportedCostUsd: opts.streamMeta.minnow_cli?.cost_usd,
    stats,
  });
}
