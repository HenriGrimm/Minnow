/**
 * Voice runtime API tests — status shape, install job, mocked worker spawn.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { request as httpRequestNode } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { handleVoiceRuntimeRequest } from '../../server/voice/routes.js';
import {
  resetVoiceFetchOverrideForTests,
  resetVoiceProvisionOverrideForTests,
  resetVoiceRuntimeForTests,
  resetVoiceSpawnOverrideForTests,
  setVoiceFetchOverrideForTests,
  setVoiceProvisionOverrideForTests,
  setVoiceSpawnOverrideForTests,
} from '../../server/voice/runtime-manager.js';
import { getVoiceMetaPath, getVoiceVenvDir } from '../../server/voice/paths.js';

function httpRequest(baseUrl, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, baseUrl);
    const payload = body ? JSON.stringify(body) : undefined;
    const r = httpRequestNode(
      url,
      {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = raw ? JSON.parse(raw) : null;
          } catch {
            json = { raw };
          }
          resolve({ status: res.statusCode, json });
        });
      },
    );
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

async function startVoiceServer(homeDir) {
  process.env.MINNOW_HOME = homeDir;
  resetMinnowHomeCache();
  resetVoiceRuntimeForTests();

  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    const handled = await handleVoiceRuntimeRequest(req, res, pathname);
    if (!handled) {
      res.statusCode = 404;
      res.end('not found');
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

/** Fake venv python.exe so install status reads as installed. */
async function seedInstalledRuntime(homeDir) {
  const venvDir = getVoiceVenvDir();
  const venvPython =
    process.platform === 'win32'
      ? path.join(venvDir, 'Scripts', 'python.exe')
      : path.join(venvDir, 'bin', 'python3');
  await fs.mkdir(path.dirname(venvPython), { recursive: true });
  await fs.writeFile(venvPython, '', 'utf8');
  await fs.writeFile(
    getVoiceMetaPath(),
    `${JSON.stringify(
      {
        kind: 'python-venv',
        installedAt: '2026-01-01T00:00:00.000Z',
        installedPackages: ['torch (CPU)', 'transformers'],
        skippedPackages: ['qwen-tts'],
        port: null,
        pid: null,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

describe('voice runtime API', () => {
  /** @type {string} */
  let homeDir;
  /** @type {import('node:http').Server} */
  let server;
  /** @type {string} */
  let baseUrl;

  before(async () => {
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-voice-runtime-'));
    ({ server, baseUrl } = await startVoiceServer(homeDir));
  });

  after(async () => {
    resetVoiceRuntimeForTests();
    resetVoiceSpawnOverrideForTests();
    resetVoiceFetchOverrideForTests();
    resetVoiceProvisionOverrideForTests();
    await new Promise((resolve) => server.close(resolve));
    delete process.env.MINNOW_HOME;
    resetMinnowHomeCache();
    await fs.rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  test('status returns not_installed shape', async () => {
    const res = await httpRequest(baseUrl, 'GET', '/api/voice/runtime/status');
    assert.equal(res.status, 200);
    assert.equal(res.json.installed, false);
    assert.equal(res.json.running, false);
    assert.equal(res.json.health, 'not_installed');
    assert.equal(typeof res.json.cudaAvailable, 'boolean');
    assert.ok(Array.isArray(res.json.installedPackages));
    assert.ok(Array.isArray(res.json.skippedPackages));
    assert.equal(res.json.port, null);
  });

  test('install starts async job with mocked provision', async () => {
    setVoiceProvisionOverrideForTests(async (onProgress) => {
      onProgress?.('Mock install step');
      await seedInstalledRuntime(homeDir);
    });

    const res = await httpRequest(baseUrl, 'POST', '/api/voice/runtime/install');
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.job.phase, 'installing');

    await new Promise((r) => setTimeout(r, 50));

    const status = await httpRequest(baseUrl, 'GET', '/api/voice/runtime/status');
    assert.equal(status.json.installed, true);
    assert.equal(status.json.health, 'stopped');
    assert.deepEqual(status.json.installedPackages, ['torch (CPU)', 'transformers']);
    assert.deepEqual(status.json.skippedPackages, ['qwen-tts']);
  });

  test('start worker uses mocked spawn + health fetch', async () => {
    let spawnCount = 0;
    setVoiceSpawnOverrideForTests(() => {
      spawnCount++;
      return {
      pid: 4242,
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      on: () => {},
      kill: () => {},
      };
    });
    setVoiceFetchOverrideForTests(async () => ({
      ok: true,
      json: async () => ({ ok: true, status: 'ready' }),
    }));

    const [start, concurrent] = await Promise.all([
      httpRequest(baseUrl, 'POST', '/api/voice/runtime/start'),
      httpRequest(baseUrl, 'POST', '/api/voice/runtime/start'),
    ]);
    assert.equal(spawnCount, 1, 'simultaneous STT and TTS starts share one worker');
    assert.equal(concurrent.json.port, start.json.port);
    assert.equal(start.status, 200);
    assert.equal(start.json.ok, true);
    assert.equal(typeof start.json.port, 'number');

    const status = await httpRequest(baseUrl, 'GET', '/api/voice/runtime/status');
    assert.equal(status.json.running, true);
    assert.equal(status.json.health, 'ready');
    assert.equal(status.json.port, start.json.port);
  });

  test('stop worker clears running state', async () => {
    const stop = await httpRequest(baseUrl, 'POST', '/api/voice/runtime/stop');
    assert.equal(stop.status, 200);
    assert.equal(stop.json.ok, true);

    const status = await httpRequest(baseUrl, 'GET', '/api/voice/runtime/status');
    assert.equal(status.json.running, false);
    assert.equal(status.json.health, 'stopped');
  });

  test('repair reruns provision', async () => {
    setVoiceProvisionOverrideForTests(async (onProgress) => {
      onProgress?.('Repair step');
    });

    const res = await httpRequest(baseUrl, 'POST', '/api/voice/runtime/repair');
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.started, true);
  });
});
