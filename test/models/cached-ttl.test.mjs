/**
 * Library scan TTL — two list/enrich calls within 30s must not re-walk disk.
 */

import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import {
  getCachedModelsScanCountForTests,
  invalidateCachedModelsCache,
  listCachedModels,
  resetCachedModelsScanCountForTests,
} from '../../server/models/cached.js';
import { enrichMlxLmModelsWithCachedContext } from '../../server/models/mlx-context-length.js';

describe('cached model scan TTL', () => {
  /** @type {string} */
  let homeDir;
  /** @type {string} */
  let hubDir;
  /** @type {string | undefined} */
  let prevHome;
  /** @type {string | undefined} */
  let prevHub;
  /** @type {string | undefined} */
  let prevHfHub;
  /** @type {string} */
  let mlxDir;

  before(async () => {
    prevHome = process.env.MINNOW_HOME;
    prevHub = process.env.HUGGINGFACE_HUB_CACHE;
    prevHfHub = process.env.HF_HUB_CACHE;
    homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'minnow-cached-ttl-'));
    hubDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'minnow-cached-ttl-hub-'));
    process.env.MINNOW_HOME = homeDir;
    process.env.HF_HUB_CACHE = hubDir;
    process.env.HUGGINGFACE_HUB_CACHE = hubDir;
    resetMinnowHomeCache();

    mlxDir = path.join(homeDir, 'models', 'artifacts', 'minnow-fixture--Qwen3-8B-4bit-ttl');
    await fsp.mkdir(mlxDir, { recursive: true });
    await fsp.writeFile(
      path.join(mlxDir, 'config.json'),
      JSON.stringify({
        quantization: { group_size: 64, bits: 4 },
        max_position_embeddings: 32_768,
      }),
    );
    await fsp.writeFile(path.join(mlxDir, 'model.safetensors'), Buffer.alloc(64));
  });

  after(async () => {
    if (prevHome === undefined) delete process.env.MINNOW_HOME;
    else process.env.MINNOW_HOME = prevHome;
    if (prevHub === undefined) delete process.env.HUGGINGFACE_HUB_CACHE;
    else process.env.HUGGINGFACE_HUB_CACHE = prevHub;
    if (prevHfHub === undefined) delete process.env.HF_HUB_CACHE;
    else process.env.HF_HUB_CACHE = prevHfHub;
    resetMinnowHomeCache();
    invalidateCachedModelsCache();
    await fsp.rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    await fsp.rm(hubDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  test('two list/enrich calls within 30s share one walk; invalidate walks again', async () => {
    invalidateCachedModelsCache();
    resetCachedModelsScanCountForTests();

    const first = await listCachedModels();
    assert.equal(getCachedModelsScanCountForTests(), 1);

    const row = first.models.find((m) => m.repo_id === 'minnow-fixture/Qwen3-8B-4bit-ttl');
    assert.ok(row, 'expected the MLX artifact row');
    // Scan-time context from max_position_embeddings — must still land on the library row.
    assert.equal(row.mlx_context_length, 32_768);

    await listCachedModels();
    assert.equal(getCachedModelsScanCountForTests(), 1, 'second listCachedModels must hit the TTL cache');

    await enrichMlxLmModelsWithCachedContext({ data: [{ id: mlxDir }] });
    assert.equal(
      getCachedModelsScanCountForTests(),
      1,
      'enrichment must use the cached scan, not a fresh walk',
    );

    invalidateCachedModelsCache();
    await listCachedModels();
    assert.equal(getCachedModelsScanCountForTests(), 2, 'invalidate must force a new walk');
  });
});
