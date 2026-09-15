/**
 * Hosted llama.cpp second-turn hang: 32k window + 32k maxTokens must still send.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { proseSseChunks } from '../../scripts/fake-model-server.mjs';
import {
  createMemoryTranscriptStore,
  runTurn,
} from '../../server/runner/index.js';
import { LOCAL_PROMPT_FLOOR_TOKENS } from '../../server/runner/context-budget.js';
import { resetContextEstimateCalibrationForTests } from '../../server/runner/estimate-calibration.js';

const CHAT_UUID = '22222222-2222-2222-2222-222222222222';

const SECOND_TURN = [
  { role: 'system', content: 'You are a helpful assistant.' },
  { role: 'user', content: 'hi' },
  { role: 'assistant', content: 'hello' },
  { role: 'user', content: 'hello again' },
];

function sseResponse(chunks) {
  return new Response(chunks.join(''), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

async function passthroughBatch(options) {
  const toolCalls = options.toolCalls ?? [];
  const outcomes = [];
  for (const toolCall of toolCalls) {
    let args = {};
    try {
      args = JSON.parse(toolCall.function?.arguments || '{}');
    } catch {
      args = {};
    }
    const result = await options.execute(toolCall.function.name, args, {
      toolCallId: toolCall.id,
    });
    const outcome = { toolCall, result };
    options.onToolDone?.(outcome);
    outcomes.push(outcome);
  }
  return outcomes;
}

function stubDeps(overrides = {}) {
  return {
    transcriptStore: createMemoryTranscriptStore(),
    postChatCompletions: async () => sseResponse(proseSseChunks('Done.')),
    runHeadlessToolBatch: passthroughBatch,
    resolveProvider: async () => ({
      id: 'llama-cpp-local',
      label: 'llama.cpp (local)',
      baseUrl: 'http://127.0.0.1:9',
      apiKind: 'openai-v1',
      chatCompletionsPath: '/v1/chat/completions',
    }),
    getSubAgentTypeConfig: async () => ({}),
    resolveSamplerPreset: () => ({ preset: {}, maxTokens: 32768 }),
    resolveThinkingMode: () => ({ mode: 'off' }),
    resolveThinkingBudgetTokens: () => ({ budgetTokens: null }),
    loadToolCallsMeta: async () => {},
    getToolCallsMetaSync: () => ({ useConstrainedDecoding: false }),
    isConstrainedDecodingEnabledForProvider: () => false,
    readProviderCapabilities: async () => null,
    isStructuredOutcomeResponseFormatAvailable: () => false,
    resolveSendCapabilities: () => ({}),
    resolveModelContextLimit: () => 32768,
    applyContextPolicy: async (input) => ({
      applied: false,
      messages: input.messages,
    }),
    ...overrides,
  };
}

const chatTurn = {
  injectReportTool: false,
  nudgeToolUse: false,
  finalizeStructuredOutcome: false,
};

describe('runTurn hosted llama.cpp second turn', () => {
  afterEach(() => {
    resetContextEstimateCalibrationForTests();
  });

  test('32k window plus 32k maxTokens still sends the second user message', async () => {
    let posts = 0;
    let seenMaxTokens = null;
    const result = await runTurn({
      chatId: CHAT_UUID,
      seed: '',
      seedKind: 'continue',
      messages: SECOND_TURN,
      tools: [],
      model: {
        providerId: 'llama-cpp-local',
        id: 'gguf:test',
        sampler: { preset: {}, maxTokens: 32768 },
      },
      limits: { modelContextLimit: 32768 },
      ...chatTurn,
      deps: stubDeps({
        postChatCompletions: async (_provider, body) => {
          posts += 1;
          seenMaxTokens = body.max_tokens;
          return sseResponse(proseSseChunks('Hello back.'));
        },
      }),
    });
    assert.equal(result.outcome, 'no_report');
    assert.equal(posts, 1, 'the main turn must reach the provider');
    assert.equal(typeof seenMaxTokens, 'number');
    assert.ok(
      seenMaxTokens < 32768,
      `request max_tokens ${seenMaxTokens} must be capped below Settings max`,
    );
    assert.ok(
      seenMaxTokens > LOCAL_PROMPT_FLOOR_TOKENS,
      `request max_tokens ${seenMaxTokens} should still leave room to generate`,
    );
  });

  test('70k window plus 32k maxTokens still sends a bulky prompt', async () => {
    let posts = 0;
    const bulky = [
      { role: 'system', content: `You are a helpful assistant.\n${'s'.repeat(120_000)}` },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'hello again' },
    ];
    const result = await runTurn({
      chatId: CHAT_UUID,
      seed: '',
      seedKind: 'continue',
      messages: bulky,
      tools: [],
      model: {
        providerId: 'llama-cpp-local',
        id: 'gguf:test',
        sampler: { preset: {}, maxTokens: 32768 },
      },
      limits: { modelContextLimit: 70_000 },
      ...chatTurn,
      deps: stubDeps({
        postChatCompletions: async () => {
          posts += 1;
          return sseResponse(proseSseChunks('Hello back.'));
        },
      }),
    });
    assert.equal(result.outcome, 'no_report');
    assert.equal(posts, 1, 'a 70k window must not crash a prompt the wheel would show as roomy');
  });

  test('compact that cannot shrink crashes instead of no_report', async () => {
    let posts = 0;
    const result = await runTurn({
      chatId: CHAT_UUID,
      seed: 'x'.repeat(8000),
      tools: [],
      model: { providerId: 'local-fake', id: 'qwen' },
      // A deps policy that cannot shrink; the default compact hard-truncates as a last resort.
      limits: { modelContextLimit: 32, contextBudget: { enforcementPolicy: 'slide' } },
      ...chatTurn,
      deps: stubDeps({
        resolveProvider: async () => ({
          id: 'local-fake',
          label: 'Local fake',
          baseUrl: 'http://127.0.0.1:9',
          apiKind: 'openai-v1',
          chatCompletionsPath: '/v1/chat/completions',
        }),
        resolveSamplerPreset: () => ({ preset: {}, maxTokens: 256 }),
        applyContextPolicy: async (input) => ({
          applied: false,
          messages: input.messages,
        }),
        postChatCompletions: async () => {
          posts += 1;
          throw new Error('should not send when the prompt cannot fit');
        },
      }),
    });
    assert.equal(result.outcome, 'crashed');
    assert.match(String(result.error), /context budget exceeded/);
    assert.equal(posts, 0);
  });
});
