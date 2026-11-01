import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeModelsResponse } from '../../server/providers/paths.js';
import { fetchModelsForProvider } from '../../src/providers/fetch-models.ts';

test('OpenCode Go chat models survive catalog normalization and picker filtering', async () => {
  const provider = {
    id: 'opencode-go', label: 'OpenCode Go', baseUrl: 'https://opencode.ai/zen/go',
    apiKind: 'openai-v1' as const, enabled: true, hasApiKey: true, hasBearer: false,
  };
  const normalized = normalizeModelsResponse(provider.apiKind, {
    data: [
      { id: 'deepseek-v4.1-flash', type: 'chat', context_length: 1000000,
        reasoning: { allowed_options: ['low', 'high', 'max'], default: 'low' } },
      { id: 'vision-model', type: 'vlm' },
      { id: 'embedding-model', type: 'embeddings' },
      { id: 'image-model', type: 'image' },
    ],
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(url, '/api/providers/opencode-go/models');
    return Response.json(normalized);
  };
  try {
    const models = await fetchModelsForProvider(provider, new AbortController().signal);
    assert.deepEqual(models.map(({ id, type }) => ({ id, type })), [
      { id: 'deepseek-v4.1-flash', type: 'llm' },
      { id: 'vision-model', type: 'vlm' },
    ]);
    assert.equal(models[0].max_context_length, 1000000);
    assert.deepEqual(models[0].reasoning?.allowed_options, ['low', 'high', 'max']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
