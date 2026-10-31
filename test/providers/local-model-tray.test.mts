import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

const providers = [
  { id: 'local', label: 'Local', apiKind: 'lm-studio-v0', enabled: true, supportsModelLoadUnload: true },
  { id: 'cli', label: 'Codex', apiKind: 'agent-cli-v1', enabled: true },
  { id: 'cloud', label: 'Cloud', apiKind: 'openai-v1', enabled: true },
];
let calls = 0;
let queried: string[] = [];
await mock.module('../../src/providers/store.ts', { namedExports: { listProviders: async () => ({ providers }) } });
await mock.module('../../src/api/models.ts', { namedExports: { unloadModel: async () => {} } });
await mock.module('../../src/models/api-client.ts', { namedExports: { listModelServes: async () => [], stopModelServe: async () => {} } });
await mock.module('../../src/providers/fetch-all-models.ts', { namedExports: {
  fetchModelsForAllProviders: async (rows: typeof providers) => {
    calls += 1; queried = rows.map(row => row.id);
    return rows.map(provider => ({ provider, models: [{ id: 'model', state: 'loaded' }] }));
  },
} });
const { collectLocalModelTraySnapshot, invalidateLocalModelTraySnapshot } = await import('../../src/providers/local-model-tray.ts');

test('activity refreshes share local inventory and skip CLI/cloud catalogs', async () => {
  invalidateLocalModelTraySnapshot(); calls = 0;
  const snapshots = await Promise.all(Array.from({ length: 20 }, () => collectLocalModelTraySnapshot()));
  assert.equal(calls, 1);
  assert.deepEqual(queried, ['local']);
  assert.ok(snapshots.every(row => row.count === 1));
  await collectLocalModelTraySnapshot();
  assert.equal(calls, 1);
  invalidateLocalModelTraySnapshot();
  await collectLocalModelTraySnapshot();
  assert.equal(calls, 2, 'model changes invalidate activity cache');
  await collectLocalModelTraySnapshot(undefined, { fresh: true });
  assert.equal(calls, 3, 'explicit unload/audit requests bypass the cache');
});
