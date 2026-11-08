/**
 * Title provider port: thinking disabled so titles land in message.content.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { applyTitleThinkingOffPatch } from '../../src/chat/titles/provider-port.ts';

describe('applyTitleThinkingOffPatch', () => {
  test('CLI titles do not send unsupported reasoning off', () => {
    const request = { model: 'gpt-6.1-sol', messages: [{ role: 'user', content: 'Hello' }], max_tokens: 24 };
    const body = applyTitleThinkingOffPatch(request, 'agent-cli-v1');
    assert.deepEqual(body, request);
    assert.equal(body.reasoning_effort, undefined);
  });
  test('disables thinking for lm-studio-v0 providers', () => {
    const body = applyTitleThinkingOffPatch(
      {
        model: 'qwen-test',
        messages: [{ role: 'user', content: 'Hello' }],
        temperature: 0.3,
        max_tokens: 24,
      },
      'lm-studio-v0',
    );

    assert.equal(body.enable_thinking, false);
    assert.equal(body.reasoning_effort, 'none');
    assert.equal(body.model, 'qwen-test');
    assert.equal(body.max_tokens, 24);
  });

  test('disables thinking for openai-v1 providers', () => {
    const body = applyTitleThinkingOffPatch(
      {
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'Hello' }],
        temperature: 0.3,
        max_tokens: 24,
      },
      'openai-v1',
    );

    assert.deepEqual(body.thinking, { type: 'disabled' });
  });

  test('GLM-5.3 openai-v1 remaps off to enabled + low', () => {
    const body = applyTitleThinkingOffPatch(
      {
        model: 'glm-5.3-flash',
        messages: [{ role: 'user', content: 'Hello' }],
        temperature: 0.3,
        max_tokens: 24,
      },
      'openai-v1',
    );

    assert.deepEqual(body.thinking, { type: 'enabled' });
    assert.equal(body.reasoning_effort, 'low');
  });
});
