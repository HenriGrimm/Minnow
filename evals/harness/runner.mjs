import { runTurn } from '../../server/runner/run-turn.js';
import { createMemoryTranscriptStore } from '../../server/runner/transcript-store.js';
import { executeToolCallBatch } from '../../server/runner/tool-batch.js';
import { applyServerContextPolicy } from '../../server/runner/context-budget.js';
import { headlessToolDefinitions } from '../../server/tools/headless-tool-defs.js';
import { benchmarkPrompt } from './prompt.ts';
import fs from 'node:fs';

export const profiles = JSON.parse(fs.readFileSync(new URL('./profiles.json', import.meta.url), 'utf8'));

/** The product loop, with only transport and sandbox ownership supplied by the evaluator. */
export async function evaluate(config, { complete, execute, event = () => {} }) {
  const profile = profiles[config.profile];
  if (!profile) throw new Error(`Unknown profile: ${config.profile}`);
  for (const key of ['maxSteps', 'timeoutSeconds', 'contextWindow', 'maxTokens']) {
    if (!Number.isSafeInteger(config[key]) || config[key] <= 0) throw new Error(`${key} must be a positive integer`);
  }
  if (!config.model || !config.workspace || !config.instruction) throw new Error('model, workspace and instruction are required');
  const transcriptStore = createMemoryTranscriptStore();
  if (config.history !== undefined && !Array.isArray(config.history)) throw new Error('history must be an array');
  for (const row of config.history ?? []) transcriptStore.append('benchmark', row);
  const systemPrompt = benchmarkPrompt(profile.prompt, config.workspace, profile.tools);
  const tools = headlessToolDefinitions(profile.tools);
  const sampler = { preset: config.sampler ?? {}, maxTokens: config.maxTokens };
  const started = Date.now();
  const metrics = { rounds: 0, toolCalls: 0, toolErrors: 0, compactions: 0, peakContext: 0 };
  event({ type: 'configuration', config, systemPrompt, tools, lazyTools: profile.lazyTools,
    scope: 'shared-runner; shipped Build composer; isolated server-tool subset; no desktop, Brain, skills, or subagents' });
  const deps = {
    transcriptStore, postChatCompletions: complete,
    runHeadlessToolBatch: executeToolCallBatch,
    resolveProvider: async () => ({ id: 'benchmark', baseUrl: 'https://benchmark.invalid', apiKind: 'openai-v1' }),
    getSubAgentTypeConfig: async () => ({}), resolveSamplerPreset: () => sampler,
    resolveThinkingMode: () => ({ mode: 'off' }), resolveThinkingBudgetTokens: () => ({ budgetTokens: null }),
    loadToolCallsMeta: async () => {}, getToolCallsMetaSync: () => ({ useConstrainedDecoding: false }),
    isConstrainedDecodingEnabledForProvider: () => false, readProviderCapabilities: async () => null,
    isStructuredOutcomeResponseFormatAvailable: () => false, resolveSendCapabilities: () => ({}),
    resolveModelContextLimit: () => config.contextWindow,
    applyContextPolicy: async input => applyServerContextPolicy(input),
  };
  const result = await runTurn({
    chatId: 'benchmark', seed: config.instruction, messages: config.history, cwd: config.workspace, systemPrompt,
    messageRowIds: config.history?.map((_, index) => index),
    tools, lazyTools: profile.lazyTools, model: { providerId: 'benchmark', id: config.model, sampler },
    deps, execute, ask: null, injectReportTool: false, nudgeToolUse: false,
    finalizeStructuredOutcome: false,
    limits: { maxTurns: config.maxSteps, wallClockMs: config.timeoutSeconds * 1000,
      modelContextLimit: config.contextWindow, contextBudget: { enforcementPolicy: 'compact' } },
    onEvent(e) {
      if (e.type === 'round_end') metrics.rounds++;
      if (e.type === 'tool_call') metrics.toolCalls++;
      if (e.type === 'tool_result' && (e.isError || /^Error:/i.test(e.content))) metrics.toolErrors++;
      if (e.type === 'context_compaction') metrics.compactions++;
      if (e.type === 'context_usage') metrics.peakContext = Math.max(metrics.peakContext, e.used);
      event(e);
    },
  });
  return { version: 1, result, metrics: { ...metrics, durationMs: Date.now() - started },
    // Completion is not correctness. Only the benchmark verifier assigns reward.
    reward: null, transcript: transcriptStore.load('benchmark') };
}
