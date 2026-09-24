import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTurnRunner, createMemoryTranscriptStore, runHeadlessToolBatchStub } from '../../server/runner/index.js';

test('the shared runner discards failed prose, reasoning and partial tool calls on restart', async () => {
  const frames = [
    { choices: [{ delta: { content: 'WRONG RESPONSE', reasoning_content: 'WRONG REASONING', tool_calls: [{ index: 0, id: 'bad', type: 'function', function: { name: 'delete_file', arguments: '{"path":"' } }] } }] },
    { minnow_router: { reset: true, warning: 'Response restarted on backup', modelId: 'backup' }, choices: [] },
    { choices: [{ delta: { content: 'The answer is 42.' }, finish_reason: 'stop' }] },
  ];
  const events = []; let executed = false;
  const runner = createTurnRunner({
    transcriptStore: createMemoryTranscriptStore(),
    postChatCompletions: async () => new Response(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('') + 'data: [DONE]\n\n'),
    runHeadlessToolBatch: runHeadlessToolBatchStub,
    resolveProvider: async () => ({ id: 'minnow-router', label: 'Router', baseUrl: '', apiKind: 'openai-v1' }),
    getSubAgentTypeConfig: async () => ({}),
    resolveSamplerPreset: () => ({ preset: {}, maxTokens: 256 }),
    resolveThinkingMode: () => ({ mode: 'off' }),
    resolveThinkingBudgetTokens: () => ({ budgetTokens: null }),
    loadToolCallsMeta: async () => {}, getToolCallsMetaSync: () => ({ useConstrainedDecoding: false }),
    isConstrainedDecodingEnabledForProvider: () => false,
    readProviderCapabilities: async () => null,
    isStructuredOutcomeResponseFormatAvailable: () => false,
    resolveSendCapabilities: () => ({}), resolveModelContextLimit: () => null,
    applyContextPolicy: async (input) => ({ applied: false, messages: input.messages }),
  });
  const output = await runner.run({ runId: 'restart', type: 'turn', task: 'Answer.', systemPrompt: 'Test', tools: [], providerId: 'minnow-router', modelId: 'router', signal: AbortSignal.timeout(5000), finalizeStructuredOutcome: false, nudgeToolUse: false, executeTool: async () => { executed = true; return { content: '' }; }, onTurnEvent: (event) => events.push(event) });
  assert.equal(output.summary, 'The answer is 42.');
  assert.equal(executed, false);
  assert.ok(events.some((e) => e.type === 'response_restart'));
  const assistant = output.messages.filter((m) => m.role === 'assistant');
  assert.equal(assistant.length, 1);
  assert.doesNotMatch(JSON.stringify(assistant), /WRONG|delete_file|"bad"/);
});
