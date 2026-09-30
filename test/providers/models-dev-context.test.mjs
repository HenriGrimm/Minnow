/**
 * OpenCode providers enrich model context from models.dev.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  enrichModelsFromModelsDev,
  enrichOpenCodeModelsFromModelsDev,
  isOpenCodeProviderBaseUrl,
  modelsDevProviderId,
  modelsDevReasoningBlock,
  resetModelsDevContextCacheForTests,
} from '../../server/providers/models-dev-context.js';

describe('models-dev-context', () => {
  beforeEach(() => {
    resetModelsDevContextCacheForTests();
  });

  it('isOpenCodeProviderBaseUrl matches opencode.ai hosts', () => {
    assert.equal(isOpenCodeProviderBaseUrl('https://opencode.ai/zen/v1'), true);
    assert.equal(isOpenCodeProviderBaseUrl('https://opencode.ai/zen/go/v1'), true);
    assert.equal(isOpenCodeProviderBaseUrl('http://localhost:1234/v1'), false);
    assert.equal(isOpenCodeProviderBaseUrl('https://openrouter.ai/api/v1'), false);
  });

  it('selects the catalog by provider endpoint, including Go and hosted gateways', () => {
    const catalog = {
      opencode: { api: 'https://opencode.ai/zen/v1' },
      'opencode-go': { api: 'https://opencode.ai/zen/go/v1' },
      openrouter: { api: 'https://openrouter.ai/api/v1' },
    };
    assert.equal(modelsDevProviderId('https://opencode.ai/zen/go', catalog), 'opencode-go');
    assert.equal(modelsDevProviderId('https://opencode.ai/zen', catalog), 'opencode');
    assert.equal(modelsDevProviderId('https://openrouter.ai/api', catalog), 'openrouter');
    assert.equal(modelsDevProviderId('https://api.openai.com', catalog), 'openai');
    assert.equal(modelsDevProviderId('https://my-proxy.example/v1', catalog), undefined);
    assert.equal(modelsDevProviderId('http://localhost:1234', catalog), undefined);
  });

  it('gets Muse Spark from the Go catalog and backfills other providers without replacing upstream limits', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      async json() {
        return {
          opencode: { api: 'https://opencode.ai/zen/v1', models: {} },
          'opencode-go': { api: 'https://opencode.ai/zen/go/v1', models: {
            'muse-spark-1.3-contributor': { limit: { context: 1_048_576 }, reasoning: true },
          } },
          openrouter: { api: 'https://openrouter.ai/api/v1', models: {
            'meta/muse-spark-1.3': { limit: { context: 1_048_576 } },
          } },
        };
      },
    });
    try {
      const go = await enrichModelsFromModelsDev('https://opencode.ai/zen/go', {
        data: [{ id: 'muse-spark-1.3-contributor' }],
      });
      assert.equal(go.data[0].max_context_length, 1_048_576);
      assert.deepEqual(go.data[0].reasoning, { allowed_options: ['on'], default: 'on' });
      const router = await enrichModelsFromModelsDev('https://openrouter.ai/api', {
        data: [{ id: 'meta/muse-spark-1.3' }, { id: 'meta/muse-spark-1.3', max_context_length: 8192 }],
      });
      assert.equal(router.data[0].max_context_length, 1_048_576);
      assert.equal(router.data[1].max_context_length, 8192);
    } finally {
      globalThis.fetch = originalFetch;
      resetModelsDevContextCacheForTests();
    }
  });

  it('shares one catalog request across simultaneous providers', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return { ok: true, async json() { return {
        openai: { models: { 'custom-openai': { limit: { context: 64_000 } } } },
        anthropic: { models: { 'custom-anthropic': { limit: { context: 200_000 } } } },
      }; } };
    };
    try {
      const [openai, anthropic] = await Promise.all([
        enrichModelsFromModelsDev('https://api.openai.com', { data: [{ id: 'custom-openai' }] }),
        enrichModelsFromModelsDev('https://api.anthropic.com', { data: [{ id: 'custom-anthropic' }] }),
      ]);
      assert.equal(calls, 1);
      assert.equal(openai.data[0].max_context_length, 64_000);
      assert.equal(anthropic.data[0].max_context_length, 200_000);
    } finally {
      globalThis.fetch = originalFetch;
      resetModelsDevContextCacheForTests();
    }
  });

  it('reads current catalog effort controls for Zen, Go, OpenAI, Anthropic, and DeepSeek', async () => {
    const originalFetch = globalThis.fetch;
    const deepseek = { reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'high', 'max'] }] };
    const muse = { reasoning: true, reasoning_options: [{ type: 'effort', values: ['minimal', 'low', 'medium', 'high', 'xhigh'] }] };
    globalThis.fetch = async () => ({ ok: true, async json() { return {
      opencode: { models: { 'deepseek-v4.1-flash': deepseek, 'muse-spark-1.3-contributor-free': muse } },
      'opencode-go': { models: { 'deepseek-v4.1-flash': deepseek, 'muse-spark-1.3-contributor': muse } },
      openai: { models: { 'gpt-5.4': { reasoning: true, reasoning_options: [{ type: 'effort', values: ['none', 'low', 'medium', 'high', 'xhigh'] }] } } },
      anthropic: { models: { 'claude-sonnet-4-6': { reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high'] }, { type: 'toggle' }] } } },
      deepseek: { models: { 'deepseek-v4.1-flash': deepseek } },
    }; } });
    try {
      for (const [endpoint, modelId, expected] of [
        ['https://opencode.ai/zen', 'deepseek-v4.1-flash', ['low', 'high', 'max']],
        ['https://opencode.ai/zen/go', 'deepseek-v4.1-flash', ['low', 'high', 'max']],
        ['https://opencode.ai/zen', 'muse-spark-1.3-contributor-free', ['minimal', 'low', 'medium', 'high', 'xhigh']],
        ['https://opencode.ai/zen/go', 'muse-spark-1.3-contributor', ['minimal', 'low', 'medium', 'high', 'xhigh']],
        ['https://api.openai.com/v1', 'gpt-5.4', ['none', 'low', 'medium', 'high', 'xhigh']],
        ['https://api.anthropic.com', 'claude-sonnet-4-6', ['off', 'low', 'medium', 'high']],
        ['https://api.deepseek.com', 'deepseek-v4.1-flash', ['low', 'high', 'max']],
      ]) {
        const result = await enrichModelsFromModelsDev(endpoint, { data: [{ id: modelId, max_context_length: 32768 }] });
        assert.deepEqual(result.data[0].reasoning.allowed_options, expected, `${endpoint}: ${modelId}`);
      }
      const proxy = await enrichModelsFromModelsDev('https://my-proxy.example/v1', { data: [{ id: 'gpt-5.4' }] });
      assert.equal(proxy.data[0].reasoning, undefined);
    } finally {
      globalThis.fetch = originalFetch;
      resetModelsDevContextCacheForTests();
    }
  });

  it('preserves upstream controls while filling default-only metadata', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, async json() { return {
      openai: { models: { model: { reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high', 'xhigh'] }] } } },
    }; } });
    try {
      const upstream = { allowed_options: ['low', 'high'], default: 'high' };
      const result = await enrichModelsFromModelsDev('https://api.openai.com', { data: [
        { id: 'model', reasoning: upstream },
        { id: 'model', reasoning: { default: 'high' } },
        { id: 'model', reasoning: { allowed_options: [], default: 'unsupported' } },
      ] });
      assert.equal(result.data[0].reasoning, upstream);
      assert.deepEqual(result.data[1].reasoning, { allowed_options: ['low', 'medium', 'high', 'xhigh'], default: 'high' });
      assert.equal(result.data[2].reasoning.default, 'medium');
    } finally {
      globalThis.fetch = originalFetch;
      resetModelsDevContextCacheForTests();
    }
  });

  it('distinguishes toggles and token budgets from named effort levels', () => {
    assert.deepEqual(modelsDevReasoningBlock({ reasoning: true, reasoning_options: [] }, 'deepseek'), { allowed_options: ['on'], default: 'on' });
    assert.deepEqual(modelsDevReasoningBlock({ reasoning_options: [{ type: 'toggle' }] }, 'deepseek'), { allowed_options: ['off', 'on'], default: 'on' });
    const budget = { reasoning: true, reasoning_options: [{ type: 'budget_tokens', min: 1024 }] };
    assert.deepEqual(modelsDevReasoningBlock(budget, 'anthropic'), { allowed_options: ['off', 'on'], default: 'on' });
    assert.deepEqual(modelsDevReasoningBlock(budget, 'opencode'), { allowed_options: ['on'], default: 'on' });
    assert.equal(modelsDevReasoningBlock({ reasoning_options: [{ type: 'budget_tokens', min: -1 }] }, 'anthropic'), undefined);
    assert.equal(modelsDevReasoningBlock({ reasoning: false, reasoning_options: [] }, 'openai'), undefined);
    assert.deepEqual(modelsDevReasoningBlock({ reasoning_options: [{ type: 'effort', values: ['', null, 'high', 'high'] }] }, 'openai'), { allowed_options: ['high'], default: 'high' });
  });

  it('enrichOpenCodeModelsFromModelsDev attaches limit.context by exact id', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      assert.equal(String(url), 'https://models.dev/api.json');
      return {
        ok: true,
        async json() {
          return {
            opencode: {
              models: {
                'claude-opus-4-8': { limit: { context: 1_000_000, output: 128_000 } },
                'big-pickle': { limit: { context: 200_000, output: 32_000 } },
              },
            },
          };
        },
      };
    };

    try {
      const out = await enrichOpenCodeModelsFromModelsDev({
        data: [
          { id: 'claude-opus-4-8', type: 'llm', state: 'loaded' },
          { id: 'big-pickle', type: 'llm', state: 'loaded' },
          { id: 'unknown-model', type: 'llm', state: 'loaded' },
        ],
      });

      assert.equal(out.data[0].max_context_length, 1_000_000);
      assert.equal(out.data[1].max_context_length, 200_000);
      assert.equal(out.data[2].max_context_length, undefined);
    } finally {
      globalThis.fetch = originalFetch;
      resetModelsDevContextCacheForTests();
    }
  });

  it('enrichOpenCodeModelsFromModelsDev overrides stale substring fallback values', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      async json() {
        return {
          opencode: {
            models: {
              'gpt-5.5': { limit: { context: 1_050_000, output: 128_000 } },
            },
          },
        };
      },
    });

    try {
      const out = await enrichOpenCodeModelsFromModelsDev({
        data: [{ id: 'gpt-5.5', type: 'llm', state: 'loaded', max_context_length: 400_000 }],
      });
      assert.equal(out.data[0].max_context_length, 1_050_000);
    } finally {
      globalThis.fetch = originalFetch;
      resetModelsDevContextCacheForTests();
    }
  });

  it('enrichOpenCodeModelsFromModelsDev attaches claude-sonnet-4-5 context by exact id', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      assert.equal(String(url), 'https://models.dev/api.json');
      return {
        ok: true,
        async json() {
          return {
            opencode: {
              models: {
                'claude-sonnet-4-5': { limit: { context: 200_000, output: 64_000 } },
              },
            },
          };
        },
      };
    };

    try {
      const out = await enrichOpenCodeModelsFromModelsDev({
        data: [{ id: 'claude-sonnet-4-5', type: 'llm', state: 'loaded' }],
      });
      assert.equal(out.data[0].max_context_length, 200_000);
    } finally {
      globalThis.fetch = originalFetch;
      resetModelsDevContextCacheForTests();
    }
  });
});
