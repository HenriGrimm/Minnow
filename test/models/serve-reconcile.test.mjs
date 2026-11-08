/**
 * Persisted serve rows must not claim "running" after the tool server restarts.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { getServesIndexPath } from '../../server/models/paths.js';
import {
  INTERRUPTED_SERVE_ERROR,
  listServes,
  resetServesForTests,
  setServeReachabilityProbeOverrideForTests,
  setServePidAliveOverrideForTests,
  resetServePidAliveOverrideForTests,
} from '../../server/models/serve.js';
import {
  resetServeActivityFetchForTests,
  setServeActivityFetchForTests,
  stopAllServeActivity,
  subscribeServeActivity,
} from '../../server/models/serve-activity.js';

describe('model serve reconciliation', () => {
  /** @type {string} */
  let homeDir;

  before(async () => {
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-serve-reconcile-'));
    process.env.MINNOW_HOME = homeDir;
    resetMinnowHomeCache();
    setServeReachabilityProbeOverrideForTests(async () => false);
    setServePidAliveOverrideForTests(pid => pid === process.pid);
  });

  after(async () => {
    delete process.env.MINNOW_HOME;
    resetMinnowHomeCache();
    await resetServesForTests();
    resetServePidAliveOverrideForTests();
    await fs.rm(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  test('reconciles running serves after server restart', async () => {
    const staleServe = {
      id: '22222222-2222-4222-8222-222222222222',
      runtime: 'llama-cpp',
      modelPath: '/tmp/model.gguf',
      modelLabel: 'model',
      port: 8085,
      baseUrl: 'http://127.0.0.1:8085',
      providerId: 'minnow-library',
      status: 'running',
      runId: 'gone-run-id',
      pid: 4242,
      startedAt: Date.now(),
    };

    await fs.mkdir(path.dirname(getServesIndexPath()), { recursive: true });
    await fs.writeFile(
      getServesIndexPath(),
      `${JSON.stringify({ version: 1, serves: [staleServe] }, null, 2)}\n`,
      'utf8',
    );

    await resetServesForTests();
    setServeReachabilityProbeOverrideForTests(async () => false);
    const serves = await listServes();
    assert.equal(serves.length, 1);
    assert.equal(serves[0].status, 'stopped');
    assert.equal(serves[0].runId, null);
  });

  test('reconciles starting serves as interrupted errors', async () => {
    const staleServe = {
      id: '33333333-3333-4333-8333-333333333333',
      runtime: 'llama-cpp',
      modelPath: '/tmp/model.gguf',
      modelLabel: 'model',
      port: 8086,
      baseUrl: 'http://127.0.0.1:8086',
      providerId: 'minnow-library',
      status: 'starting',
      runId: 'gone-run-id',
      startedAt: Date.now(),
    };

    await fs.writeFile(
      getServesIndexPath(),
      `${JSON.stringify({ version: 1, serves: [staleServe] }, null, 2)}\n`,
      'utf8',
    );

    await resetServesForTests();
    const serves = await listServes();
    assert.equal(serves.length, 1);
    assert.equal(serves[0].status, 'error');
    assert.equal(serves[0].error, INTERRUPTED_SERVE_ERROR);
  });

  test('starts activity pollers for a serve that is still reachable after restart', async () => {
    const liveServe = {
      id: '44444444-4444-4444-8444-444444444444',
      runtime: 'llama-cpp',
      modelPath: '/tmp/model.gguf',
      modelLabel: 'model',
      port: 8087,
      baseUrl: 'http://127.0.0.1:8087',
      providerId: 'minnow-library',
      status: 'running',
      pid: process.pid,
      startedAt: Date.now(),
    };

    await fs.writeFile(
      getServesIndexPath(),
      `${JSON.stringify({ version: 1, serves: [liveServe] }, null, 2)}\n`,
      'utf8',
    );

    await resetServesForTests();
    setServeReachabilityProbeOverrideForTests(async () => true);
    setServeActivityFetchForTests(async (url) => {
      const href = String(url);
      if (href.includes('/metrics')) {
        return { ok: true, text: async () => 'llamacpp:requests_deferred 2\n' };
      }
      return {
        ok: true,
        json: async () => [
          { id: 0, is_processing: true, id_task: 1, next_token: [{ n_remain: 8, n_decoded: 3 }] },
        ],
      };
    });

    const activity = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error('no activity sample after restore'));
      }, 2_000);
      const unsubscribe = subscribeServeActivity((sample) => {
        if (sample.serveId !== liveServe.id) return;
        clearTimeout(timer);
        unsubscribe();
        resolve(sample);
      });
      void listServes().catch((err) => {
        clearTimeout(timer);
        unsubscribe();
        reject(err);
      });
    });

    assert.equal(activity.queued, 2);
    stopAllServeActivity();
    resetServeActivityFetchForTests();
  });
});
