/**
 * Multi-serve residency: two live llama.cpp rows, LRU eviction at cap 2,
 * idle TTL then JIT reload of the most recently evicted alias.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { writeLlamaCppConfig } from '../../server/models/llama-args.js';
import { getServesIndexPath } from '../../server/models/paths.js';
import {
  getLastTtlEviction,
  getServe,
  listServes,
  patchServeRowForTests,
  peekServeRowForTests,
  resetServesForTests,
  setServeBackgroundRunOverrideForTests,
  setServeHealthOverrideForTests,
  setServePidAliveOverrideForTests,
  setStopActiveRunOverrideForTests,
  setSubscribeRunOverrideForTests,
  startServe,
  stopServe,
  tickServeHeartbeatForTests,
} from '../../server/models/serve.js';
import {
  admitLocalCompletion,
  resetLocalCompletionAdmissionForTests,
} from '../../server/providers/proxy.js';
import { LLAMA_CPP_LOCAL_ID } from '../../server/providers/store.js';

const MODEL_A = 'alpha-8b.gguf';
const MODEL_B = 'beta-8b.gguf';
const MODEL_C = 'gamma-8b.gguf';
const LIB_A = 'lib-alpha';
const LIB_B = 'lib-beta';
const LIB_C = 'lib-gamma';
/** Fixed past timestamp (2023-11-14) — well beyond the 20-minute idle TTL. */
const IDLE_PAST = 1_700_000_000_000;
const LRU_OLD = 1_000;
const LRU_NEW = 2_000;
/**
 * Pin RAM so cap/LRU assertions are not coupled to the runner's os.freemem().
 * macOS CI often reports ~1 GB free; the planner's heuristic estimateGb for a
 * 4-byte GGUF stub is then over-budget and evicts the previous resident.
 */
const TEST_HARDWARE = {
  totalRamGb: 64,
  availableRamGb: 64,
  gpuVramGb: 0,
  backend: 'cpu',
};

/** startServe with RAM large enough that only models_max / LRU decide residency. */
function startResidentServe(opts = {}) {
  return startServe({
    runtime: 'llama-cpp',
    async: true,
    ...opts,
    hardware: opts.hardware ?? TEST_HARDWARE,
  });
}

async function waitForStatus(serveId, status, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const serve = await getServe(serveId);
    if (serve && serve.status === status) return serve;
    await new Promise((r) => setTimeout(r, 25));
  }
  return getServe(serveId);
}

