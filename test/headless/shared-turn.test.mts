import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMemoryTranscriptStore } from '../../server/runner/transcript-store.js';
import type { RunnerDeps } from '../../server/runner/adapters';
import { runHeadlessSharedTurn } from '../../src/headless/shared-turn.ts';
import { estimateApiMessagesTokens, applyServerContextPolicy } from '../../server/runner/context-budget.js';
import type { ApiMessage } from '../../src/types';

const tool = { type: 'function' as const, function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } };
const call = { index: 0, id: 'read-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } };
function response(delta: unknown, finish_reason = 'stop') {
  return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason }] })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
}
function deps(post: RunnerDeps['postChatCompletions']): RunnerDeps {
  return {
    transcriptStore: createMemoryTranscriptStore(),
    postChatCompletions: post,
    runHeadlessToolBatch: async options => {
      const results = [];
      for (const raw of options.toolCalls) {
        const tc = raw as typeof call;
        const result = await options.execute(tc.function.name, JSON.parse(tc.function.arguments), { toolCallId: tc.id });
        const outcome = { toolCall: tc, result };
        options.onToolDone?.(outcome);
        results.push(outcome);
      }
      return results;
    },
    resolveProvider: async () => ({ id: 'test', baseUrl: 'http://localhost:1', apiKind: 'openai-v1' }),
    getSubAgentTypeConfig: async () => ({}),
    resolveSamplerPreset: () => ({ preset: {}, maxTokens: 256 }),
    resolveThinkingMode: () => ({ mode: 'off' }),
    resolveThinkingBudgetTokens: () => ({ budgetTokens: null }),
    loadToolCallsMeta: async () => {},
    getToolCallsMetaSync: () => ({}),
    isConstrainedDecodingEnabledForProvider: () => false,
    readProviderCapabilities: async () => null,
    isStructuredOutcomeResponseFormatAvailable: () => false,
    resolveSendCapabilities: () => ({}),
    resolveModelContextLimit: () => null,
    applyContextPolicy: async input => applyServerContextPolicy(input as Parameters<typeof applyServerContextPolicy>[0]),
  };
}
function options(adapters: RunnerDeps) {
  return {
    chatId: 'headless-test',
    messages: [{ role: 'system', content: 'System prompt' }, { role: 'user', content: 'Read the README' }],
    systemPrompt: 'System prompt',
    tools: [tool],
    model: { providerId: 'test', id: 'model', sampler: { preset: { temperature: 0.1 }, maxTokens: 128 } },
    signal: new AbortController().signal,
    deps: adapters,
    execute: async () => ({ content: 'README content' }),
  };
}

