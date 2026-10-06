/**
 * Engine vector store smoke test — arbitrary rootDir, no memory dir coupling.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createVectorStore } from '../../server/engine/vector-store.js';

const ENTRY_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

/** @type {string} */
let rootDir;
let getPaths;

/** @type {ReturnType<typeof createVectorStore>} */
let vectorStore;

before(async () => {
  rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-engine-vector-'));
  const vectorsPath = path.join(rootDir, 'vectors.json');
  getPaths = () => ({
    rootDir,
    vectorsPath,
    proposalsPath: path.join(rootDir, 'proposals.json'),
    backupsDir: path.join(rootDir, 'backups'),
  });
  vectorStore = createVectorStore(getPaths);
});

after(async () => {
  await fs.rm(rootDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe('engine vector store', () => {
  test('round-trips a vector under the injected rootDir', async () => {
    const vector = [0.6, 0.8, 0.0];
    await vectorStore.upsertEntryVector(ENTRY_ID, vector, {
      model: 'smoke-model',
      backend: 'local',
      dim: 3,
    });

    const stored = await vectorStore.getEntryVector(ENTRY_ID);
    assert.deepEqual(stored, vector);
    assert.equal(await vectorStore.getVectorCount(), 1);

    const vectorsFile = path.join(rootDir, 'vectors.json');
    const raw = await fs.readFile(vectorsFile, 'utf8');
    const parsed = JSON.parse(raw);
    assert.deepEqual(parsed.vectors[ENTRY_ID], vector);
    assert.equal(vectorStore.getVectorStorePath(), vectorsFile);
    assert.equal(path.dirname(vectorsFile), rootDir);
  });

  test('keeps concurrent upserts from separate bindings', async () => {
    await vectorStore.clearVectorStore();
    const otherBinding = createVectorStore(getPaths);
    const ids = Array.from({ length: 24 }, (_, index) =>
      `${String(index + 1).padStart(8, '0')}-aaaa-aaaa-aaaa-aaaaaaaaaaaa`);

    await Promise.all(ids.map((id, index) =>
      (index % 2 ? vectorStore : otherBinding).upsertEntryVector(id, [index, 1])));

    const store = await vectorStore.loadVectorStore();
    assert.equal(Object.keys(store.vectors).length, ids.length);
    for (const [index, id] of ids.entries()) {
      assert.deepEqual(store.vectors[id], [index, 1]);
    }
  });

  test('serializes a delete with concurrent upserts across bindings', async () => {
    await vectorStore.clearVectorStore();
    const otherBinding = createVectorStore(getPaths);
    await vectorStore.upsertEntryVector(ENTRY_ID, [1, 0]);
    const addedId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const [deleted] = await Promise.all([
      vectorStore.deleteEntryVector(ENTRY_ID),
      otherBinding.upsertEntryVector(addedId, [0, 1]),
    ]);
    assert.equal(deleted, true);
    assert.deepEqual((await vectorStore.loadVectorStore()).vectors, { [addedId]: [0, 1] });
  });

  test('does not lose an update made while reindexing', async () => {
    await vectorStore.clearVectorStore();
    const otherBinding = createVectorStore(getPaths);
    const addedId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    let releaseEmbed;
    let signalEmbedding;
    const embedding = new Promise((resolve) => { signalEmbedding = resolve; });
    const canFinish = new Promise((resolve) => { releaseEmbed = resolve; });
    const reindex = vectorStore.reindexAllMemoryEntries(async () => {
      signalEmbedding();
      await canFinish;
      return [1, 0];
    }, [{ meta: { id: ENTRY_ID, title: 'First' }, body: 'Body' }],
    { model: 'smoke-model', backend: 'local', dim: 2 });
    await embedding;
    const upsert = otherBinding.upsertEntryVector(addedId, [0, 1]);
    releaseEmbed();
    await Promise.all([reindex, upsert]);

    assert.deepEqual((await vectorStore.loadVectorStore()).vectors, {
      [ENTRY_ID]: [1, 0],
      [addedId]: [0, 1],
    });
  });
});
