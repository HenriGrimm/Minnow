/**
 * OpenAI-safe completion body sanitization for sub-agents.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { sanitizeCompletionBodyForProvider } from '../../src/providers/sanitize-completion-body.ts';
import type { ProviderPublic } from '../../src/providers/types.ts';
import {
  EXTENDED_SAMPLER_BODY,
  EXTENDED_SAMPLER_CASES,
} from './sanitize-extended-samplers.fixtures.mjs';

const OPENAI: ProviderPublic = {
  id: 'openai-v1',
  label: 'OpenAI',
  baseUrl: 'https://api.openai.com',
  apiKind: 'openai-v1',
  enabled: true,
  hasApiKey: true,
  hasBearer: false,
};

const LM_STUDIO: ProviderPublic = {
  id: 'lm-studio-local',
  label: 'LM Studio',
  baseUrl: 'http://127.0.0.1:1234',
  apiKind: 'lm-studio-v0',
  enabled: true,
  hasApiKey: false,
  hasBearer: false,
};

describe('sanitizeCompletionBodyForProvider', () => {
  test('strips LM Studio sampler fields for openai-v1', () => {
    const out = sanitizeCompletionBodyForProvider(
      {
        model: 'gpt-4o-mini',
        messages: [],
        temperature: 0.7,
        top_k: 20,
        min_p: 0.05,
        repetition_penalty: 1.1,
        enable_thinking: false,
      },
      OPENAI,
    );
    assert.equal(out.top_k, undefined);
    assert.equal(out.min_p, undefined);
    assert.equal(out.repetition_penalty, undefined);
    assert.equal(out.enable_thinking, undefined);
    assert.equal(out.temperature, 0.7);
  });

  test('removes reasoning enable fields when model has no reasoning capability', () => {
    const out = sanitizeCompletionBodyForProvider(
      {
        model: 'gpt-4o-mini',
        thinking: { type: 'disabled' },
        reasoning: { effort: 'medium' },
        reasoning_effort: 'medium',
      },
      OPENAI,
      { reasoning: false },
    );
    assert.deepEqual(out.thinking, { type: 'disabled' });
    assert.equal(out.reasoning, undefined);
    assert.equal(out.reasoning_effort, undefined);
  });

  test('strips thinking enable when model has no reasoning capability', () => {
    const out = sanitizeCompletionBodyForProvider(
      {
        model: 'gpt-4o-mini',
        thinking: { type: 'enabled' },
      },
      OPENAI,
      { reasoning: false },
    );
    assert.equal(out.thinking, undefined);
  });

  test('preserves thinking disabled without model capabilities (upstream path)', () => {
    const out = sanitizeCompletionBodyForProvider(
      {
        model: 'deepseek-chat',
        thinking: { type: 'disabled' },
        reasoning_effort: 'medium',
      },
      OPENAI,
    );
    assert.deepEqual(out.thinking, { type: 'disabled' });
    assert.equal(out.reasoning_effort, undefined);
  });

  test('preserves reasoning fields when model supports reasoning options', () => {
    const out = sanitizeCompletionBodyForProvider(
      {
        model: 'o3-mini',
        reasoning_effort: 'high',
        reasoning: { effort: 'high' },
      },
      OPENAI,
      { reasoning: true, reasoningAllowedOptions: ['low', 'medium', 'high'] },
    );
    assert.equal(out.reasoning_effort, 'high');
    assert.deepEqual(out.reasoning, { effort: 'high' });
  });

  test('maps max_tokens to max_completion_tokens for o-series models', () => {
    const out = sanitizeCompletionBodyForProvider(
      { model: 'o3-mini', max_tokens: 1024 },
      OPENAI,
    );
    assert.equal(out.max_completion_tokens, 1024);
    assert.equal(out.max_tokens, undefined);
  });

  test('strips temperature and top_p for gpt-5 models on openai-v1', () => {
    const out = sanitizeCompletionBodyForProvider(
      { model: 'gpt-5.4', temperature: 0.7, top_p: 0.9 },
      OPENAI,
    );
    assert.equal(out.temperature, undefined);
    assert.equal(out.top_p, undefined);
  });

  test('leaves body unchanged for lm-studio-v0', () => {
    const body = { model: 'local', top_k: 20, max_tokens: 512 };
    const out = sanitizeCompletionBodyForProvider(body, LM_STUDIO);
    assert.deepEqual(out, body);
  });

  test('forces temperature=1 for Kimi models on openai-v1', () => {
    const out = sanitizeCompletionBodyForProvider(
      { model: 'kimi-k2', temperature: 0.7 },
      OPENAI,
    );
    assert.equal(out.temperature, 1);
  });

  test('leaves temperature unchanged for Kimi models on lm-studio-v0', () => {
    const out = sanitizeCompletionBodyForProvider(
      { model: 'moonshotai/Kimi-K2-Instruct', temperature: 0.7 },
      LM_STUDIO,
    );
    assert.equal(out.temperature, 0.7);
  });

  test('does not alter temperature=1 for Kimi models', () => {
    const out = sanitizeCompletionBodyForProvider(
      { model: 'kimi-k2', temperature: 1 },
      OPENAI,
    );
    assert.equal(out.temperature, 1);
  });

  test('strips message-level reasoning fields for Kimi models', () => {
    const out = sanitizeCompletionBodyForProvider(
      {
        model: 'kimi-k2.7-code',
        messages: [
          { role: 'user', content: 'hi' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'x', arguments: '{}' } }],
            reasoning: 'must not be sent upstream',
            reasoning_signature: 'sig',
          },
        ],
      },
      OPENAI,
    );
    const assistant = (out.messages as Record<string, unknown>[])[1];
    assert.equal(assistant.reasoning, undefined);
    assert.equal(assistant.reasoning_signature, undefined);
  });

  test('local hosts replay assistant reasoning as reasoning_content', () => {
    const replayBody = (model = 'qwen3') => ({
      model,
      reasoning: { effort: 'high' },
      messages: [
        { role: 'user', content: 'hi', reasoning: 'user rows are left alone' },
        { role: 'assistant', content: null, reasoning: 'thought one' },
        { role: 'assistant', content: 'x', reasoning: 'fresh', reasoning_content: 'kept' },
      ],
    });
    for (const id of ['llama-cpp-local', 'mlx-lm-local']) {
      const out = sanitizeCompletionBodyForProvider(replayBody(), { ...OPENAI, id }, { reasoning: true });
      const [user, first, second] = out.messages as Record<string, unknown>[];
      assert.equal(first.reasoning_content, 'thought one');
      assert.equal(first.reasoning, undefined);
      assert.equal(second.reasoning_content, 'kept');
      assert.equal(second.reasoning, undefined);
      assert.equal(user.reasoning, 'user rows are left alone');
      assert.deepEqual(out.reasoning, { effort: 'high' });
    }

    const cloud = sanitizeCompletionBodyForProvider(replayBody(), OPENAI, { reasoning: true });
    const cloudAssistant = (cloud.messages as Record<string, unknown>[])[1];
    assert.equal(cloudAssistant.reasoning, 'thought one');
    assert.equal(cloudAssistant.reasoning_content, undefined);

    const kimi = sanitizeCompletionBodyForProvider(
      replayBody('kimi-k2'),
      { ...OPENAI, id: 'llama-cpp-local' },
      { reasoning: true },
    );
    const kimiAssistant = (kimi.messages as Record<string, unknown>[])[1];
    assert.equal(kimiAssistant.reasoning, undefined);
    assert.equal(kimiAssistant.reasoning_content, undefined);
  });

  test('keeps thinking_budget_tokens only for llama-cpp-local', () => {
    const llama = { ...OPENAI, id: 'llama-cpp-local' };
    const withBudget = sanitizeCompletionBodyForProvider(
      { model: 'qwen3', thinking_budget_tokens: 1024 },
      llama,
      { reasoning: true },
    );
    assert.equal(withBudget.thinking_budget_tokens, 1024);

    const stripped = sanitizeCompletionBodyForProvider(
      { model: 'qwen3', thinking_budget_tokens: 1024 },
      OPENAI,
      { reasoning: true },
    );
    assert.equal(stripped.thinking_budget_tokens, undefined);
  });

  test('strips toolImageFollowUp from messages for every api kind', () => {
    const body = {
      model: 'qwen',
      messages: [
        { role: 'user', content: 'hi' },
        {
          role: 'user',
          content: [{ type: 'text', text: '[tool screenshot]' }],
          toolImageFollowUp: true,
        },
      ],
    };
    const openaiOut = sanitizeCompletionBodyForProvider(body, OPENAI);
    const followUp = (openaiOut.messages as Record<string, unknown>[])[1];
    assert.equal(followUp.toolImageFollowUp, undefined);
    assert.equal(followUp.role, 'user');

    const lmOut = sanitizeCompletionBodyForProvider(body, LM_STUDIO);
    assert.equal(
      (lmOut.messages as Record<string, unknown>[])[1].toolImageFollowUp,
      undefined,
    );
  });

  test('keeps chat_template_kwargs for local runtime and loopback openai-v1 providers', () => {
    const body = () => ({
      model: 'qwen3',
      enable_thinking: false,
      chat_template_kwargs: { enable_thinking: false },
    });

    for (const id of ['llama-cpp-local', 'mlx-lm-local']) {
      const kept = sanitizeCompletionBodyForProvider(body(), { ...OPENAI, id }, {
        reasoning: true,
      });
      assert.deepEqual(kept.chat_template_kwargs, { enable_thinking: false });
      assert.equal(kept.enable_thinking, false);
    }

    const mtplx = sanitizeCompletionBodyForProvider(body(), {
      ...OPENAI,
      id: 'mtplx-local',
      baseUrl: 'http://127.0.0.1:8000',
    }, {
      reasoning: true,
    });
    assert.deepEqual(mtplx.chat_template_kwargs, { enable_thinking: false });
    assert.equal(mtplx.enable_thinking, false);

    // Hosted OpenAI-compatible APIs 400 on unknown body fields.
    const stripped = sanitizeCompletionBodyForProvider(body(), OPENAI, {
      reasoning: true,
    });
    assert.equal(stripped.chat_template_kwargs, undefined);
    assert.equal(stripped.enable_thinking, undefined);
  });

  test('rewrites GLM-5.3 disabled / medium / none into enabled + legal effort', () => {
    const out = sanitizeCompletionBodyForProvider(
      {
        model: 'glm-5.3-flash',
        thinking: { type: 'disabled' },
        reasoning_effort: 'medium',
        enable_thinking: false,
      },
      OPENAI,
      { reasoning: true, reasoningAllowedOptions: ['low', 'high', 'max'] },
    );
    assert.deepEqual(out.thinking, { type: 'enabled' });
    assert.equal(out.reasoning_effort, 'low');
    assert.deepEqual(out.reasoning, { effort: 'low' });
  });

  test('rewrites GLM-5.3 xhigh onto max', () => {
    const out = sanitizeCompletionBodyForProvider(
      {
        model: 'z-ai/glm-5.3-flash',
        thinking: { type: 'disabled' },
        reasoning_effort: 'xhigh',
      },
      OPENAI,
      { reasoning: true },
    );
    assert.deepEqual(out.thinking, { type: 'enabled' });
    assert.equal(out.reasoning_effort, 'max');
  });
});

describe('extended sampler keep vs strip (shared fixtures)', () => {
  for (const fixture of EXTENDED_SAMPLER_CASES) {
    test(fixture.name, () => {
      const provider: ProviderPublic = { ...OPENAI, ...fixture.provider };
      const body = { ...EXTENDED_SAMPLER_BODY } as Record<string, unknown>;
      const out = sanitizeCompletionBodyForProvider({ ...EXTENDED_SAMPLER_BODY }, provider);
      for (const key of fixture.keep) {
        assert.equal(out[key], body[key], `expected to keep ${key}`);
      }
      for (const key of fixture.strip) {
        assert.equal(out[key], undefined, `expected to strip ${key}`);
      }
    });
  }
});
