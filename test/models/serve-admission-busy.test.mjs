import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { writeLlamaCppConfig } from '../../server/models/llama-args.js';
import { getServesIndexPath } from '../../server/models/paths.js';
import { admitServe, getServe, resetServesForTests, setServePidAliveOverrideForTests,
  setServeReachabilityProbeOverrideForTests, setStopActiveRunOverrideForTests } from '../../server/models/serve.js';
import { createGenerationState, markCancelled, deleteGenerationsForProviderShutdown } from '../../server/generations/store.js';

test('admission does not stop an actively generating eviction victim after its wait deadline', async () => {
  const previousHome = process.env.MINNOW_HOME;
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-admission-busy-'));
  process.env.MINNOW_HOME = home;
  resetMinnowHomeCache();
  const id = '11111111-1111-4111-8111-111111111111';
  let stops = 0;
  let generation;
  try {
    await resetServesForTests();
    await fs.mkdir(path.dirname(getServesIndexPath()), { recursive: true });
    await fs.writeFile(getServesIndexPath(), JSON.stringify({ version: 1, serves: [{
      id, runtime: 'llama-cpp', status: 'running', modelPath: path.join(home, 'busy.gguf'),
      libraryId: 'busy-model', modelLabel: 'Busy', pid: 12345, runId: 'busy-run',
      baseUrl: 'http://127.0.0.1:18085', port: 18085, startedAt: Date.now(), lastUsedAt: Date.now(),
      launchPlan: { variant: 'cpu', estimateGb: 1 },
    }] }));
    await writeLlamaCppConfig({ models_max: 1 });
    setServePidAliveOverrideForTests(() => true);
    setServeReachabilityProbeOverrideForTests(async () => true);
    setStopActiveRunOverrideForTests(async () => { stops += 1; return { ok: true }; });
    generation = createGenerationState({ providerId: 'llama-cpp-local', body: { model: 'busy-model' } });
    await admitServe({ variant: 'cpu', estimateGb: 1,
      hardware: { totalRamGb: 64, availableRamGb: 64, gpuVramGb: 0 } }, { waitTimeoutMs: 0 });
    assert.equal(stops, 0);
    assert.equal((await getServe(id)).status, 'running');
    assert.equal(generation.status, 'pending');
  } finally {
    if (generation) markCancelled(generation);
    deleteGenerationsForProviderShutdown();
    await resetServesForTests();
    if (previousHome === undefined) delete process.env.MINNOW_HOME;
    else process.env.MINNOW_HOME = previousHome;
    resetMinnowHomeCache();
    await fs.rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});
