/**
 * Integration tests: provider CRUD, secrets redaction, proxy auth headers.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {
  setTestHome,
  rmTestHome,
  createProviderTestServer,
  httpRequest,
} from './test-helpers.js';

const FIXED_KEY = 'sk-fixed-key';
const FIXED_BEARER = 'test-bearer-fixed';

let homeDir;
let baseUrl;
let mockBaseUrl;
let server;
let mockServer;
/** @type {Record<string, string>} */
let lastMockHeaders = {};

before(async () => {
  homeDir = setTestHome(process.env, 'minnow-test-step03');
  server = createProviderTestServer();
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = /** @type {import('net').AddressInfo} */ (server.address()).port;
  baseUrl = `http://127.0.0.1:${port}`;

  mockServer = http.createServer((req, res) => {
    lastMockHeaders = { ...req.headers };
    if (req.method === 'GET' && req.url === '/api/v0/models') {
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          data: [{ id: 'mock-model-fixed', type: 'llm', state: 'loaded' }],
        }),
      );
      return;
    }
    if (req.method === 'POST' && req.url === '/api/v0/chat/completions') {
      res.setHeader('Content-Type', 'text/event-stream');
      res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n');
      return;
    }
    if (req.method === 'POST' && req.url === '/api/v1/models/load') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ status: 'loaded', instance_id: 'mock-model-fixed' }));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/v1/models/unload') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ status: 'unloaded' }));
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  await new Promise((resolve) => {
    mockServer.listen(0, '127.0.0.1', resolve);
  });
  const mockPort = /** @type {import('net').AddressInfo} */ (mockServer.address()).port;
  mockBaseUrl = `http://127.0.0.1:${mockPort}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => mockServer.close(resolve));
  await rmTestHome(homeDir);
});

describe('provider CRUD + proxy', () => {
  it('seeds lm-studio-local on first GET', async () => {
    const res = await httpRequest(baseUrl, 'GET', '/api/providers');
    assert.equal(res.status, 200);
    assert.ok(res.json.providers.some((p) => p.id === 'lm-studio-local'));
    assert.equal(res.json.activeProviderId, 'lm-studio-local');
  });

  it('CRUD roundtrip for second provider', async () => {
    const create = await httpRequest(baseUrl, 'POST', '/api/providers', {
      id: 'mock-remote-fixed',
      label: 'Mock Remote',
      baseUrl: mockBaseUrl,
      apiKind: 'lm-studio-v0',
    });
    assert.equal(create.status, 201);
    assert.equal(create.json.id, 'mock-remote-fixed');

    const list = await httpRequest(baseUrl, 'GET', '/api/providers');
    assert.ok(list.json.providers.some((p) => p.id === 'mock-remote-fixed'));

    const update = await httpRequest(baseUrl, 'PUT', '/api/providers/mock-remote-fixed', {
      label: 'Mock Remote Updated',
    });
    assert.equal(update.json.label, 'Mock Remote Updated');

    await httpRequest(baseUrl, 'POST', '/api/providers/mock-remote-fixed/set-active');
    const active = await httpRequest(baseUrl, 'GET', '/api/providers');
    assert.equal(active.json.activeProviderId, 'mock-remote-fixed');
  });

  it('secrets PUT does not echo values; GET redacts', async () => {
    const put = await httpRequest(
      baseUrl,
      'PUT',
      '/api/providers/mock-remote-fixed/secrets',
      { apiKey: FIXED_KEY, bearerToken: '' },
    );
    assert.equal(put.status, 200);
    assert.equal(put.json.hasApiKey, true);
    assert.equal(put.json.ok, true);

    const get = await httpRequest(baseUrl, 'GET', '/api/providers/mock-remote-fixed');
    assert.equal(get.json.hasApiKey, true);
    const body = JSON.stringify(get.json);
    assert.equal(body.includes(FIXED_KEY), false);
  });

  it('proxy models forwards Authorization to upstream', async () => {
    lastMockHeaders = {};
    const models = await httpRequest(
      baseUrl,
      'GET',
      '/api/providers/mock-remote-fixed/models',
    );
    assert.equal(models.status, 200);
    assert.ok(models.json.data.some((m) => m.id === 'mock-model-fixed'));
    assert.equal(lastMockHeaders.authorization, `Bearer ${FIXED_KEY}`);
  });

  it('proxy model load forwards POST with auth', async () => {
    lastMockHeaders = {};
    const load = await httpRequest(
      baseUrl,
      'POST',
      '/api/providers/mock-remote-fixed/models/load',
      { model: 'mock-model-fixed' },
    );
    assert.equal(load.status, 200);
    assert.equal(load.json.status, 'loaded');
    assert.equal(lastMockHeaders.authorization, `Bearer ${FIXED_KEY}`);
  });

  it('proxy model unload forwards POST with auth', async () => {
    lastMockHeaders = {};
    const unload = await httpRequest(
      baseUrl,
      'POST',
      '/api/providers/mock-remote-fixed/models/unload',
      { instance_id: 'mock-model-fixed' },
    );
    assert.equal(unload.status, 200);
    assert.equal(unload.json.status, 'unloaded');
    assert.equal(lastMockHeaders.authorization, `Bearer ${FIXED_KEY}`);
  });

  it('rejects load for openai-v1 provider', async () => {
    const create = await httpRequest(baseUrl, 'POST', '/api/providers', {
      id: 'openai-fixed-test',
      label: 'OpenAI',
      baseUrl: mockBaseUrl,
      apiKind: 'openai-v1',
      supportsModelLoadUnload: false,
    });
    assert.equal(create.status, 201);

    const load = await httpRequest(
      baseUrl,
      'POST',
      '/api/providers/openai-fixed-test/models/load',
      { model: 'gpt-4' },
    );
    assert.equal(load.status, 400);
    assert.match(load.json.error, /does not support model load\/unload/);
  });

  it('provider chat/completions route is removed (chat uses /api/generations)', async () => {
    const chat = await httpRequest(
      baseUrl,
      'POST',
      '/api/providers/mock-remote-fixed/chat/completions',
      {
        model: 'mock-model-fixed',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      },
    );
    assert.equal(chat.status, 404);
  });

  it('GET models returns an empty catalog for HTTP-less providers', async () => {
    const dir = path.join(homeDir, 'providers', 'agent-cli-fixed');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'profile.json'),
      JSON.stringify({
        id: 'agent-cli-fixed',
        label: 'Agent CLI',
        baseUrl: '',
        apiKind: 'agent-cli-v1',
        enabled: true,
        authStyle: 'bearer',
        modelsPath: '',
        chatCompletionsPath: '',
        supportsModelLoadUnload: false,
        customHeaders: {},
      }),
    );

    const models = await httpRequest(baseUrl, 'GET', '/api/providers/agent-cli-fixed/models');
    assert.equal(models.status, 200);
    assert.deepEqual(models.json.data, []);
  });

  it('GET models returns an empty catalog when the upstream host is down', async () => {
    const create = await httpRequest(baseUrl, 'POST', '/api/providers', {
      id: 'dead-local-fixed',
      label: 'Dead Local',
      baseUrl: 'http://127.0.0.1:1',
      apiKind: 'openai-v1',
    });
    assert.equal(create.status, 201);

    const models = await httpRequest(baseUrl, 'GET', '/api/providers/dead-local-fixed/models');
    assert.equal(models.status, 200);
    assert.deepEqual(models.json.data, []);
    assert.equal(models.json.unreachable, true);
  });

  it('rejects deleting last provider', async () => {
    const deleteIds = new Set(
      (await httpRequest(baseUrl, 'GET', '/api/providers')).json.providers.map((p) => p.id),
    );
    deleteIds.add('llama-cpp-local');
    deleteIds.add('lm-studio-local');
    for (const id of deleteIds) {
      await httpRequest(baseUrl, 'DELETE', `/api/providers/${id}`);
    }
    // `.gitkeep` is counted as a provider dir; remove it so only llama-cpp-local remains.
    await fs.rm(path.join(homeDir, 'providers', '.gitkeep'), { force: true });
    const del = await httpRequest(baseUrl, 'DELETE', '/api/providers/llama-cpp-local');
    assert.equal(del.status, 409);
  });
});
