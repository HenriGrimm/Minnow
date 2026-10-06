/**
 * Benchmark completion body builder — mirrors main-chat request shaping with fixed constants.
 */

import { applySamplerToBody, type SamplerPreset } from '../agents/sampler-types.ts';
import { mergeThinkingIntoCompletionBody } from '../agents/merge-thinking-body.ts';
import { DEFAULT_LLAMA_THINKING_BUDGET_TOKENS } from '../agents/thinking-types.ts';
import type { ChatCompletionBody } from '../api/chat.ts';
import { DEFAULT_SAMPLER_GLOBAL } from '../config/sampler-meta.ts';
import {
  getToolCallsMetaSync,
  isConstrainedDecodingEnabledForProvider,
  type ToolCallsMeta,
} from '../config/tool-calls-meta.ts';
import type { ProviderCapabilities } from '../providers/capability-probe.ts';
import { applyConstrainedToolCallsToBody } from '../providers/constrained-tool-calls.ts';
import type { ProviderPublic } from '../providers/types.ts';
import { LLAMA_CPP_LOCAL_PROVIDER_ID } from '../providers/types.ts';
import type { OpenAIFunctionDefinition } from '../tools/definitions.ts';
import type { ApiMessage, ModelCapabilities, ReasoningEffortOption } from '../types.ts';

/** Fixed sampler recipe seeded from {@link DEFAULT_SAMPLER_GLOBAL} (not live chat settings). */
export const BENCHMARK_SAMPLER: SamplerPreset = {
  temperature: DEFAULT_SAMPLER_GLOBAL.temperature ?? 1.0,
  topP: DEFAULT_SAMPLER_GLOBAL.topP ?? 0.95,
  topK: DEFAULT_SAMPLER_GLOBAL.topK ?? 20,
};

/** Matches the main-chat default max tokens. */
export const BENCHMARK_MAX_TOKENS = DEFAULT_SAMPLER_GLOBAL.maxTokens ?? 131072;

/** Pinned thinking effort for every capability-matrix target. */
export const BENCHMARK_THINKING_EFFORT: ReasoningEffortOption = 'medium';

/**
 * Fallback per-request thinking budget when the caller resolves none.
 *
 * Prefer passing a wall-clock-derived budget (see `thinking-budget-policy.ts`) — this flat
 * figure is chat's, and on a slow local target it is larger than a probe timeout allows.
 */
export const BENCHMARK_THINKING_BUDGET_TOKENS = DEFAULT_LLAMA_THINKING_BUDGET_TOKENS;

export interface BuildBenchmarkCompletionBodyInput {
  provider: Pick<ProviderPublic, 'id' | 'apiKind' | 'autoApi' | 'modelApiOverrides' | 'constrainedToolCalls'>;
  modelId: string;
  messages: ApiMessage[];
  tools?: OpenAIFunctionDefinition[];
  capabilities?: ModelCapabilities | null;
  providerCapabilities?: ProviderCapabilities | null;
  toolCallsMeta?: ToolCallsMeta;
  /** Caller override (speed suite, etc.) — wins over {@link BENCHMARK_MAX_TOKENS}. */
  maxTokens?: number;
  /** Caller override — wins over {@link BENCHMARK_SAMPLER}.temperature. */
  temperature?: number;
  /**
   * Effort override — wins over {@link BENCHMARK_THINKING_EFFORT}. `'off'` is how the
   * watchdog's commit retry disables thinking: on local runtimes it is the only switch
   * that reliably lands, since it carries `chat_template_kwargs.enable_thinking: false`.
   */
  thinkingEffort?: ReasoningEffortOption;
  /** Wall-clock-derived budget — wins over {@link BENCHMARK_THINKING_BUDGET_TOKENS}. */
  thinkingBudgetTokens?: number;
}

export interface BuildBenchmarkCompletionBodyResult {
  body: ChatCompletionBody & { stream: true; stream_options: { include_usage: boolean } };
  usedConstrained: boolean;
  nativeBudgetApplied: boolean;
}

/**
 * Pure builder: apply sampler, thinking, and constrained tool decoding like main chat.
 */
export function buildBenchmarkCompletionBody(
  input: BuildBenchmarkCompletionBodyInput,
): BuildBenchmarkCompletionBodyResult {
  const maxTokens = input.maxTokens ?? BENCHMARK_MAX_TOKENS;
  const samplerPreset: SamplerPreset =
    input.temperature !== undefined
      ? { ...BENCHMARK_SAMPLER, temperature: input.temperature }
      : BENCHMARK_SAMPLER;

  const body = applySamplerToBody(
    {
      model: input.modelId || undefined,
      messages: input.messages,
      stream: true as const,
      stream_options: { include_usage: true },
    },
    samplerPreset,
    maxTokens,
  ) as ChatCompletionBody & { stream: true; stream_options: { include_usage: boolean } };

  const llamaSupportsThinkingBudget =
    input.provider.id === LLAMA_CPP_LOCAL_PROVIDER_ID &&
    input.providerCapabilities?.supportsThinkingBudget === true;

  const effort = input.thinkingEffort ?? BENCHMARK_THINKING_EFFORT;
  const budgetTokens = input.thinkingBudgetTokens ?? BENCHMARK_THINKING_BUDGET_TOKENS;

  const { nativeBudgetApplied } = mergeThinkingIntoCompletionBody(
    body as unknown as Record<string, unknown>,
    effort === 'off' ? 'off' : 'on',
    input.provider,
    input.capabilities ?? undefined,
    effort,
    undefined,
    effort === 'off' ? null : budgetTokens,
    { llamaSupportsThinkingBudget },
  );

  const tools = input.tools ?? [];
  let usedConstrained = false;
  if (tools.length > 0) {
    body.tools = tools;
    body.tool_choice = 'auto';
    const toolCallsMeta = input.toolCallsMeta ?? getToolCallsMetaSync();
    const constrainedUserEnabled = isConstrainedDecodingEnabledForProvider(
      input.provider,
      toolCallsMeta,
    );
    const constrainedApplied = applyConstrainedToolCallsToBody(body, {
      providerId: input.provider.id,
      modelId: input.modelId,
      userEnabled: constrainedUserEnabled,
      capabilities: input.providerCapabilities ?? null,
      enabledTools: tools,
    });
    Object.assign(body, constrainedApplied.body);
    usedConstrained = constrainedApplied.usedConstrained;
  }

  return { body, usedConstrained, nativeBudgetApplied };
}
