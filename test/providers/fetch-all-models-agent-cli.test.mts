import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchModelsForAllProviders } from '../../src/providers/fetch-all-models.ts';
import type { ProviderPublic } from '../../src/providers/types.ts';

test('fetches an enabled agent CLI catalog through the provider proxy without a base URL', async () => {
  const provider: ProviderPublic = {
    id: 'codex-cli',
    label: 'Codex CLI',
    baseUrl: '',
    apiKind: 'agent-cli-v1',
    enabled: true,
    hasApiKey: false,
    hasBearer: false,
  };
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = async (input) => {
    urls.push(String(input));
    return new Response(JSON.stringify({ data: [{ id: 'gpt-5.3-codex', type: 'llm' }] }), {
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    const results = await fetchModelsForAllProviders([provider], new AbortController().signal);
    assert.deepEqual(urls, ['/api/providers/codex-cli/models']);
    assert.deepEqual(results[0].models.map((model) => model.id), ['gpt-5.3-codex']);
    assert.equal(results[0].error, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
