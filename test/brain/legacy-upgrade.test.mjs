import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createLegacyBrainUpgrade, createLegacyBrainUpgradeMiddleware } from '../../server/brain/legacy-upgrade.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-wiki-upgrade-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  async function put(rel) {
    const file = path.join(root, rel);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, rel);
  }
  return { root, put, read: rel => fs.readFile(path.join(root, rel), 'utf8') };
}

test('fresh Brain does not prompt; Skip survives a restart without deleting old data', async t => {
  const { root, put, read } = await fixture(t);
  const create = () => createLegacyBrainUpgrade({ brainDir: () => root, refreshCatalog: assert.fail });
  await put('pages/facts/.gitkeep');
  await put('pages/memory/user/current.md');
  const upgrade = create();
  assert.deepEqual(await upgrade(null), { pending: false });
  await put('pages/facts/legacy.md');
  assert.deepEqual(await upgrade(null), { pending: true });
  await upgrade('skip');
  assert.deepEqual(await create()(null), { pending: false });
  assert.equal(await read('pages/facts/legacy.md'), 'pages/facts/legacy.md');
});

test('clean preserves scoped memories, code and shared synthesis; failed cleanup stays retryable', async t => {
  const { root, put, read } = await fixture(t);
  const retained = ['pages/memory/projects/key/current.md', 'code/project.db', 'synthesis-state.json'];
  await Promise.all([...retained, 'pages/facts/old.md', 'sources/archive.txt', 'proposals.json'].map(put));
  let attempts = 0;
  const create = () => createLegacyBrainUpgrade({
    brainDir: () => root,
    refreshCatalog: async () => { if (++attempts === 1) throw new Error('catalog busy'); },
  });
  await assert.rejects(create()('clean'), /catalog busy/);
  const retry = create();
  assert.deepEqual(await retry(null), { pending: true });
  await retry('clean');
  for (const file of retained) assert.equal(await read(file), file);
  for (const file of ['pages/facts/old.md', 'sources/archive.txt', 'proposals.json']) {
    await assert.rejects(read(file), { code: 'ENOENT' });
  }
  assert.deepEqual(await create()(null), { pending: false });
});

test('only the host with explicit confirmation can request cleanup', async () => {
  let cleaned = false;
  const middleware = createLegacyBrainUpgradeMiddleware(action => { cleaned = action === 'clean'; });
  async function post(kind, confirm) {
    const res = { setHeader() {}, end() {} };
    await middleware({
      url: '/api/brain/legacy-upgrade/clean', method: 'POST',
      minnowAuth: { kind }, headers: { 'x-minnow-confirm-legacy-wiki': confirm },
    }, res, assert.fail);
    return res.statusCode;
  }
  assert.equal(await post('device', 'delete'), 403);
  assert.equal(await post('host'), 400);
  assert.equal(cleaned, false);
  assert.equal(await post('host', 'delete'), 200);
  assert.equal(cleaned, true);
});