describe('llama.cpp multi-serve residency', () => {
  /** @type {string} */
  let homeDir;
  /** @type {string} */
  let modelPathA;
  /** @type {string} */
  let modelPathB;
  /** @type {string} */
  let modelPathC;
  let runSeq = 0;

  before(async () => {
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-serve-residency-'));
    process.env.MINNOW_HOME = homeDir;
    resetMinnowHomeCache();

    modelPathA = path.join(homeDir, MODEL_A);
    modelPathB = path.join(homeDir, MODEL_B);
    modelPathC = path.join(homeDir, MODEL_C);
    await fs.writeFile(modelPathA, 'GGUF');
    await fs.writeFile(modelPathB, 'GGUF');
    await fs.writeFile(modelPathC, 'GGUF');

    const managedRoot = path.join(homeDir, 'models-runtime', 'llama-cpp');
    await fs.mkdir(managedRoot, { recursive: true });
    const binName = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
    await fs.writeFile(path.join(managedRoot, binName), '');
    await fs.writeFile(
      path.join(managedRoot, 'meta.json'),
      `${JSON.stringify({ variant: 'cpu', version: 'test', path: path.join(managedRoot, binName) })}\n`,
    );
  });

  beforeEach(async () => {
    await resetServesForTests();
    resetLocalCompletionAdmissionForTests();
    runSeq = 0;
    await fs.mkdir(path.dirname(getServesIndexPath()), { recursive: true });
    await fs.writeFile(getServesIndexPath(), `${JSON.stringify({ version: 1, serves: [] }, null, 2)}\n`);
    await writeLlamaCppConfig({ models_max: 3 });
    setServeHealthOverrideForTests(async () => true);
    setServeBackgroundRunOverrideForTests(async () => {
      runSeq += 1;
      return { runId: `residency-run-${runSeq}`, pid: 7000 + runSeq };
    });
    setSubscribeRunOverrideForTests(() => () => {});
    setServePidAliveOverrideForTests(() => true);
    setStopActiveRunOverrideForTests(async (runId) => ({ ok: true, runId }));
  });

  after(async () => {
    delete process.env.MINNOW_HOME;
    resetMinnowHomeCache();
    await resetServesForTests();
    resetLocalCompletionAdmissionForTests();
    await fs.rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  test('two models stay resident under models_max: 3 and route by libraryId', async () => {
    const a = await startResidentServe({
      modelPath: modelPathA,
      libraryId: LIB_A,
      port: 18085,
    });
    await waitForStatus(a.id, 'running');
    const b = await startResidentServe({
      modelPath: modelPathB,
      libraryId: LIB_B,
      port: 18086,
    });
    await waitForStatus(b.id, 'running');

    const live = (await listServes()).filter((row) => row.status === 'running');
    assert.equal(live.length, 2);
    assert.equal(a.baseUrl, 'http://127.0.0.1:18085');
    assert.equal(b.baseUrl, 'http://127.0.0.1:18086');

    const routedB = await admitLocalCompletion({
      providerId: LLAMA_CPP_LOCAL_ID,
      modelId: LIB_B,
      priority: 'interactive',
    });
    assert.equal(routedB.baseUrl, b.baseUrl);
    routedB.release();

    const routedA = await admitLocalCompletion({
      providerId: LLAMA_CPP_LOCAL_ID,
      modelId: LIB_A,
      priority: 'interactive',
    });
    assert.equal(routedA.baseUrl, a.baseUrl);
    routedA.release();
  });

  test('third model at cap 2 evicts the older lastUsedAt', async () => {
    await writeLlamaCppConfig({ models_max: 2 });
    const a = await startResidentServe({
      modelPath: modelPathA,
      libraryId: LIB_A,
    });
    const b = await startResidentServe({
      modelPath: modelPathB,
      libraryId: LIB_B,
    });
    await waitForStatus(a.id, 'running');
    await waitForStatus(b.id, 'running');
    patchServeRowForTests(a.id, { lastUsedAt: LRU_OLD });
    patchServeRowForTests(b.id, { lastUsedAt: LRU_NEW });

    const c = await startResidentServe({
      modelPath: modelPathC,
      libraryId: LIB_C,
    });
    await waitForStatus(c.id, 'running');

    assert.equal((await getServe(a.id)).status, 'stopped');
    assert.equal((await getServe(b.id)).status, 'running');
    assert.equal((await getServe(c.id)).status, 'running');
  });

  test('idle past TTL unloads, then a completion JIT-reloads only that alias', async () => {
    const a = await startResidentServe({
      modelPath: modelPathA,
      libraryId: LIB_A,
    });
    await waitForStatus(a.id, 'running');
    const runsBeforeTtl = runSeq;
    patchServeRowForTests(a.id, { lastUsedAt: IDLE_PAST });

    await tickServeHeartbeatForTests();
    assert.equal((await getServe(a.id)).status, 'stopped');
    assert.equal(getLastTtlEviction()?.libraryId, LIB_A);

    const jit = await admitLocalCompletion({
      providerId: LLAMA_CPP_LOCAL_ID,
      modelId: LIB_A,
      priority: 'interactive',
    });
    jit.release();
    assert.ok(runSeq > runsBeforeTtl, 'JIT startServe must spawn llama-server again');
    assert.ok(jit.baseUrl.startsWith('http://127.0.0.1:'));

    const live = (await listServes()).filter((row) => row.status === 'running');
    assert.equal(live.length, 1);
    assert.equal(peekServeRowForTests(live[0].id)?.libraryId, LIB_A);
  });

  test('user-stopped models are not JIT-reloaded', async () => {
    const a = await startResidentServe({
      modelPath: modelPathA,
      libraryId: LIB_A,
    });
    await waitForStatus(a.id, 'running');
    await stopServe(a.id);
    assert.equal(getLastTtlEviction(), null);

    await assert.rejects(
      () =>
        admitLocalCompletion({
          providerId: LLAMA_CPP_LOCAL_ID,
          modelId: LIB_A,
          priority: 'interactive',
        }),
      /No loaded llama.cpp serve matches model lib-alpha/,
    );
  });
});
