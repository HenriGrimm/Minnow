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
            'muse-spark-1.3-contributor': { limit: { context: 1_048_576 } },
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
