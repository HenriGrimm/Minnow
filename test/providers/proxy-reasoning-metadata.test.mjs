import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createProviderTestServer, httpRequest, rmTestHome, setTestHome } from './test-helpers.js';
import { resetModelsDevContextCacheForTests } from '../../server/providers/models-dev-context.js';

test('model proxy enriches reasoning even when upstream context lengths are complete', async () => {
  const previousHome = process.env.MINNOW_HOME;
  const originalFetch = globalThis.fetch;
  const home = setTestHome(process.env, 'minnow-reasoning-metadata');
  const server = createProviderTestServer();
  const modelId = 'deepseek-v4.1-flash';
  let catalogCalls = 0;
  globalThis.fetch = async (url) => {
    if (String(url) === 'https://models.dev/api.json') {
      catalogCalls++;
      return { ok: true, async json() { return {
        'opencode-go': { api: 'https://opencode.ai/zen/go/v1', models: {
          [modelId]: { reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'high', 'max'] }] },
        } },
        openai: { api: 'https://api.openai.com/v1', models: {
          [modelId]: { reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'high', 'max'] }] },
        } },
      }; } };
    }
    return { ok: true, async json() { return { data: [{ id: modelId, max_context_length: 262144 }] }; } };
  };
  resetModelsDevContextCacheForTests();
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const [id, baseUrl] of [
      ['reasoning-go', 'https://opencode.ai/zen/go'],
      ['reasoning-hosted', 'https://api.openai.com'],
    ]) {
      const created = await httpRequest(base, 'POST', '/api/providers', {
        id, label: id, baseUrl, apiKind: 'openai-v1',
      });
      assert.equal(created.status, 201);
      const result = await httpRequest(base, 'GET', `/api/providers/${id}/models`);
      assert.equal(result.status, 200);
      assert.deepEqual(result.json.data[0].reasoning.allowed_options, ['low', 'high', 'max']);
    }
    assert.equal(catalogCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    resetModelsDevContextCacheForTests();
    await new Promise((resolve) => server.close(resolve));
    await rmTestHome(home);
    if (previousHome === undefined) delete process.env.MINNOW_HOME;
    else process.env.MINNOW_HOME = previousHome;
  }
});
