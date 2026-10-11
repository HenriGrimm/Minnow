import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, mock, test } from 'node:test';

let serves = [];
let downloads = [];
let mtplxModels = [];
mock.module('../../server/models/serve.js', { namedExports: { listServes: async () => serves } });
mock.module('../../server/models/download.js', { namedExports: { listDownloads: async () => downloads } });
mock.module('../../server/models/mtplx-cache.js', { namedExports: { scanMtplxCache: async () => mtplxModels } });
const { deleteLibraryModel } = await import('../../server/models/delete.js');
const { listCachedModels, invalidateCachedModelsCache } = await import('../../server/models/cached.js');
const { withModelArtifactAccess } = await import('../../server/models/artifact-access.js');
const { resetMinnowHomeCache } = await import('../../server/config/home.js');

let home;
let previousHome;
const repoId = 'minnow-delete-test/weights';
const id = (name) => `gguf:${repoId}:${name}`;
const artifact = (name) => path.join(home, 'models', 'artifacts', repoId.replace('/', '--'), name);
async function write(filename, content = 'GGUF') {
  await fsp.mkdir(path.dirname(filename), { recursive: true });
  await fsp.writeFile(filename, content);
}
async function exists(filename) {
  return fsp.access(filename).then(() => true, () => false);
}

beforeEach(async () => {
  previousHome = process.env.MINNOW_HOME;
  home = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'minnow-delete-')));
  process.env.MINNOW_HOME = home;
  resetMinnowHomeCache();
  invalidateCachedModelsCache();
  serves = [];
  downloads = [];
  mtplxModels = [];
});
afterEach(async () => {
  if (previousHome === undefined) delete process.env.MINNOW_HOME;
  else process.env.MINNOW_HOME = previousHome;
  resetMinnowHomeCache();
  invalidateCachedModelsCache();
  await fsp.rm(home, { recursive: true, force: true });
});

test('deletes selected downloaded quantization and invalidates the cached list', async () => {
  const chosen = artifact('model-Q4_K_M.gguf');
  const other = artifact('model-Q8_0.gguf');
  const projector = artifact('mmproj.gguf');
  await Promise.all([write(chosen), write(other), write(projector)]);
  await listCachedModels();
  await deleteLibraryModel(id(path.basename(chosen)), chosen);
  assert.equal(await exists(chosen), false);
  assert.equal(await exists(other), true);
  assert.equal(await exists(projector), true);
  const { models } = await listCachedModels();
  assert.equal(models.find((m) => m.repo_id === repoId).gguf_files.some((f) => f.name === path.basename(chosen)), false);
});

test('deletes all matching split shards, keeping other quantizations', async () => {
  const shards = [1, 2, 3].map((n) => artifact(`model-Q4_K_M-${String(n).padStart(5, '0')}-of-00003.gguf`));
  const other = artifact('model-Q8_0-00001-of-00003.gguf');
  await Promise.all([...shards, other].map((p) => write(p)));
  await deleteLibraryModel(id(path.basename(shards[0])), shards[0]);
  assert.deepEqual(await Promise.all(shards.map(exists)), [false, false, false]);
  assert.equal(await exists(other), true);
});

test('rejects arbitrary ids, traversal and stale paths without removing files', async () => {
  const chosen = artifact('model.gguf');
  const outside = path.join(home, 'keep.gguf');
  await Promise.all([write(chosen), write(outside)]);
  await assert.rejects(deleteLibraryModel(id('../../keep.gguf'), outside), /not found/);
  await assert.rejects(deleteLibraryModel('mlx:../../..', home), /not found/);
  await assert.rejects(deleteLibraryModel(id('model.gguf'), outside), /location changed/);
  assert.equal(await exists(chosen), true);
  assert.equal(await exists(outside), true);
});

test('validates every split target before deleting any shard', async () => {
  const chosen = artifact('model-00001-of-00002.gguf');
  const invalidShard = artifact('model-00002-of-00002.gguf');
  await write(chosen);
  await fsp.mkdir(invalidShard);
  await assert.rejects(deleteLibraryModel(id(path.basename(chosen)), chosen), /linked model file/);
  assert.equal(await exists(chosen), true);
  assert.equal(await exists(invalidShard), true);
});

for (const status of ['starting', 'running', 'unhealthy']) {
  test(`requires eject for a ${status} model`, async () => {
    const chosen = artifact('model.gguf');
    await write(chosen);
    serves = [{ modelPath: chosen, status }];
    await assert.rejects(deleteLibraryModel(id('model.gguf'), chosen), /Eject/);
    assert.equal(await exists(chosen), true);
  });
}

