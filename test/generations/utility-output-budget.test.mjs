import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withUtilityOutputBudget } from '../../server/generations/utility-output-budget.js';
import { prepareResponsesRequest } from '../../server/generations/openai-responses/pump.js';

const go = 'https://opencode.ai/zen/go';
test('short Go utility budgets reserve reasoning plus visible output', () => {
  for (const role of ['utility', 'chat-titles', 'editor-completion']) {
    for (const key of ['max_tokens', 'max_completion_tokens', 'max_output_tokens']) {
      const body = { model: 'glm-5.3-flash', [key]: 128 };
      const out = withUtilityOutputBudget(body, go, role);
      assert.equal(out[key], 2048);
      assert.equal(body[key], 128);
    }
  }
});

test('utility thinking-off callers without a fallback role get the same reserve', () => {
  assert.equal(withUtilityOutputBudget({ max_tokens: 700, thinking: { type: 'disabled' } }, go).max_tokens, 2048);
  assert.equal(withUtilityOutputBudget({ max_tokens: 700, enable_thinking: false }, go).max_tokens, 2048);
});

test('preserves ordinary chat caps, larger budgets, and non-Go providers', () => {
  for (const cap of [undefined, 0, -1, 4096, 65000]) {
    const body = { max_tokens: cap };
    assert.equal(withUtilityOutputBudget(body, go, 'utility'), body);
  }
  const body = { max_tokens: 128 };
  assert.equal(withUtilityOutputBudget(body, go, 'default'), body);
  const chat = { ...body, thinking: { type: 'disabled' } };
  assert.equal(withUtilityOutputBudget(chat, go, 'default'), chat);
  for (const url of ['http://localhost:1234', 'https://opencode.ai/zen', 'https://api.z.ai']) {
    assert.equal(withUtilityOutputBudget(body, url, 'utility'), body);
  }
});

test('Responses applies the budget and selected fallback model before normalization', () => {
  const { responsesBody } = prepareResponsesRequest(
    Buffer.from(JSON.stringify({ model: 'gpt-5.6-luna', max_tokens: 128, thinking: { type: 'disabled' } })),
    { baseUrl: go, apiKind: 'openai-v1' }, 'grok-4.6', 'go', 'utility',
  );
  assert.equal(responsesBody.model, 'grok-4.6');
  assert.equal(responsesBody.max_output_tokens, 2048);
  assert.deepEqual(responsesBody.reasoning, { effort: 'low' });
});
