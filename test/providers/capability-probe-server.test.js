/**
 * Server-side capability probe persistence and route.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  setTestHome,
  rmTestHome,
  createProviderTestServer,
  httpRequest,
} from './test-helpers.js';

let homeDir;
let baseUrl;
let mockBaseUrl;
let server;
let mockServer;
/** @type {Array<{ body: object }>} */
let probeBodies = [];

before(async () => {
  homeDir = setTestHome(process.env, 'minnow-test-cap-probe');
  server = createProviderTestServer();
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = /** @type {import('net').AddressInfo} */ (server.address()).port;
  baseUrl = `http://127.0.0.1:${port}`;

  mockServer = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/v0/models') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'mock-model', type: 'llm', state: 'loaded' }] }));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/v0/chat/completions') {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        const body = JSON.parse(raw);
        probeBodies.push({ body });
        const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
        const hasFormat = body.response_format != null;
        if (hasFormat && (!hasTools || probeBodies.filter((p) => p.body.tools?.length).length <= 1)) {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }));
          return;
        }
        if (hasFormat && hasTools && body.stream) {
          res.statusCode = 400;
          res.end('streaming structured output not supported');
          return;
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }));
      });
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

  await httpRequest(baseUrl, 'POST', '/api/providers', {
    id: 'probe-test',
    label: 'Probe Test',
    baseUrl: mockBaseUrl,
    apiKind: 'lm-studio-v0',
  });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => mockServer.close(resolve));
  await rmTestHome(homeDir);
});

