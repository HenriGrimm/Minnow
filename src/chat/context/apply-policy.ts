import type { ApiMessage } from '../../types';
import {
  applyContextBudget,
  estimateApiMessageTokens,
  estimateApiMessagesTokens,
  resolveContextBudget,
  type AgentContextBudgetConfig,
  type ApplyContextBudgetResult,
  type ContextEnforcementPolicy,
  type ResolvedContextBudget,
} from '../context-budget';
import {
  compactMessages,
  projectMessages,
  resolveCompactionConfig,
  type CompactionCheckpoint,
} from '../../../server/runner/compaction/index.js';

export interface ApplyContextPolicyParams {
  messages: ApiMessage[];
  policy: ContextEnforcementPolicy;
  modelLimit: number | null;
  agentConfig: AgentContextBudgetConfig;
  providerId: string;
  modelId: string;
  signal?: AbortSignal;
  onStatus?: (level: 'spin' | 'ok', message: string) => void;
  /** Tokens the request spends outside `messages` (tool schemas in `body.tools`). */
  reservedTokens?: number;
  /** Force the message ceiling — used by compact-and-retry with provider-measured numbers. */
  effectiveLimitOverride?: number | null;
}

export type ApplyContextPolicyResult = ApplyContextBudgetResult;

/**
 * `RunnerDeps.applyContextPolicy` for the renderer. Every policy is sync and
 * makes no completion call: the turn loop runs `compact` itself (it keeps the
 * checkpoint across rounds), so this path sees slide / truncate, and a
 * stateless compact for callers outside a turn.
 */
export async function applyContextPolicy(
  params: ApplyContextPolicyParams,
): Promise<ApplyContextPolicyResult> {
  const resolved = resolveContextBudget({
    agentConfig: params.agentConfig,
    modelLimit: params.modelLimit,
    reservedTokens: params.reservedTokens,
    effectiveLimitOverride: params.effectiveLimitOverride,
  });
  return applyContextBudget(params.messages, resolved, params.agentConfig);
}

export interface EstimateContextPolicyTrimResult {
  /** Estimated message tokens after the policy (system rows included). */
  historyTokens: number;
  /** Tokens of the compaction summary inside {@link historyTokens}. */
  compressedEstimateTokens: number;
  wouldCompress: boolean;
}

export interface EstimateContextPolicyTrimOptions {
  /** Row ids aligned with `messages` (history indices). Needed to apply a persisted checkpoint. */
  ids?: Array<number | null>;
  /** Latest persisted checkpoint for the chat. */
  checkpoint?: CompactionCheckpoint | null;
}

function summaryRowTokens(summary: string | undefined): number {
  return summary ? estimateApiMessageTokens({ role: 'user', content: summary }) : 0;
}

/**
 * Sync estimate of what the next send puts on the wire, for the context ring.
 * `compact` projects through the persisted checkpoint first, then predicts the
 * checkpoint the send would take — the same code path the turn loop runs.
 */
export function estimateContextPolicyTrim(
  messages: ApiMessage[],
  resolved: ResolvedContextBudget,
  agentConfig?: AgentContextBudgetConfig,
  options: EstimateContextPolicyTrimOptions = {},
): EstimateContextPolicyTrimResult {
  const limit = resolved.effectiveLimit;
  if (resolved.policy !== 'compact') {
    const tokensBefore = estimateApiMessagesTokens(messages);
    if (limit == null || tokensBefore <= limit) {
      return { historyTokens: tokensBefore, compressedEstimateTokens: 0, wouldCompress: false };
    }
    const applied = applyContextBudget(messages, resolved, agentConfig);
    return { historyTokens: applied.tokensAfter, compressedEstimateTokens: 0, wouldCompress: applied.applied };
  }

  const ids = options.ids ?? messages.map((_, i) => i);
  const checkpoint = options.checkpoint ?? null;
  const projected = checkpoint ? projectMessages(messages, ids, checkpoint) : { messages, ids };
  const projectedTokens = estimateApiMessagesTokens(projected.messages);
  const currentSummary = summaryRowTokens(checkpoint?.summary);
  if (limit == null) {
    return { historyTokens: projectedTokens, compressedEstimateTokens: currentSummary, wouldCompress: Boolean(checkpoint) };
  }
  const config = resolveCompactionConfig(agentConfig, resolved.modelLimit ?? limit);
  if (projectedTokens <= Math.floor(limit * config.highWater)) {
    return { historyTokens: projectedTokens, compressedEstimateTokens: currentSummary, wouldCompress: Boolean(checkpoint) };
  }
  const originals = new Map<number, ApiMessage>();
  messages.forEach((row, i) => {
    const id = ids[i];
    if (id != null) originals.set(id, row);
  });
  const byRow = new Map<ApiMessage, number | null>();
  projected.messages.forEach((row, i) => byRow.set(row, projected.ids[i] ?? null));
  const out = compactMessages({
    messages: projected.messages,
    limit,
    window: resolved.modelLimit,
    config,
    prev: checkpoint,
    idOf: (row) => byRow.get(row),
    originalOf: (id) => originals.get(id),
  });
  return {
    historyTokens: out.tokensAfter,
    compressedEstimateTokens: summaryRowTokens(out.checkpoint?.summary ?? checkpoint?.summary),
    wouldCompress: out.changed || Boolean(checkpoint),
  };
}