test('protects unfinished downloads, including paused and failed transfers', async () => {
  const chosen = artifact('model.gguf');
  await write(chosen);
  for (const status of ['queued', 'running', 'paused', 'interrupted', 'failed']) {
    downloads = [{ repoId, destPath: chosen, status }];
    await assert.rejects(deleteLibraryModel(id('model.gguf'), chosen), /download/);
  }
  downloads = [{ repoId, destPath: chosen, status: 'completed' }];
  await deleteLibraryModel(id('model.gguf'), chosen);
  assert.equal(await exists(chosen), false);
});

test('deletes from a configured custom folder without deleting its siblings', async () => {
  const root = path.join(home, 'custom');
  const chosen = path.join(root, 'publisher', 'model', 'model.gguf');
  const other = path.join(root, 'publisher', 'model', 'other.gguf');
  await Promise.all([write(chosen), write(other)]);
  await write(path.join(home, 'config.json'), JSON.stringify({ models: { modelDirs: [root] } }));
  await deleteLibraryModel('gguf:publisher/model:model.gguf', chosen);
  assert.equal(await exists(chosen), false);
  assert.equal(await exists(other), true);
});

test('deletes an MLX artifact folder and all of its weights and config', async () => {
  const root = path.dirname(artifact('config.json'));
  await write(path.join(root, 'config.json'), JSON.stringify({ quantization: { bits: 4, group_size: 64 } }));
  await write(path.join(root, 'model.safetensors'));
  await write(path.join(root, 'tokenizer.json'));
  await deleteLibraryModel(`mlx:${repoId}`, root);
  assert.equal(await exists(root), false);
});

test('deletes an MTPLX cache folder by its library identity, keeping sibling models', async () => {
  const root = path.join(home, 'mtplx-cache', repoId.replace('/', '--'));
  const sibling = path.join(home, 'mtplx-cache', 'other--model', 'model.safetensors');
  await write(path.join(root, 'config.json'), '{}');
  await write(path.join(root, 'model.safetensors'));
  await write(sibling);
  mtplxModels = [{ repo_id: repoId, path: root, mlx_root: root, mtplx_root: root }];
  await assert.rejects(deleteLibraryModel(`mlx:${repoId}`, root), /not found/);
  await withModelArtifactAccess([root], false, async () => {
    await assert.rejects(deleteLibraryModel(`mtplx:${repoId}`, root), /busy/);
  });
  serves = [{ modelPath: root, status: 'running' }];
  await assert.rejects(deleteLibraryModel(`mtplx:${repoId}`, root), /Eject/);
  serves = [];
  await deleteLibraryModel(`mtplx:${repoId}`, root);
  assert.equal(await exists(root), false);
  assert.equal(await exists(sibling), true);
});

test('deletes an HF MLX repo with all revisions and blobs, keeping other repos', async () => {
  const cache = path.join(home, 'hub');
  const root = path.join(cache, 'models--minnow-delete-test--mlx');
  const snapshot = path.join(root, 'snapshots', 'rev1');
  const previous = process.env.HF_HUB_CACHE;
  process.env.HF_HUB_CACHE = cache;
  try {
    for (const rev of ['rev1', 'rev2']) {
      await write(path.join(root, 'snapshots', rev, 'config.json'), JSON.stringify({ quantization: { bits: 4, group_size: 64 } }));
      await write(path.join(root, 'snapshots', rev, 'model.safetensors'));
    }
    await write(path.join(root, 'blobs', 'weights'));
    const sibling = path.join(cache, 'models--minnow-delete-test--other', 'blobs', 'weights');
    await write(sibling);
    await deleteLibraryModel('mlx:minnow-delete-test/mlx', snapshot);
    assert.equal(await exists(root), false);
    assert.equal(await exists(sibling), true);
  } finally {
    if (previous === undefined) delete process.env.HF_HUB_CACHE;
    else process.env.HF_HUB_CACHE = previous;
  }
});

test('blocks deletion while model files are being admitted for loading or downloading', async () => {
  const chosen = artifact('model.gguf');
  await write(chosen);
  await withModelArtifactAccess([path.dirname(chosen)], false, async () => {
    await assert.rejects(deleteLibraryModel(id('model.gguf'), chosen), /busy/);
  });
  await deleteLibraryModel(id('model.gguf'), chosen);
  assert.equal(await exists(chosen), false);
});

test('blocks loading during deletion and releases the guard even after failure', async () => {
  const chosen = artifact('model.gguf');
  await assert.rejects(withModelArtifactAccess([chosen], true, async () => {
    await assert.rejects(withModelArtifactAccess([chosen], false, async () => {}), /busy/);
    throw new Error('removal failed');
  }), /removal failed/);
  await withModelArtifactAccess([chosen], false, async () => {});
});
