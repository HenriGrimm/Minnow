/**
 * pumpAnthropicUpstream: mocked AI SDK → OpenAI-shaped generation chunks.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, mock, test } from 'node:test';
import { createGenerationState } from '../../server/generations/store.js';
import {
  __resetAnthropicPumpMocksForTests,
  __setAnthropicPumpMocksForTests,
  pumpAnthropicUpstream,
} from '../../server/generations/anthropic/pump.js';

const RUNTIME = {
  profile: { baseUrl: 'https://api.anthropic.com' },
  paths: { chatCompletionsPath: '/v1/messages' },
  secrets: { apiKey: 'test-api-key' },
};

const CANDIDATE = { providerId: 'anthropic-native', modelId: 'claude-sonnet-4-5' };

const PUMP_OPTS = {
  index: 0,
  idleMs: 60_000,
  maxMs: 120_000,
  cooldownSeconds: 60,
  canFailover: false,
};

/** @type {import('../../server/generations/store.js').GenerationState[]} */
const activeStates = [];

/** Fake Anthropic provider factory — only model id is needed for mocked AI SDK calls. */
function fakeAnthropicProvider() {
  return (modelId) => ({ modelId, provider: 'anthropic-mock' });
}

function chunksToString(state) {
  return Buffer.concat(state.chunks).toString('utf8');
}

afterEach(() => {
  for (const state of activeStates) {
    if (state.evictTimer) clearTimeout(state.evictTimer);
  }
  activeStates.length = 0;
  __resetAnthropicPumpMocksForTests();
  mock.restoreAll();
});

