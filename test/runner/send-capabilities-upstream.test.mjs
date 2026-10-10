/**
 * The runner sanitizes each request with the model's send capabilities, then
 * the generations store sanitizes it again right before the wire. That second
 * pass used to run capability-blind and strip the reasoning effort the user
 * picked in the composer from every hosted OpenAI-compatible model.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import { createFakeModelServer } from '../../scripts/fake-model-server.mjs';
import { setTestHome, rmTestHome } from '../config/test-helpers.js';
import { ensureMinnowLayout } from '../../server/config/home.js';
import { createProvider } from '../../server/providers/store.js';
import {
  createMemoryTranscriptStore,
  DEFAULT_REPORT_TOOL_NAME,
  postChatCompletionsInProcess,
  runHeadlessToolBatchStub,
  runTurn,
} from '../../server/runner/node.js';
import { deleteGenerationsForProviderShutdown } from '../../server/generations/store.js';

const PROVIDER_ID = 'hosted-fake';
const CHAT_UUID = '550e8400-e29b-41d4-a716-446655440001';

const REASONING_CAPS = {
  reasoning: true,
  reasoningAllowedOptions: ['low', 'medium', 'high'],
  reasoningDefault: 'high',
};

function reportChunks() {
  const delta = JSON.stringify({
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          id: 'call_report',
          type: 'function',
          function: {
            name: DEFAULT_REPORT_TOOL_NAME,
            arguments: JSON.stringify({ outcome: 'pass', summary: 'done', evidence: ['ok'] }),
          },
        }],
      },
    }],
  });
  return [
    `data: ${delta}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`,
    'event: end\ndata: {"status":"complete"}\n\n',
  ];
}

function stubDeps(baseUrl, sendCaps) {
  return {
    transcriptStore: createMemoryTranscriptStore(),
    postChatCompletions: postChatCompletionsInProcess,
    runHeadlessToolBatch: runHeadlessToolBatchStub,
    resolveProvider: async () => ({
      id: PROVIDER_ID,
      label: 'Hosted fake',
      baseUrl,
      apiKind: 'openai-v1',
      chatCompletionsPath: '/v1/chat/completions',
    }),
    getSubAgentTypeConfig: async () => ({}),
    resolveSamplerPreset: () => ({ preset: {}, maxTokens: 256 }),
    resolveThinkingMode: () => ({ mode: 'on' }),
    resolveThinkingBudgetTokens: () => ({ budgetTokens: null }),
    loadToolCallsMeta: async () => {},
    getToolCallsMetaSync: () => ({ useConstrainedDecoding: false }),
    isConstrainedDecodingEnabledForProvider: () => false,
    readProviderCapabilities: async () => null,
    isStructuredOutcomeResponseFormatAvailable: () => false,
    resolveSendCapabilities: () => sendCaps,
    resolveModelContextLimit: () => null,
    applyContextPolicy: async (input) => ({ applied: false, messages: input.messages }),
  };
}

describe('send capabilities reach the upstream sanitizer', { concurrency: false }, () => {
  const fake = createFakeModelServer({ scenario: [{ emit: reportChunks() }] });
  let homeDir = '';
  let baseUrl = '';

  before(async () => {
    homeDir = setTestHome(process.env, 'minnow-test-send-caps-upstream');
    await ensureMinnowLayout();
    const port = await fake.listen(0);
    baseUrl = `http://127.0.0.1:${port}`;
    await createProvider({ id: PROVIDER_ID, label: 'Hosted fake', baseUrl, apiKind: 'openai-v1' });
  });

  afterEach(() => {
    deleteGenerationsForProviderShutdown();
    fake.reset();
  });

  after(async () => {
    deleteGenerationsForProviderShutdown();
    await fake.close();
    await rmTestHome(homeDir);
  });

  async function upstreamBodyFor(sendCaps) {
    await runTurn({
      chatId: CHAT_UUID,
      seed: 'Do the work, then report.',
      tools: [],
      model: { providerId: PROVIDER_ID, id: 'vendor/reasoner' },
      deps: stubDeps(baseUrl, sendCaps),
    });
    const posts = fake.requests.filter((r) => r.method === 'POST');
    assert.ok(posts.length > 0, 'expected the turn to reach the fake host');
    return posts[0].body;
  }

  test('a reasoning model keeps its reasoning effort on the wire', { timeout: 20_000 }, async () => {
    const body = await upstreamBodyFor(REASONING_CAPS);
    assert.equal(body.reasoning_effort, 'high');
  });

  test('a model with no known reasoning support still has it stripped', { timeout: 20_000 }, async () => {
    const body = await upstreamBodyFor(undefined);
    assert.equal('reasoning_effort' in body, false);
    assert.equal('reasoning' in body, false);
  });
});
