import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runTurn } from '../../server/runner/run-turn.js';
import { createMemoryTranscriptStore } from '../../server/runner/transcript-store.js';
import { proseSseChunks } from '../../scripts/fake-model-server.mjs';

async function execute(model, previousEffort) {
  const transcript = createMemoryTranscriptStore();
  transcript.setMeta('model-options', { reasoningEffort: previousEffort });
  const requests = [];
  const result = await runTurn({
    chatId: 'model-options', seed: 'Reply briefly.', tools: [], model,
    injectReportTool: false, nudgeToolUse: false, finalizeStructuredOutcome: false,
    deps: {
      transcriptStore: transcript,
      postChatCompletions: async (_provider, body) => {
        requests.push(structuredClone(body));
        return new Response(proseSseChunks('Complete.').join(''), {
          headers: { 'Content-Type': 'text/event-stream' },
        });
      },
      runHeadlessToolBatch: async () => [],
      resolveProvider: async () => ({ id: 'fixture', apiKind: 'openai-v1', baseUrl: 'http://fixture.invalid' }),
      getSubAgentTypeConfig: async () => ({}),
      resolveSamplerPreset: () => ({ preset: {}, maxTokens: 128 }),
      resolveThinkingMode: () => ({ mode: 'on' }),
      resolveThinkingBudgetTokens: () => ({ budgetTokens: null }),
      loadToolCallsMeta: async () => {},
      getToolCallsMetaSync: () => ({ useConstrainedDecoding: false }),
      isConstrainedDecodingEnabledForProvider: () => false,
      readProviderCapabilities: async () => null,
      isStructuredOutcomeResponseFormatAvailable: () => false,
      resolveSendCapabilities: () => ({ reasoningAllowedOptions: ['low', 'high'], reasoningDefault: 'low' }),
      resolveModelContextLimit: () => null,
      applyContextPolicy: async ({ messages }) => ({ applied: false, messages }),
    },
  });
  assert.equal(result.outcome, 'no_report');
  return { request: requests[0], meta: transcript.load('model-options').meta };
}

test('captured explicit effort reaches the shared runner request, overriding older metadata', async () => {
  const { request, meta } = await execute({ providerId: 'fixture', id: 'reasoner', options: { reasoningEffort: 'high' } }, 'low');
  assert.equal(request.reasoning_effort, 'high');
  assert.equal(meta.reasoningEffort, 'high');
});

test('empty captured options clears a previous per-turn reasoning override', async () => {
  const { request, meta } = await execute({ providerId: 'fixture', id: 'reasoner', options: {} }, 'high');
  assert.equal(request.reasoning_effort, 'low');
  assert.equal(meta.reasoningEffort, null);
});

test('legacy callers without an options snapshot retain existing reasoning behavior', async () => {
  const { request } = await execute({ providerId: 'fixture', id: 'reasoner' }, 'high');
  assert.equal(request.reasoning_effort, 'high');
});

test('explicit reasoning enables thinking over an inherited type-level off default', async () => {
  const { request } = await execute({ providerId: 'fixture', id: 'reasoner', thinking: { mode: 'off' }, options: { reasoningEffort: 'high' } }, 'low');
  assert.equal(request.reasoning_effort, 'high');
});