describe('probe-capabilities route', () => {
  it('POST probe writes capabilities.json', async () => {
    probeBodies = [];
    const res = await httpRequest(
      baseUrl,
      'POST',
      '/api/providers/probe-test/probe-capabilities',
      {},
    );
    assert.equal(res.status, 200);
    assert.equal(res.json.structuredOutput, true);
    assert.equal(res.json.structuredOutputWithTools, true);
    assert.equal(typeof res.json.probedAt, 'string');

    const file = path.join(homeDir, 'providers', 'probe-test', 'capabilities.json');
    const raw = await fs.readFile(file, 'utf8');
    const saved = JSON.parse(raw);
    assert.equal(saved.providerId, 'probe-test');

    const getRes = await httpRequest(
      baseUrl,
      'GET',
      '/api/providers/probe-test/capabilities',
    );
    assert.equal(getRes.status, 200);
    assert.equal(getRes.json.structuredOutputWithTools, true);

    assert.ok(probeBodies.length >= 1);
    for (const { body } of probeBodies) {
      assert.equal(body.model, 'mock-model');
    }
  });

  it('matrix probe uses loaded models only and skips chat for unloaded rows', async () => {
    probeBodies = [];
    const mixedMock = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/api/v0/models') {
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            data: [
              {
                id: 'loaded-llm',
                type: 'llm',
                state: 'loaded',
                capabilities: { vision: true },
              },
              { id: 'idle-llm', type: 'llm', state: 'not-loaded' },
            ],
          }),
        );
        return;
      }
      if (req.method === 'POST' && req.url === '/api/v0/chat/completions') {
        let raw = '';
        req.on('data', (chunk) => {
          raw += chunk;
        });
        req.on('end', () => {
          const body = JSON.parse(raw);
          probeBodies.push({ body });
          const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({
              choices: [
                {
                  message: hasTools
                    ? {
                        tool_calls: [
                          {
                            id: 'c1',
                            type: 'function',
                            function: { name: 'probe_noop', arguments: '{}' },
                          },
                        ],
                      }
                    : { content: 'pong' },
                  finish_reason: hasTools ? 'tool_calls' : 'stop',
                },
              ],
            }),
          );
        });
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    });
    await new Promise((resolve) => mixedMock.listen(0, '127.0.0.1', resolve));
    const port = /** @type {import('net').AddressInfo} */ (mixedMock.address()).port;
    const mixedBaseUrl = `http://127.0.0.1:${port}`;

    try {
      await httpRequest(baseUrl, 'POST', '/api/providers', {
        id: 'probe-mixed',
        label: 'Mixed load',
        baseUrl: mixedBaseUrl,
        apiKind: 'lm-studio-v0',
      });

      const res = await httpRequest(
        baseUrl,
        'POST',
        '/api/providers/probe-mixed/capabilities/probe',
        {},
      );
      assert.equal(res.status, 200);
      assert.equal(res.json.models['loaded-llm'].tools, true);
      assert.equal(res.json.models['loaded-llm'].vision, true);
      assert.equal(res.json.models['idle-llm'].vision, false);
      assert.equal(res.json.models['idle-llm'].tools, null);

      const probedModels = probeBodies.map((p) => p.body.model);
      assert.deepEqual(probedModels, ['loaded-llm', 'loaded-llm']);
      assert.ok(!probedModels.includes('idle-llm'));
    } finally {
      await new Promise((resolve) => mixedMock.close(resolve));
    }
  });

  it('matrix probe returns 400 when no model is loaded', async () => {
    const unloadedMock = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/api/v0/models') {
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            data: [{ id: 'idle-model', type: 'llm', state: 'not-loaded' }],
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    });
    await new Promise((resolve) => unloadedMock.listen(0, '127.0.0.1', resolve));
    const port = /** @type {import('net').AddressInfo} */ (unloadedMock.address()).port;
    const unloadedBaseUrl = `http://127.0.0.1:${port}`;

    try {
      await httpRequest(baseUrl, 'POST', '/api/providers', {
        id: 'probe-matrix-unloaded',
        label: 'Matrix unloaded',
        baseUrl: unloadedBaseUrl,
        apiKind: 'lm-studio-v0',
      });

      const res = await httpRequest(
        baseUrl,
        'POST',
        '/api/providers/probe-matrix-unloaded/capabilities/probe',
        {},
      );
      assert.equal(res.status, 400);
      assert.match(res.json.error, /No loaded model/i);
    } finally {
      await new Promise((resolve) => unloadedMock.close(resolve));
    }
  });

  it('returns 400 when no model is loaded', async () => {
    const unloadedMock = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/api/v0/models') {
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            data: [{ id: 'idle-model', type: 'llm', state: 'not-loaded' }],
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    });
    await new Promise((resolve) => unloadedMock.listen(0, '127.0.0.1', resolve));
    const port = /** @type {import('net').AddressInfo} */ (unloadedMock.address()).port;
    const unloadedBaseUrl = `http://127.0.0.1:${port}`;

    try {
      await httpRequest(baseUrl, 'POST', '/api/providers', {
        id: 'probe-unloaded',
        label: 'Unloaded',
        baseUrl: unloadedBaseUrl,
        apiKind: 'lm-studio-v0',
      });

      const res = await httpRequest(
        baseUrl,
        'POST',
        '/api/providers/probe-unloaded/probe-capabilities',
        {},
      );
      assert.equal(res.status, 400);
      assert.match(res.json.error, /No loaded model/i);
    } finally {
      await new Promise((resolve) => unloadedMock.close(resolve));
    }
  });

  it('structured probe with Claude model does not poison provider when GPT model exists', async () => {
    probeBodies = [];
    const mixedGatewayMock = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            data: [
              { id: 'claude-sonnet-4-5', owned_by: 'anthropic' },
              { id: 'gpt-4o-mini', owned_by: 'openai' },
            ],
          }),
        );
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        let raw = '';
        req.on('data', (chunk) => {
          raw += chunk;
        });
        req.on('end', () => {
          const body = JSON.parse(raw);
          probeBodies.push({ body });
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }));
        });
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    });
    await new Promise((resolve) => mixedGatewayMock.listen(0, '127.0.0.1', resolve));
    const port = /** @type {import('net').AddressInfo} */ (mixedGatewayMock.address()).port;
    const gatewayBaseUrl = `http://127.0.0.1:${port}`;

    try {
      await httpRequest(baseUrl, 'POST', '/api/providers', {
        id: 'probe-mixed-gateway',
        label: 'Mixed gateway',
        baseUrl: gatewayBaseUrl,
        apiKind: 'openai-v1',
        autoApi: true,
        modelsPath: '/v1/models',
        chatCompletionsPath: '/v1/chat/completions',
        messagesPath: '/v1/messages',
      });

      const res = await httpRequest(
        baseUrl,
        'POST',
        '/api/providers/probe-mixed-gateway/probe-capabilities',
        { modelId: 'claude-sonnet-4-5' },
      );
      assert.equal(res.status, 200);
      assert.equal(res.json.structuredOutput, true);
      assert.equal(res.json.models['claude-sonnet-4-5'].structuredOutput, false);
      assert.equal(res.json.models['gpt-4o-mini'].structuredOutput, true);
      assert.ok(probeBodies.length >= 1);
      assert.equal(probeBodies[0].body.model, 'gpt-4o-mini');
    } finally {
      await new Promise((resolve) => mixedGatewayMock.close(resolve));
    }
  });

  it('structured probe prefers explicit openai model over alphabetical fallback', async () => {
    probeBodies = [];
    const gatewayMock = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            data: [
              { id: 'deepseek/deepseek-v4-flash', owned_by: 'deepseek' },
              { id: 'openai/gpt-4o-mini', owned_by: 'openai' },
            ],
          }),
        );
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        let raw = '';
        req.on('data', (chunk) => {
          raw += chunk;
        });
        req.on('end', () => {
          const body = JSON.parse(raw);
          probeBodies.push({ body });
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }));
        });
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    });
    await new Promise((resolve) => gatewayMock.listen(0, '127.0.0.1', resolve));
    const port = /** @type {import('net').AddressInfo} */ (gatewayMock.address()).port;
    const gatewayBaseUrl = `http://127.0.0.1:${port}`;

    try {
      await httpRequest(baseUrl, 'POST', '/api/providers', {
        id: 'probe-explicit-model',
        label: 'Explicit model',
        baseUrl: gatewayBaseUrl,
        apiKind: 'openai-v1',
        modelsPath: '/v1/models',
        chatCompletionsPath: '/v1/chat/completions',
      });

      const res = await httpRequest(
        baseUrl,
        'POST',
        '/api/providers/probe-explicit-model/probe-capabilities',
        { modelId: 'openai/gpt-4o-mini', selectedModelId: 'openai/gpt-4o-mini' },
      );
      assert.equal(res.status, 200);
      assert.equal(res.json.structuredOutput, true);
      assert.equal(res.json.models['openai/gpt-4o-mini'].structuredOutput, true);
      assert.ok(probeBodies.length >= 1);
      assert.equal(probeBodies[0].body.model, 'openai/gpt-4o-mini');
    } finally {
      await new Promise((resolve) => gatewayMock.close(resolve));
    }
  });
});

