/**
 * Voice model download API tests — job creation, cancel, installed manifest.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { request as httpRequestNode } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import {
  resetVoiceDownloadsForTests,
  startVoiceDownload,
  listVoiceDownloads,
  listInstalledVoiceModels,
  cancelVoiceDownload,
} from '../../server/voice/download.js';
import { getVoiceInstalledPath } from '../../server/voice/paths.js';
import { handleVoiceRequest } from '../../server/voice/routes.js';

const ORIGINAL_FETCH = globalThis.fetch;

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

async function startVoiceApiServer(homeDir) {
  process.env.MINNOW_HOME = homeDir;
  resetMinnowHomeCache();
  await resetVoiceDownloadsForTests();

  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    const handled = await handleVoiceRequest(req, res, pathname);
    if (!handled) {
      res.statusCode = 404;
      res.end('not found');
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

describe('voice download API', () => {
  /** @type {import('node:http').Server | null} */
  let server = null;
  let baseUrl = '';
  let homeDir = '';

  before(async () => {
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-voice-dl-'));
    const started = await startVoiceApiServer(homeDir);
    server = started.server;
    baseUrl = started.baseUrl;

    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes('huggingface.co/api/models/')) {
        return new Response(
          JSON.stringify([
            { path: 'config.json', size: 12, type: 'file' },
            { path: 'model.safetensors', size: 48, type: 'file' },
          ]),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('huggingface.co/') && url.includes('/resolve/main/')) {
        const filename = url.split('/resolve/main/')[1] ?? 'file';
        const body = Buffer.from(`fake-${filename}`);
        return new Response(body, {
          status: 200,
          headers: { 'Content-Length': String(body.length) },
        });
      }
      return ORIGINAL_FETCH(input, init);
    };
  });

  after(async () => {
    await resetVoiceDownloadsForTests();
    globalThis.fetch = ORIGINAL_FETCH;
    await new Promise((resolve) => server?.close(resolve));
    await fs.rm(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    delete process.env.MINNOW_HOME;
    resetMinnowHomeCache();
  });

  test('POST /api/voice/download rejects standalone tokenizer download', async () => {
    const res = await httpRequest(baseUrl, 'POST', '/api/voice/download', {
      modelId: 'Qwen/Qwen3-TTS-Tokenizer-12Hz',
      kind: 'tts',
    });
    assert.equal(res.status, 400);
    assert.match(
      res.json.error,
      /tokenizer is installed automatically|already installed/i,
    );
  });

  test('POST /api/voice/download creates TTS job and completes manifest', async (t) => {
    const rename = fs.rename;
    let manifestWrites = 0;
    t.mock.method(fs, 'rename', async (source, destination) => {
      if (destination === getVoiceInstalledPath() && ++manifestWrites === 2) {
        throw Object.assign(new Error('Manifest is temporarily locked'), { code: 'EPERM' });
      }
      await rename(source, destination);
    });
    const start = await httpRequest(baseUrl, 'POST', '/api/voice/download', {
      modelId: 'Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice',
      kind: 'tts',
    });
    assert.equal(start.status, 200);
    assert.equal(start.json.job.kind, 'tts');
    assert.equal(start.json.job.modelId, 'Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice');

    await resetVoiceDownloadsForTests();
    const job = (await listVoiceDownloads()).find((row) => row.id === start.json.job.id);
    assert.equal(job?.status, 'completed', job?.error);
    assert.equal(manifestWrites, 3, 'the second manifest replacement retries after a sharing error');

    const manifestRaw = await fs.readFile(getVoiceInstalledPath(), 'utf8');
    const manifest = JSON.parse(manifestRaw);
    assert.ok(manifest.tts?.some((row) => row.modelId === start.json.job.modelId));
    assert.ok(
      manifest.tts?.some((row) => row.modelId === 'Qwen/Qwen3-TTS-Tokenizer-12Hz'),
      'expected tokenizer auto-install when TTS model requires it',
    );
  });

  test('POST /api/voice/download creates STT job and completes manifest', async () => {
    const start = await httpRequest(baseUrl, 'POST', '/api/voice/download', {
      modelId: 'openai/whisper-tiny',
      kind: 'stt',
    });
    assert.equal(start.status, 200);
    assert.equal(start.json.job.kind, 'stt');
    assert.equal(start.json.job.modelId, 'openai/whisper-tiny');
    assert.ok(['queued', 'running', 'completed'].includes(start.json.job.status));

    await resetVoiceDownloadsForTests();
    const job = (await listVoiceDownloads()).find((row) => row.id === start.json.job.id);
    assert.equal(job?.status, 'completed', job?.error);
    const manifest = JSON.parse(await fs.readFile(getVoiceInstalledPath(), 'utf8'));
    assert.ok(manifest.stt?.some((row) => row.modelId === start.json.job.modelId));
  });

  test('GET /api/voice/models/installed returns manifest', async () => {
    let res = await httpRequest(baseUrl, 'GET', '/api/voice/models/installed');
    if (!res.json.stt?.some((row) => row.modelId === 'openai/whisper-tiny')) {
      for (let i = 0; i < 40; i += 1) {
        await new Promise((r) => setTimeout(r, 50));
        res = await httpRequest(baseUrl, 'GET', '/api/voice/models/installed');
        if (res.json.stt?.some((row) => row.modelId === 'openai/whisper-tiny')) break;
      }
    }
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.json.stt));
    assert.ok(res.json.stt.some((row) => row.modelId === 'openai/whisper-tiny'));
  });

  test('in-progress files stay hidden and a cancelled transfer can be retried', async () => {
    const modelId = 'openai/whisper-medium';
    const normalFetch = globalThis.fetch;
    let atWeights;
    const waiting = new Promise(resolve => { atWeights = resolve; });
    globalThis.fetch = async (url, init) => {
      if (String(url).includes('/resolve/main/model.safetensors')) {
        atWeights();
        return new Promise((resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('Download cancelled')), { once: true });
        });
      }
      return normalFetch(url, init);
    };
    try {
      const job = await startVoiceDownload({ modelId, kind: 'stt' });
      await waiting;
      assert.equal((await startVoiceDownload({ modelId, kind: 'stt' })).id, job.id);
      assert.ok(!(await listInstalledVoiceModels()).stt.some(row => row.modelId === modelId));
      await assert.rejects(fs.stat(job.destDir), { code: 'ENOENT' });
      await cancelVoiceDownload(job.id);
      await resetVoiceDownloadsForTests();
      assert.equal((await listVoiceDownloads()).find(row => row.id === job.id).status, 'cancelled');
    } finally {
      globalThis.fetch = normalFetch;
    }
    await startVoiceDownload({ modelId, kind: 'stt' });
    await resetVoiceDownloadsForTests();
    assert.ok((await listInstalledVoiceModels()).stt.some(row => row.modelId === modelId));
  });

  test('cancel endpoint accepts job id', async () => {
    const job = await startVoiceDownload({
      modelId: 'openai/whisper-base',
      kind: 'stt',
    });
    const res = await httpRequest(
      baseUrl,
      'POST',
      `/api/voice/download/${job.id}/cancel`,
    );
    assert.equal(res.status, 200);
    assert.ok(res.json.job);
    await new Promise((r) => setTimeout(r, 200));
  });
});
