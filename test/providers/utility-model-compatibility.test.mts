import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { sanitizeCompletionBodyForProvider as clientSanitize } from '../../src/providers/sanitize-completion-body.ts';
import { sanitizeCompletionBodyForProvider as serverSanitize } from '../../server/providers/sanitize-completion-body.js';
import { thinkingToCompletionBody } from '../../server/runner/thinking-to-body.js';
import { prepareResponsesRequest } from '../../server/generations/openai-responses/pump.js';
import type { ProviderPublic } from '../../src/providers/types.ts';

const provider: ProviderPublic = {
  id: 'onboarding-cloud-opencode-go', label: 'Go', apiKind: 'openai-v1',
  baseUrl: 'https://opencode.ai/zen/go/v1', enabled: true,
  hasApiKey: true, hasBearer: false,
};

for (const [name, sanitize] of [['client', clientSanitize], ['server', serverSanitize]] as const) {
  describe(`${name} utility model compatibility`, () => {
    test('Hy3 disables reasoning using its supported effort field', () => {
      const body = { model: 'hy3', thinking: { type: 'disabled' } };
      const wire = sanitize(body, provider);
      assert.equal(wire.reasoning_effort, 'none');
      assert.equal(wire.thinking, undefined);
      assert.deepEqual(serverSanitize(wire, provider), wire);
      const enabled = sanitize({ model: 'hy3', reasoning_effort: 'high' }, provider);
      assert.equal(enabled.reasoning_effort, 'high');
    });
    for (const model of ['glm-5.3', 'glm-5.3-flash', 'kimi-k2.6', 'kimi-k3']) {
      test(`${model}: thinking-off utility requests use Go's wire fields`, () => {
        const patch = thinkingToCompletionBody('off', 'openai-v1', undefined, null, model).body;
        const body = { model, messages: [{ role: 'user', content: 'Expand this prompt.' }], ...patch };
        const original = structuredClone(body);
        const wire = sanitize(body, provider);
        assert.equal(wire.thinking, undefined);
        assert.equal(wire.reasoning, undefined);
        assert.equal(wire.enable_thinking, undefined);
        assert.equal(wire.chat_template_kwargs, undefined);
        if (model.startsWith('glm')) assert.equal(wire.reasoning_effort, 'low');
        assert.deepEqual(body, original, 'normalization must not mutate the caller');
        assert.deepEqual(serverSanitize(wire, provider), wire, 'server pass must preserve client normalization');
      });
    }

    test('orchestrator and chat effort survive the capability-free server pass', () => {
      const body = { model: 'glm-5.3', reasoning_effort: 'high', max_tokens: 65000 };
      const wire = sanitize(body, provider);
      assert.equal(wire.reasoning_effort, 'high');
      assert.equal(wire.max_tokens, 65000);
      assert.equal(wire.thinking, undefined);
      assert.deepEqual(serverSanitize(wire, provider), wire);
    });

    test('native Z.ai and local GLM keep their thinking controls', () => {
      for (const baseUrl of ['https://api.z.ai/api/paas/v4', 'http://127.0.0.1:1234/v1']) {
        const wire = sanitize({ model: 'glm-5.3', thinking: { type: 'disabled' } }, { ...provider, baseUrl });
        assert.deepEqual(wire.thinking, { type: 'enabled' });
        assert.equal(wire.reasoning_effort, 'low');
      }
    });
  });
}

describe('Go Responses utility requests', () => {
  for (const model of ['grok-4.6', 'muse-spark-1.3-contributor', 'gpt-5.6-luna']) {
    test(`${model}: thinking-off reaches the supported Responses effort`, () => {
      const patch = thinkingToCompletionBody('off', 'openai-v1', undefined, null, model).body;
      const { responsesBody } = prepareResponsesRequest(
        Buffer.from(JSON.stringify({ model, messages: [], ...patch })), provider, model,
      );
      assert.deepEqual(responsesBody.reasoning, { effort: model === 'gpt-5.6-luna' ? 'none' : 'low' });
      assert.equal(responsesBody.thinking, undefined);
    });
  }
  for (const effort of ['low', 'high', 'xhigh', 'none', 'off']) {
    test(`Grok explicit ${effort} survives server preparation`, () => {
      const { responsesBody } = prepareResponsesRequest(
        Buffer.from(JSON.stringify({ model: 'grok-4.6', reasoning_effort: effort })), provider, 'grok-4.6',
      );
      assert.deepEqual(responsesBody.reasoning, { effort: ['none', 'off'].includes(effort) ? 'low' : effort });
    });
  }
});