test('shared headless core completes a tool round and retains persistence and JSON output records', async () => {
  let requests = 0;
  const bodies: Record<string, unknown>[] = [];
  const adapters = deps(async (provider, body, _signal, postOptions) => {
    assert.equal(provider.id, 'test');
    bodies.push(body);
    postOptions?.onGenerationId?.(`gen-${++requests}`);
    return requests === 1 ? response({ content: '', tool_calls: [call] }, 'tool_calls') : response({ content: 'Read successfully.' });
  });
  const result = await runHeadlessSharedTurn(options(adapters));
  assert.equal(result.result.outcome, 'no_report');
  assert.equal(result.assistantFinal, 'Read successfully.');
  assert.equal(requests, 2);
  assert.deepEqual(result.history.map(row => row.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.equal(result.history[2].tool_call_id, 'read-1');
  assert.equal(result.turns[0].generationId, 'gen-1');
  assert.equal(result.turns[1].generationId, 'gen-2');
  assert.deepEqual(result.turns[0].toolCalls, [{ name: 'read_file', args: { path: 'README.md' }, resultPreview: 'README content' }]);
  assert.equal(bodies[0].model, 'model');
  assert.equal(bodies[0].temperature, 0.1);
  assert.equal(bodies[0].max_tokens, 128);
  assert.ok((bodies[1].messages as { role: string }[]).some(row => row.role === 'tool'));
});

test('ordinary prose completes without report tools or an extra forced tool round', async () => {
  let count = 0;
  const result = await runHeadlessSharedTurn(options(deps(async () => {
    count++;
    return response({ content: 'Ready.' });
  })));
  assert.equal(count, 1);
  assert.equal(result.assistantFinal, 'Ready.');
  assert.equal(result.result.outcome, 'no_report');
});

test('unavailable tools never reach the headless executor', async () => {
  let count = 0;
  let executed = false;
  const result = await runHeadlessSharedTurn({
    ...options(deps(async () => {
      count++;
      return count === 1
        ? response({ tool_calls: [{ ...call, function: { name: 'save_file', arguments: '{"path":"README.md","content":"changed"}' } }] }, 'tool_calls')
        : response({ content: 'The write tool was unavailable.' });
    })),
    execute: async () => { executed = true; return { content: 'should not run' }; },
  });
  assert.equal(executed, false);
  assert.equal(result.result.outcome, 'no_report');
  assert.match(String(result.history.find(row => row.role === 'tool')?.content), /not available|not enabled|disabled|not allowed/i);
});

test('repeated tool rounds stop at the deterministic max-turn bound', async () => {
  let count = 0;
  const result = await runHeadlessSharedTurn({ ...options(deps(async () => {
    count++;
    return response({ tool_calls: [{ ...call, id: `call-${count}` }] }, 'tool_calls');
  })), limits: { maxTurns: 2 } });
  assert.equal(count, 2);
  assert.equal(result.result.outcome, 'timeout');
  assert.equal(result.history.filter(row => row.role === 'tool').length, 2);
});

test('provider failure returns an error without an invented successful final reply', async () => {
  const result = await runHeadlessSharedTurn(options(deps(async () => { throw new Error('provider unavailable'); })));
  assert.equal(result.result.outcome, 'crashed');
  if (result.result.outcome === 'crashed') assert.match(result.result.error, /provider unavailable/);
  assert.equal(result.assistantFinal, '');
});

test('identical tool and result pairs stop at the unattended repeat limit', async () => {
  let count = 0;
  const result = await runHeadlessSharedTurn({ ...options(deps(async () => {
    count++;
    return response({ tool_calls: [{ ...call, id: `repeat-${count}` }] }, 'tool_calls');
  })), limits: { maxRepeatedToolCalls: 5 } });
  assert.equal(count, 5);
  assert.equal(result.result.outcome, 'crashed');
  if (result.result.outcome === 'crashed') assert.match(result.result.error, /repeat|same result/i);
});

test('large tool output is compacted or rejected before any over-budget request', async () => {
  let count = 0;
  const result = await runHeadlessSharedTurn({
    ...options(deps(async (_provider, body) => {
      assert.ok(estimateApiMessagesTokens(body.messages as ApiMessage[]) <= 4096);
      count++;
      return count === 1 ? response({ tool_calls: [call] }, 'tool_calls') : response({ content: 'Done.' });
    })),
    execute: async () => ({ content: 'Large file line with structured source data 123456789.\n'.repeat(5000) }),
    limits: { contextBudget: { workingContextTokens: 4096, enforcementPolicy: 'compact', minRecentTurns: 1 } },
  });
  assert.ok(count >= 1 && count <= 2);
  assert.ok(result.result.outcome === 'no_report' || result.result.outcome === 'crashed');
  if (result.result.outcome === 'crashed') assert.match(result.result.error, /context|budget/i);
});

test('wall clock timeout aborts the active generation transport', async () => {
  let aborted = false;
  const result = await runHeadlessSharedTurn({ ...options(deps(async (_provider, _body, signal) => {
    await new Promise((_, reject) => signal.addEventListener('abort', () => {
      aborted = true;
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true }));
    throw new Error('unreachable');
  })), limits: { wallClockMs: 20 } });
  assert.equal(aborted, true);
  assert.equal(result.result.outcome, 'timeout');
});
