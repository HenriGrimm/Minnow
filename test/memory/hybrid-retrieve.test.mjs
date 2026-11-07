/**
 * Hybrid memory retrieval: vector + keyword blend and fallback behavior.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { retrieveMemoryBlockHybrid } from '../../server/memory/retrieve.js';
import { upsertEntryVector } from '../../server/memory/vector-store.js';

const ENTRY_A = '11111111-1111-1111-1111-111111111111';
const ENTRY_B = '22222222-2222-2222-2222-222222222222';

const META_A = {
  id: ENTRY_A,
  title: 'npm workflow',
  tags: ['npm'],
  updatedAt: '2026-05-19T12:00:00.000Z',
  pinned: false,
};

const META_B = {
  id: ENTRY_B,
  title: 'Python only',
  tags: ['python'],
  updatedAt: '2026-05-19T11:00:00.000Z',
  pinned: false,
};

const FIXTURE_EMBEDDER = {
  id: 'fixture-model',
  backend: 'local',
  dim: 3,
  embed: async () => [[1, 0, 0]],
};

let homeDir;

before(async () => {
  homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-hybrid-retrieve-'));
  process.env.MINNOW_HOME = homeDir;
  resetMinnowHomeCache();

  await upsertEntryVector(ENTRY_A, [1, 0, 0], {
    model: 'fixture-model',
    backend: 'local',
    dim: 3,
  });
  await upsertEntryVector(ENTRY_B, [0, 1, 0], {
    model: 'fixture-model',
    backend: 'local',
    dim: 3,
  });
});

after(async () => {
  delete process.env.MINNOW_HOME;
  resetMinnowHomeCache();
  await fs.rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe('hybrid memory retrieve', () => {
  test('paraphrase query with no keyword overlap prefers vector match', async () => {
    const all = [
      { meta: META_A, body: 'Use npm start for integration tests.' },
      { meta: META_B, body: 'Use poetry for Python projects.' },
    ];

    const { block, ids } = await retrieveMemoryBlockHybrid(
      all,
      { query: 'package manager launch command', limit: 4, maxChars: 4000 },
      {
        embeddings: {
          enabled: true,
          backend: 'local',
          modelId: 'fixture-model',
          blendWeight: 1,
          queryTimeoutMs: 3000,
        },
      },
      {
        getEmbedder: async () => FIXTURE_EMBEDDER,
        embedTexts: async (embedder, texts) => embedder.embed(texts),
      },
    );

    assert.match(block, /npm workflow/);
    assert.doesNotMatch(block, /Python only/);
    assert.deepEqual(ids, [ENTRY_A]);
  });

  test('embedding failure falls back to keyword retrieval', async () => {
    const all = [
      { meta: META_A, body: 'Use npm start for integration tests.' },
      { meta: META_B, body: 'Use poetry for Python projects.' },
    ];

    const { block } = await retrieveMemoryBlockHybrid(
      all,
      { query: 'npm', limit: 4, maxChars: 4000 },
      {
        embeddings: {
          enabled: true,
          backend: 'local',
          modelId: 'fixture-model',
        },
      },
      {
        getEmbedder: async () => {
          throw new Error('embedder unavailable');
        },
        embedTexts: async () => {
          throw new Error('embedder unavailable');
        },
      },
    );

    assert.match(block, /npm workflow/);
    assert.doesNotMatch(block, /Python only/);
  });

  test('disabled embeddings uses keyword-only path', async () => {
    const all = [
      { meta: META_A, body: 'Use npm start for integration tests.' },
      { meta: META_B, body: 'Use poetry for Python projects.' },
    ];
    const { block } = await retrieveMemoryBlockHybrid(
      all,
      { query: 'npm', limit: 4, maxChars: 4000 },
      { embeddings: { enabled: false } },
    );
    assert.match(block, /npm workflow/);
    assert.doesNotMatch(block, /Python only/);
  });

  test('automatic injection with no topic match skips embeddings', async () => {
    const result = await retrieveMemoryBlockHybrid(
      [{ meta: META_A, body: 'Use npm to build a web game.' }],
      { query: 'Lets make a chess web game', autoInject: true },
      { embeddings: { enabled: true } },
      { getEmbedder: async () => { throw new Error('should not run'); } },
    );
    assert.deepEqual(result, { block: '', ids: [] });
  });
});


test('cold initialization and vector query use one end-to-end deadline', async () => {
  const all = [{ meta: META_A, body: 'Use npm start.' }];
  let release;
  let queries = 0;
  const init = new Promise(resolve => { release = resolve; });
  const result = await retrieveMemoryBlockHybrid(all, { query: 'npm' }, { embeddings: { queryTimeoutMs: 20 } }, {
    getEmbedder: () => init,
    embedTexts: async () => { queries++; return [[1, 0, 0]]; },
  });
  assert.match(result.block, /npm workflow/);
  assert.equal(result.enrichmentOmitted, 'deadline');
  release(FIXTURE_EMBEDDER);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(queries, 0, 'late cold setup must not launch an embedding query');
});

test('one cancelled caller cannot poison shared cold initialization for another caller', async () => {
  const all = [{ meta: META_A, body: 'Use npm start.' }];
  const controller = new AbortController();
  let release, entered;
  const init = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { entered = resolve; });
  const deps = { getEmbedder: () => { entered(); return init; }, embedTexts: async () => [[1, 0, 0]] };
  const cancelled = retrieveMemoryBlockHybrid(all, { query: 'npm', signal: controller.signal }, { embeddings: { queryTimeoutMs: 1000 } }, deps);
  const other = retrieveMemoryBlockHybrid(all, { query: 'npm' }, { embeddings: { queryTimeoutMs: 1000 } }, deps);
  await ready;
  controller.abort(new Error('Stopped caller'));
  await assert.rejects(cancelled, /Stopped caller/);
  release(FIXTURE_EMBEDDER);
  const result = await other;
  assert.match(result.block, /npm workflow/);
  assert.equal(result.enrichmentOmitted, undefined);
});
