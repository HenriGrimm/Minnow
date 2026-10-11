import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { handleModelsRequest } from '../../server/models/routes.js';
import { setLibraryBindingDepsForTests, resolveLibraryAttemptBinding } from '../../server/models/library-binding.js';
import { setLibraryLaunchSettings } from '../../server/models/launch-prefs.js';

let home, server, url;
const previousHome = process.env.MINNOW_HOME;
let rows = [], loads = [];
before(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-library-bind-'));
  process.env.MINNOW_HOME = home; resetMinnowHomeCache();
  setLibraryBindingDepsForTests({
    findLiveLlamaCppServe: async () => null, findLiveMlxServe: async () => null,
    listServes: async () => rows,
    listCachedModels: async () => ({ models: [{ repo_id: 'Org/Qwen', mtplx_root: '/models/qwen', mtplx_validated: true, size_bytes: 1024 ** 3 }] }),
    startServe: async body => { loads.push(body); return { ...body, status: 'running' }; },
  });
  server = http.createServer((req, res) => { void handleModelsRequest(req, res, new URL(req.url, 'http://localhost').pathname); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}/api/models/library/bind`;
});
after(async () => {
  setLibraryBindingDepsForTests(null); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  if (previousHome === undefined) delete process.env.MINNOW_HOME; else process.env.MINNOW_HOME = previousHome;
  resetMinnowHomeCache(); await fs.rm(home, { recursive: true, force: true });
});
const bind = body => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
test('binding an already adopted model reuses its actual runtime and upstream identity', async () => {
  rows = [{ status: 'running', runtime: 'mtplx', ownership: 'external', libraryId: 'mtplx:Org/Qwen', modelPath: '/models/qwen', modelLabel: 'native-api-id' }];
  const res = await bind({ providerId: 'minnow-library', modelId: 'mtplx:Org/Qwen' });
  assert.equal(res.status, 200); assert.deepEqual(await res.json(), { providerId: 'mtplx-local', modelId: 'native-api-id' });
  assert.equal(loads.length, 0);
});
test('cold bind honors the saved mlx-lm engine through the shared loader', async () => {
  rows = []; loads = [];
  await setLibraryLaunchSettings('mtplx:Org/Qwen', { engine: 'mlx-lm' });
  const res = await bind({ providerId: 'minnow-library', modelId: 'mtplx:Org/Qwen' });
  assert.equal(res.status, 200); assert.deepEqual(await res.json(), { providerId: 'mlx-lm-local', modelId: '/models/qwen' });
  assert.equal(loads.length, 1); assert.equal(loads[0].async, true); assert.equal(loads[0].weightsGb, 1);
});
test('unknown/incomplete library targets and ordinary providers return clear errors', async () => {
  for (const body of [{ providerId: 'minnow-library', modelId: 'mtplx:missing' }, { providerId: 'other', modelId: 'model' }]) {
    const res = await bind(body); assert.equal(res.status, 400); assert.ok((await res.json()).error);
  }
});
test('an aborted readiness wait stops polling without stopping a shared serve', async () => {
  const controller = new AbortController(); let polls = 0;
  await assert.rejects(resolveLibraryAttemptBinding({ providerId: 'minnow-library', id: 'mtplx:Org/Qwen' }, {
    listServes: async () => [{ id: 'starting', runtime: 'mtplx', libraryId: 'mtplx:Org/Qwen', status: 'starting' }],
    getServe: async () => { polls++; return { status: 'starting' }; },
    sleep: async () => controller.abort(),
  }, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(polls, 1);
});
