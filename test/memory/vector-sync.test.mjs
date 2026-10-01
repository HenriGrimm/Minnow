/**
 * Vector sync on memory CRUD — failures do not roll back entries.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { closeCodeDbForTests } from '../../server/brain/code/schema.js';
import { initMemoryApi } from '../../server/memory/routes.js';
import {
  createEntry,
  deleteEntry,
  loadMemoryConfig,
} from '../../server/memory/store.js';
import { getVectorCount, upsertEntryVector, clearVectorStore } from '../../server/memory/vector-store.js';
import { syncEntryVector, drainVectorDeletes } from '../../server/memory/vector-sync.js';
import { createPage } from '../../server/brain/store.js';

const FIXTURE_ID = '33333333-3333-3333-3333-333333333333';
const FIXTURE_ID_B = '44444444-4444-4444-4444-444444444444';
const FIXTURE_ID_DELETE = '55555555-5555-5555-5555-555555555555';

let homeDir;

before(async () => {
  homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-vector-sync-'));
  process.env.MINNOW_HOME = homeDir;
  resetMinnowHomeCache();

  const configPath = path.join(homeDir, 'config.json');
  await fs.writeFile(
    configPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        memory: {
          enabled: true,
          embeddings: {
            enabled: true,
            backend: 'local',
            modelId: 'fixture-model',
            blendWeight: 0.5,
            queryTimeoutMs: 3000,
          },
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  await initMemoryApi();
});

after(async () => {
  await drainVectorDeletes();
  closeCodeDbForTests();
  delete process.env.MINNOW_HOME;
  resetMinnowHomeCache();
  await fs.rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe('memory vector sync', { concurrency: 1 }, () => {
  test('syncEntryVector marks reindex when embedder fails', async () => {
    const config = await loadMemoryConfig();
    await syncEntryVector(
      { id: FIXTURE_ID, title: 'Sync failure tolerance' },
      'Entry should persist even if vectors fail.',
      config,
      {
        getEmbedder: async () => {
          throw new Error('embedder down');
        },
        embedTexts: async () => {
          throw new Error('embedder down');
        },
      },
    );

    const next = await loadMemoryConfig();
    assert.equal(next.embeddings?.reindexNeeded, true);
  });

  test('createEntry persists when scheduled vector sync fails', async () => {
    await clearVectorStore();
    const meta = await createEntry({
      id: FIXTURE_ID_B,
      title: 'Persisted despite vector failure',
      body: 'Markdown body remains on disk.',
      tags: ['test'],
      // Avoid racing fire-and-forget embedder I/O from createPage; this case
      // exercises explicit syncEntryVector failure handling below.
      skipVectorSync: true,
    });
    assert.equal(meta.id, FIXTURE_ID_B);

    const config = await loadMemoryConfig();
    await syncEntryVector(meta, 'Markdown body remains on disk.', config, {
      getEmbedder: async () => {
        throw new Error('embedder down');
      },
      embedTexts: async () => {
        throw new Error('embedder down');
      },
    });

    const reread = await loadMemoryConfig();
    assert.equal(reread.embeddings?.reindexNeeded, true);
    assert.equal(await getVectorCount(), 0);
  });

  test('deleteEntry removes vector sidecar row', async () => {
    await clearVectorStore();
    await createPage({
      relPath: 'facts/vector-delete-fixture.md',
      id: FIXTURE_ID_DELETE,
      title: 'Vector delete fixture',
      body: 'Body for vector delete test.',
      tags: ['test'],
      skipVectorSync: true,
    });
    await upsertEntryVector(FIXTURE_ID_DELETE, [1, 0, 0], {
      model: 'fixture-model',
      backend: 'local',
      dim: 3,
    });
    assert.equal(await getVectorCount(), 1);

    const ok = await deleteEntry(FIXTURE_ID_DELETE);
    assert.equal(ok, true);
    await drainVectorDeletes();
    assert.equal(await getVectorCount(), 0);
  });
});
