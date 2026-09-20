/**
 * P2-A — a runner with an in-memory TranscriptStore completes a turn against
 * the same OpenAI-v1 fake host that `server/orchestrate/board-testing/fake-model-host.js`
 * wraps. No `src/state/sessions.ts` is present.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import {
  createFakeModelServer,
  proseSseChunks,
} from '../../scripts/fake-model-server.mjs';
import {
  createMemoryTranscriptStore,
  createTurnRunner,
  postChatCompletionsHttp,
  runHeadlessToolBatchStub,
} from '../../server/runner/index.js';

const OUTCOME_JSON = JSON.stringify({
  summary: 'Turn completed against the fake host.',
  findings: [],
  artifacts: [],
});

describe('in-memory TranscriptStore + fake model host', () => {
  const fake = createFakeModelServer({
    scenario: [{ emit: proseSseChunks(OUTCOME_JSON) }],
  });
  /** @type {string} */
  let baseUrl = '';

  before(async () => {
    fake.reset();
    const port = await fake.listen(0);
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await fake.close();
  });

  test('load / append / setMeta round-trip without a session store', () => {
    const store = createMemoryTranscriptStore();
    assert.equal(store.load('missing'), null);
    store.setMeta('chat-1', { thinkingMode: 'off', reasoningEffort: 'medium' });
    store.append('chat-1', { role: 'user', content: 'hello' });
    const row = store.load('chat-1');
    assert.ok(row);
    assert.equal(row.meta.thinkingMode, 'off');
    assert.equal(row.messages.length, 1);
    assert.equal(row.messages[0].content, 'hello');
  });

  test('createTurnRunner completes a turn with no sessions.ts', { timeout: 20_000 }, async () => {
    const transcriptStore = createMemoryTranscriptStore();
    const runner = createTurnRunner({
      transcriptStore,
      postChatCompletions: postChatCompletionsHttp,
      runHeadlessToolBatch: runHeadlessToolBatchStub,
      resolveProvider: async () => ({
        id: 'fake-board',
        label: 'Fake board model',
        baseUrl,
        apiKind: 'openai-v1',
        chatCompletionsPath: '/v1/chat/completions',
      }),
      getSubAgentTypeConfig: async () => ({}),
      resolveSamplerPreset: () => ({ preset: {}, maxTokens: 256 }),
      resolveThinkingMode: () => ({ mode: 'off' }),
      resolveThinkingBudgetTokens: () => ({ budgetTokens: null }),
      loadToolCallsMeta: async () => {},
      getToolCallsMetaSync: () => ({ useConstrainedDecoding: false }),
      isConstrainedDecodingEnabledForProvider: () => false,
      readProviderCapabilities: async () => null,
      isStructuredOutcomeResponseFormatAvailable: () => false,
      resolveSendCapabilities: () => ({}),
      resolveModelContextLimit: () => null,
      applyContextPolicy: async (input) => ({
        applied: false,
        messages: input.messages,
      }),
    });

    const output = await runner.run({
      runId: 'run-memory-1',
      type: 'explore',
      task: 'Say hello in one sentence.',
      systemPrompt: 'You are a test sub-agent.',
      tools: [],
      providerId: 'fake-board',
      modelId: 'fake-board-model',
      signal: new AbortController().signal,
      executeTool: async () => ({ content: '' }),
    });

    assert.equal(output.summary, 'Turn completed against the fake host.');
    assert.equal(output.toolTurns, 0);
    assert.ok(Array.isArray(output.messages));
    assert.equal(transcriptStore.load('unused'), null);
  });

  test('type turn uses work-agent sampler kind and not the 2048 fallback', { timeout: 20_000 }, async () => {
    const seen = [];
    const transcriptStore = createMemoryTranscriptStore();
    const runner = createTurnRunner({
      transcriptStore,
      postChatCompletions: postChatCompletionsHttp,
      runHeadlessToolBatch: runHeadlessToolBatchStub,
      resolveProvider: async () => ({
        id: 'fake-board',
        label: 'Fake board model',
        baseUrl,
        apiKind: 'openai-v1',
        chatCompletionsPath: '/v1/chat/completions',
      }),
      getSubAgentTypeConfig: async () => ({}),
      resolveSamplerPreset: (input) => {
        seen.push(input);
        return { preset: {}, maxTokens: input.global?.maxTokens ?? 0 };
      },
      resolveThinkingMode: () => ({ mode: 'off' }),
      resolveThinkingBudgetTokens: () => ({ budgetTokens: null }),
      loadToolCallsMeta: async () => {},
      getToolCallsMetaSync: () => ({ useConstrainedDecoding: false }),
      isConstrainedDecodingEnabledForProvider: () => false,
      readProviderCapabilities: async () => null,
      isStructuredOutcomeResponseFormatAvailable: () => false,
      resolveSendCapabilities: () => ({}),
      resolveModelContextLimit: () => null,
      applyContextPolicy: async (input) => ({
        applied: false,
        messages: input.messages,
      }),
    });

    await runner.run({
      runId: 'run-turn-sampler',
      type: 'turn',
      task: 'Say hello.',
      systemPrompt: 'You are a test.',
      tools: [],
      providerId: 'fake-board',
      modelId: 'fake-board-model',
      signal: new AbortController().signal,
      executeTool: async () => ({ content: '' }),
    });

    assert.equal(seen.length >= 1, true);
    assert.equal(seen[0].kind, 'work-agent');
    assert.notEqual(seen[0].global.maxTokens, 2048);
    const { DEFAULT_AGENT_MAX_TOKENS } = await import('../../server/runner/sampler-types.js');
    assert.equal(seen[0].global.maxTokens, DEFAULT_AGENT_MAX_TOKENS);
  });
});
