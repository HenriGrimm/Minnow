import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createConfigTestServer, httpRequest, setTestHome, rmTestHome } from './test-helpers.js';

test('concurrent routing patches preserve other roles and structural settings', async () => {
  const previous = process.env.MINNOW_HOME;
  const home = setTestHome(process.env, 'minnow-routing-patch');
  const server = createConfigTestServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await httpRequest(base, 'PUT', '/api/config/sub-agents', { globalMaxConcurrent: 7, types: { explore: { providerId: '', modelId: '', enabled: true, maxConcurrent: 2 }, shell: { enabled: false, maxConcurrent: 1 } } })).status, 200);
    const results = await Promise.all([
      httpRequest(base, 'PATCH', '/api/config/sub-agents', { defaultModel: { providerId: 'support', modelId: 'fast' } }),
      httpRequest(base, 'PATCH', '/api/config/sub-agents', { types: { explore: { providerId: 'specialist', modelId: 'deep' } } }),
    ]);
    assert.ok(results.every((result) => result.status === 200));
    const saved = (await httpRequest(base, 'GET', '/api/config/sub-agents')).json;
    assert.equal(saved.globalMaxConcurrent, 7);
    assert.deepEqual(saved.defaultModel, { providerId: 'support', modelId: 'fast' });
    assert.equal(saved.types.explore.modelId, 'deep'); assert.equal(saved.types.explore.maxConcurrent, 2);
    assert.equal(saved.types.shell.enabled, false);
    await httpRequest(base, 'PATCH', '/api/config/sub-agents', { defaultModel: null });
    const cleared = (await httpRequest(base, 'GET', '/api/config/sub-agents')).json;
    assert.equal(cleared.defaultModel ?? null, null); assert.equal(cleared.types.explore.modelId, 'deep');
  } finally { await new Promise((resolve) => server.close(resolve)); await rmTestHome(home); if (previous === undefined) delete process.env.MINNOW_HOME; else process.env.MINNOW_HOME = previous; }
});