describe('pumpAnthropicUpstream', () => {
  test('streaming path emits OpenAI SSE bytes via appendChunk', async () => {
    const streamText = mock.fn(() => ({
      fullStream: (async function* () {
        yield { type: 'text-delta', text: 'Hello', id: 'text-1' };
        yield {
          type: 'finish',
          finishReason: 'stop',
          totalUsage: {
            inputTokens: 12,
            outputTokens: 3,
            totalTokens: 15,
            inputTokenDetails: {
              noCacheTokens: 12,
              cacheReadTokens: undefined,
              cacheWriteTokens: undefined,
            },
            outputTokenDetails: {
              textTokens: 3,
              reasoningTokens: undefined,
            },
          },
        };
      })(),
    }));

    __setAnthropicPumpMocksForTests({
      streamText,
      buildAnthropicProvider: fakeAnthropicProvider,
    });

    const state = createGenerationState({
      providerId: CANDIDATE.providerId,
      body: {
        model: CANDIDATE.modelId,
        stream: true,
        messages: [{ role: 'user', content: 'Hi' }],
      },
    });
    activeStates.push(state);

    const result = await pumpAnthropicUpstream({
      state,
      runtime: RUNTIME,
      candidate: CANDIDATE,
      ...PUMP_OPTS,
    });

    assert.equal(result.outcome, 'complete');
    assert.equal(state.status, 'complete');
    assert.equal(state.chosenProviderId, 'anthropic-native');
    assert.equal(state.chosenModelId, 'claude-sonnet-4-5');
    assert.equal(streamText.mock.callCount(), 1);

    const emitted = chunksToString(state);
    assert.match(emitted, /"delta":\{"content":"Hello"\}/);
    assert.match(emitted, /"finish_reason":"stop"/);
    assert.match(emitted, /"prompt_tokens":12/);
    assert.match(emitted, /"completion_tokens":3/);
    assert.match(emitted, /"total_tokens":15/);
    assert.ok(emitted.endsWith('data: [DONE]\n\n'));
  });

  test('streaming path surfaces AI SDK error stream parts as fatal', async () => {
    const streamText = mock.fn(() => ({
      fullStream: (async function* () {
        yield { type: 'start' };
        yield { type: 'error', error: new Error('Invalid prompt') };
      })(),
    }));

    __setAnthropicPumpMocksForTests({
      streamText,
      buildAnthropicProvider: fakeAnthropicProvider,
    });

    const state = createGenerationState({
      providerId: CANDIDATE.providerId,
      body: {
        model: CANDIDATE.modelId,
        stream: true,
        messages: [{ role: 'user', content: 'Hi' }],
      },
    });
    activeStates.push(state);

    const result = await pumpAnthropicUpstream({
      state,
      runtime: RUNTIME,
      candidate: CANDIDATE,
      ...PUMP_OPTS,
    });

    assert.equal(result.outcome, 'fatal');
    assert.equal(result.message, 'Invalid prompt');
    assert.equal(state.status, 'error');
    assert.equal(state.errorMessage, 'Invalid prompt');
  });

  test('normalizes enabled thinking to adaptive for claude-sonnet-5 before streamText', async () => {
    const streamText = mock.fn(() => ({
      fullStream: (async function* () {
        yield { type: 'start' };
        yield {
          type: 'finish',
          finishReason: 'stop',
          totalUsage: {
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2,
            inputTokenDetails: { noCacheTokens: 1 },
            outputTokenDetails: { textTokens: 1 },
          },
        };
      })(),
    }));

    __setAnthropicPumpMocksForTests({
      streamText,
      buildAnthropicProvider: fakeAnthropicProvider,
    });

    const state = createGenerationState({
      providerId: CANDIDATE.providerId,
      body: {
        model: 'claude-sonnet-5',
        stream: true,
        messages: [{ role: 'user', content: 'Hi' }],
        providerOptions: {
          anthropic: {
            thinking: { type: 'enabled', budgetTokens: 10240 },
          },
        },
      },
    });
    activeStates.push(state);

    await pumpAnthropicUpstream({
      state,
      runtime: RUNTIME,
      candidate: { providerId: 'zen', modelId: 'claude-sonnet-5' },
      ...PUMP_OPTS,
    });

    assert.equal(streamText.mock.callCount(), 1);
    const callOptions = streamText.mock.calls[0]?.arguments[0];
    assert.deepEqual(callOptions.providerOptions?.anthropic?.thinking, {
      type: 'adaptive',
      display: 'summarized',
    });
    assert.equal(callOptions.providerOptions?.anthropic?.effort, 'medium');
    assert.equal(callOptions.temperature, undefined);
    assert.equal(callOptions.topP, undefined);
  });

  test('omits temperature and topP when adaptive thinking is active', async () => {
    const streamText = mock.fn(() => ({
      fullStream: (async function* () {
        yield { type: 'start' };
        yield {
          type: 'finish',
          finishReason: 'stop',
          totalUsage: {
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2,
            inputTokenDetails: { noCacheTokens: 1 },
            outputTokenDetails: { textTokens: 1 },
          },
        };
      })(),
    }));

    __setAnthropicPumpMocksForTests({
      streamText,
      buildAnthropicProvider: fakeAnthropicProvider,
    });

    const state = createGenerationState({
      providerId: CANDIDATE.providerId,
      body: {
        model: 'claude-opus-4-6',
        stream: true,
        temperature: 0.7,
        top_p: 0.95,
        messages: [{ role: 'user', content: 'Hi' }],
        providerOptions: {
          anthropic: {
            thinking: { type: 'adaptive' },
            effort: 'medium',
          },
        },
      },
    });
    activeStates.push(state);

    await pumpAnthropicUpstream({
      state,
      runtime: RUNTIME,
      candidate: { providerId: 'zen', modelId: 'claude-opus-4-6' },
      ...PUMP_OPTS,
    });

    const callOptions = streamText.mock.calls[0]?.arguments[0];
    assert.equal(callOptions.temperature, undefined);
    assert.equal(callOptions.topP, undefined);
  });

  test('maps OpenAI stop to stopSequences (string or array, max 8)', async () => {
    const streamText = mock.fn(() => ({
      fullStream: (async function* () {
        yield {
          type: 'finish',
          finishReason: 'stop',
          totalUsage: {
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2,
            inputTokenDetails: { noCacheTokens: 1 },
            outputTokenDetails: { textTokens: 1 },
          },
        };
      })(),
    }));

    __setAnthropicPumpMocksForTests({
      streamText,
      buildAnthropicProvider: fakeAnthropicProvider,
    });

    const stops = ['\n', '```', '<|fim|>', '\n</file>', 'extra'];
    const state = createGenerationState({
      providerId: CANDIDATE.providerId,
      body: {
        model: CANDIDATE.modelId,
        stream: true,
        stop: stops,
        messages: [{ role: 'user', content: 'Hi' }],
      },
    });
    activeStates.push(state);

    await pumpAnthropicUpstream({
      state,
      runtime: RUNTIME,
      candidate: CANDIDATE,
      ...PUMP_OPTS,
    });

    const callOptions = streamText.mock.calls[0]?.arguments[0];
    assert.deepEqual(callOptions.stopSequences, stops.slice(0, 8));
  });

  test('non-streaming path emits OpenAI chat.completion JSON via appendChunk', async () => {
    const generateText = mock.fn(async () => ({
      text: 'All done',
      reasoningText: 'brief thought',
      finishReason: 'stop',
      toolCalls: [],
      usage: {
        inputTokens: 20,
        outputTokens: 8,
        totalTokens: 28,
        inputTokenDetails: {
          noCacheTokens: 20,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
        },
        outputTokenDetails: {
          textTokens: 8,
          reasoningTokens: undefined,
        },
      },
    }));

    __setAnthropicPumpMocksForTests({
      generateText,
      buildAnthropicProvider: fakeAnthropicProvider,
    });

    const state = createGenerationState({
      providerId: CANDIDATE.providerId,
      body: {
        model: CANDIDATE.modelId,
        stream: false,
        messages: [{ role: 'user', content: 'Summarize' }],
      },
    });
    activeStates.push(state);

    const result = await pumpAnthropicUpstream({
      state,
      runtime: RUNTIME,
      candidate: CANDIDATE,
      ...PUMP_OPTS,
    });

    assert.equal(result.outcome, 'complete');
    assert.equal(state.status, 'complete');
    assert.equal(generateText.mock.callCount(), 1);
    assert.equal(state.chunks.length, 1);

    const body = JSON.parse(state.chunks[0].toString('utf8'));
    assert.equal(body.object, 'chat.completion');
    assert.equal(body.model, 'claude-sonnet-4-5');
    assert.equal(body.choices[0].message.content, 'All done');
    assert.equal(body.choices[0].message.reasoning, 'brief thought');
    assert.equal(body.choices[0].finish_reason, 'stop');
    assert.deepEqual(body.usage, {
      prompt_tokens: 20,
      completion_tokens: 8,
      total_tokens: 28,
    });
  });
});