describe('openai-v1 capabilities/probe route', () => {
  it('keeps absent tool calls and failed probes inconclusive', async () => {
    let outcome = 'no-calls';
    const bodies = [];
    const probeMock = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.end(JSON.stringify({ data: [{ id: 'model', capabilities: { vision: true } }] }));
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        let raw = '';
        req.on('data', chunk => { raw += chunk; });
        req.on('end', () => {
          const body = JSON.parse(raw);
          bodies.push(body);
          res.statusCode = outcome === 'failed' ? 503 : 200;
          res.end(JSON.stringify(outcome === 'failed' ? { error: 'Temporarily unavailable' }
            : { choices: [{ message: { content: 'pong' }, finish_reason: 'length' }] }));
        });
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
    await new Promise(resolve => probeMock.listen(0, '127.0.0.1', resolve));
    const port = probeMock.address().port;
    try {
      await httpRequest(baseUrl, 'POST', '/api/providers', {
        id: 'probe-inconclusive', label: 'Inconclusive', baseUrl: `http://127.0.0.1:${port}`, apiKind: 'openai-v1',
      });
      for (outcome of ['no-calls', 'failed']) {
        const result = await httpRequest(baseUrl, 'POST', '/api/providers/probe-inconclusive/capabilities/probe', { modelIds: ['model'] });
        assert.equal(result.status, 200);
        const cap = result.json.models.model;
        assert.equal(cap.tools, null, outcome);
        assert.equal(cap.streaming, outcome === 'failed' ? null : true);
        assert.equal(cap.probeErrors.tools, outcome === 'failed' ? 'tool probe failed' : 'tool probe returned no tool calls');
        const saved = await httpRequest(baseUrl, 'GET', '/api/providers/probe-inconclusive/capabilities');
        assert.equal(saved.json.models.model.tools, null);
      }
      const toolBodies = bodies.filter(body => body.tools?.length);
      assert.equal(toolBodies.length, 2);
      for (const body of toolBodies) {
        assert.deepEqual(body.tool_choice, { type: 'function', function: { name: 'probe_noop' } });
        assert.ok(body.max_tokens >= 256);
        assert.match(body.messages[0].content, /Call probe_noop/);
      }
    } finally {
      await new Promise(resolve => probeMock.close(resolve));
    }
  });

  it('writes capabilities.json with tool probe results', async () => {
    const openaiMock = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            data: [
              { id: 'model-z', object: 'model' },
              { id: 'model-a', object: 'model' },
            ],
          }),
        );
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        let body = '';
        req.on('data', (c) => {
          body += c;
        });
        req.on('end', () => {
          const parsed = JSON.parse(body);
          const hasTools = Array.isArray(parsed.tools) && parsed.tools.length > 0;
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({
              choices: [
                {
                  message: hasTools
                    ? {
                        tool_calls: [
                          {
                            id: 'c1',
                            type: 'function',
                            function: { name: 'probe_noop', arguments: '{}' },
                          },
                        ],
                      }
                    : { content: 'pong' },
                  finish_reason: hasTools ? 'tool_calls' : 'stop',
                },
              ],
            }),
          );
        });
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    });
    await new Promise((resolve) => openaiMock.listen(0, '127.0.0.1', resolve));
    const port = /** @type {import('net').AddressInfo} */ (openaiMock.address()).port;
    const openaiBaseUrl = `http://127.0.0.1:${port}`;

    try {
      await httpRequest(baseUrl, 'POST', '/api/providers', {
        id: 'probe-openai',
        label: 'Probe OpenAI',
        baseUrl: openaiBaseUrl,
        apiKind: 'openai-v1',
      });

      const res = await httpRequest(
        baseUrl,
        'POST',
        '/api/providers/probe-openai/capabilities/probe',
        { modelIds: ['model-a'] },
      );
      assert.equal(res.status, 200);
      assert.equal(res.json.schemaVersion, 1);
      assert.equal(res.json.models['model-a'].tools, true);
      assert.equal(res.json.models['model-a'].streaming, true);
      // Targeted first-load probes must not ingest unprobed siblings.
      assert.equal(res.json.models['model-z'], undefined);

      const get = await httpRequest(
        baseUrl,
        'GET',
        '/api/providers/probe-openai/capabilities',
      );
      assert.equal(get.status, 200);
      assert.equal(get.json.models['model-a'].tools, true);
    } finally {
      await new Promise((resolve) => openaiMock.close(resolve));
    }
  });

  it('probes vision with an image part and records both outcomes', async () => {
    /** @type {Array<{ model: string, hasImage: boolean }>} */
    const seen = [];
    const visionMock = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            data: [{ id: 'sees-images' }, { id: 'text-only' }, { id: 'passthrough' }],
          }),
        );
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        let body = '';
        req.on('data', (c) => {
          body += c;
        });
        req.on('end', () => {
          const parsed = JSON.parse(body);
          const serialized = JSON.stringify(parsed.messages);
          const hasImage = serialized.includes('image_url');
          // Real PNG bytes always start `iVBOR` once base64-encoded.
          const decodesImage = serialized.includes('base64,iVBOR');
          seen.push({ model: parsed.model, hasImage });
          res.setHeader('Content-Type', 'application/json');
          if (hasImage && parsed.model === 'text-only') {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: 'model does not support images' }));
            return;
          }
          // A model that really decodes images refuses a corrupt payload; the
          // `passthrough` gateway answers 200 without ever looking at it.
          if (hasImage && parsed.model === 'sees-images' && !decodesImage) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: 'invalid image data' }));
            return;
          }
          res.end(
            JSON.stringify({
              choices: [{ message: { content: 'pong' }, finish_reason: 'stop' }],
            }),
          );
        });
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    });
    await new Promise((resolve) => visionMock.listen(0, '0.0.0.0', resolve));
    const port = /** @type {import('net').AddressInfo} */ (visionMock.address()).port;

    try {
      await httpRequest(baseUrl, 'POST', '/api/providers', {
        id: 'probe-vision',
        label: 'Probe vision',
        // 0.0.0.0 is not classified as loopback (unlike 127.0.0.1), so the
        // corrupt-image control still runs. Bind all-interfaces so macOS lo0
        // (which has no 127.0.0.2) can still accept the probe POSTs.
        baseUrl: `http://0.0.0.0:${port}`,
        apiKind: 'openai-v1',
      });

      const res = await httpRequest(
        baseUrl,
        'POST',
        '/api/providers/probe-vision/capabilities/probe',
        { modelIds: ['sees-images', 'text-only', 'passthrough'] },
      );
      assert.equal(res.status, 200);
      assert.equal(res.json.models['sees-images'].vision, true);
      assert.equal(res.json.models['sees-images'].sources.vision, 'probe');
      assert.equal(res.json.models['text-only'].vision, false);
      assert.equal(res.json.models['text-only'].sources.vision, 'probe');
      assert.match(res.json.models['text-only'].probeErrors.vision, /support/i);
      // Accepting a corrupt image proves the endpoint is not decoding images, so
      // the probe must not claim vision — it records why and leaves it unknown.
      assert.notEqual(res.json.models['passthrough'].vision, true);
      assert.notEqual(res.json.models['passthrough'].sources?.vision, 'probe');
      assert.match(res.json.models['passthrough'].probeErrors.vision, /corrupt image/i);
      // Real image for all three, plus the control for the two that accepted it.
      assert.equal(seen.filter((r) => r.hasImage).length, 5);
    } finally {
      await new Promise((resolve) => visionMock.close(resolve));
    }
  });

  it('skips the vision probe when plain chat already fails', async () => {
    let imageRequests = 0;
    const downMock = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: [{ id: 'unreachable' }] }));
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        let body = '';
        req.on('data', (c) => {
          body += c;
        });
        req.on('end', () => {
          if (JSON.stringify(JSON.parse(body).messages).includes('image_url')) {
            imageRequests += 1;
          }
          res.statusCode = 401;
          res.end(JSON.stringify({ error: 'unauthorized' }));
        });
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    });
    await new Promise((resolve) => downMock.listen(0, '127.0.0.1', resolve));
    const port = /** @type {import('net').AddressInfo} */ (downMock.address()).port;

    try {
      await httpRequest(baseUrl, 'POST', '/api/providers', {
        id: 'probe-vision-down',
        label: 'Probe vision down',
        baseUrl: `http://127.0.0.1:${port}`,
        apiKind: 'openai-v1',
      });

      const res = await httpRequest(
        baseUrl,
        'POST',
        '/api/providers/probe-vision-down/capabilities/probe',
        { modelIds: ['unreachable'] },
      );
      assert.equal(res.status, 200);
      assert.equal(imageRequests, 0);
      assert.equal(res.json.models['unreachable'].sources.vision, 'catalog');
    } finally {
      await new Promise((resolve) => downMock.close(resolve));
    }
  });

  it('skips the corrupt-image control on loopback openai-v1 (MIN-839)', async () => {
    /** @type {Array<{ model: string, hasImage: boolean, decodesImage: boolean }>} */
    const seen = [];
    const visionMock = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: [{ id: 'sees-images' }] }));
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        let body = '';
        req.on('data', (c) => {
          body += c;
        });
        req.on('end', () => {
          const parsed = JSON.parse(body);
          const serialized = JSON.stringify(parsed.messages);
          const hasImage = serialized.includes('image_url');
          const decodesImage = serialized.includes('base64,iVBOR');
          seen.push({ model: parsed.model, hasImage, decodesImage });
          res.setHeader('Content-Type', 'application/json');
          if (hasImage && !decodesImage) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: 'invalid image data' }));
            return;
          }
          res.end(
            JSON.stringify({
              choices: [{ message: { content: 'pong' }, finish_reason: 'stop' }],
            }),
          );
        });
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    });
    await new Promise((resolve) => visionMock.listen(0, '127.0.0.1', resolve));
    const port = /** @type {import('net').AddressInfo} */ (visionMock.address()).port;

    try {
      await httpRequest(baseUrl, 'POST', '/api/providers', {
        id: 'probe-vision-loopback',
        label: 'Loopback llama.cpp',
        baseUrl: `http://127.0.0.1:${port}`,
        apiKind: 'openai-v1',
      });

      const res = await httpRequest(
        baseUrl,
        'POST',
        '/api/providers/probe-vision-loopback/capabilities/probe',
        { modelIds: ['sees-images'] },
      );
      assert.equal(res.status, 200);
      assert.equal(res.json.models['sees-images'].vision, true);
      assert.equal(res.json.models['sees-images'].sources.vision, 'probe');
      const imagePosts = seen.filter((r) => r.hasImage);
      assert.equal(imagePosts.length, 1);
      assert.equal(imagePosts[0]?.decodesImage, true);
    } finally {
      await new Promise((resolve) => visionMock.close(resolve));
    }
  });

  it('skips all image_url posts on first-load auto probe for loopback openai-v1', async () => {
    let imageRequests = 0;
    const visionMock = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: [{ id: 'qwen3.8-27b-q6' }] }));
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        let body = '';
        req.on('data', (c) => {
          body += c;
        });
        req.on('end', () => {
          const parsed = JSON.parse(body);
          if (JSON.stringify(parsed.messages).includes('image_url')) {
            imageRequests += 1;
          }
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({
              choices: [{ message: { content: 'pong' }, finish_reason: 'stop' }],
            }),
          );
        });
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    });
    await new Promise((resolve) => visionMock.listen(0, '127.0.0.1', resolve));
    const port = /** @type {import('net').AddressInfo} */ (visionMock.address()).port;

    try {
      await httpRequest(baseUrl, 'POST', '/api/providers', {
        id: 'probe-vision-auto',
        label: 'Loopback auto',
        baseUrl: `http://127.0.0.1:${port}`,
        apiKind: 'openai-v1',
      });

      const res = await httpRequest(
        baseUrl,
        'POST',
        '/api/providers/probe-vision-auto/capabilities/probe',
        { modelIds: ['qwen3.8-27b-q6'], auto: true },
      );
      assert.equal(res.status, 200);
      assert.equal(imageRequests, 0);
      assert.equal(res.json.models['qwen3.8-27b-q6'].sources.vision, 'catalog');
      assert.equal(res.json.models['qwen3.8-27b-q6'].sources.streaming, 'probe');
    } finally {
      await new Promise((resolve) => visionMock.close(resolve));
    }
  });

  it('does not stamp probe vision when the valid PNG returns mtmd/ffprobe', async () => {
    /** @type {string[]} */
    const imagePayloads = [];
    const visionMock = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: [{ id: 'qwen-vl' }] }));
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        let body = '';
        req.on('data', (c) => {
          body += c;
        });
        req.on('end', () => {
          const parsed = JSON.parse(body);
          const serialized = JSON.stringify(parsed.messages);
          res.setHeader('Content-Type', 'application/json');
          if (serialized.includes('image_url')) {
            imagePayloads.push(serialized);
            res.statusCode = 500;
            res.end(
              'E mtmd_helper_video_init_from_buf: ffprobe failed on buffer (is ffprobe in PATH?)\n' +
                'E mtmd_helper_bitmap_init_from_buf: failed to decode buffer as either image/audio/video',
            );
            return;
          }
          res.end(
            JSON.stringify({
              choices: [{ message: { content: 'pong' }, finish_reason: 'stop' }],
            }),
          );
        });
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    });
    await new Promise((resolve) => visionMock.listen(0, '127.0.0.1', resolve));
    const port = /** @type {import('net').AddressInfo} */ (visionMock.address()).port;

    try {
      await httpRequest(baseUrl, 'POST', '/api/providers', {
        id: 'probe-vision-mtmd',
        label: 'mtmd crash',
        baseUrl: `http://127.0.0.1:${port}`,
        apiKind: 'openai-v1',
      });

      const res = await httpRequest(
        baseUrl,
        'POST',
        '/api/providers/probe-vision-mtmd/capabilities/probe',
        { modelIds: ['qwen-vl'] },
      );
      assert.equal(res.status, 200);
      assert.equal(imagePayloads.length, 1);
      assert.equal(res.json.models['qwen-vl'].sources.vision, 'catalog');
      assert.match(res.json.models['qwen-vl'].probeErrors.vision, /mtmd|ffprobe/i);
    } finally {
      await new Promise((resolve) => visionMock.close(resolve));
    }
  });
});
