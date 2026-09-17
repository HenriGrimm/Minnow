/**
 * Pre-first-token failover and no mid-stream switching tests.
 */

import assert from 'node:assert/strict';
import { after, before, describe, mock, test } from 'node:test';
import http from 'node:http';
import { setTestHome, rmTestHome } from '../config/test-helpers.js';
import { ensureMinnowLayout } from '../../server/config/home.js';
import { writeConfigJson } from '../../server/config/store.js';
import { createProvider } from '../../server/providers/store.js';
import {
  cancel,
  createGenerationState,
  getGenerationState,
  deleteGenerationsForProviderShutdown,
} from '../../server/generations/store.js';
import { pumpUpstream, pumpUpstreamAsync } from '../../server/generations/upstream.js';
import { thinkingToCompletionBody } from '../../server/runner/thinking-to-body.js';
import { resetHostCooldownForTests } from '../../server/generations/host-cooldown.js';

let homeDir;
let primaryBaseUrl;
let backupBaseUrl;
let primaryServer;
let backupServer;
let primaryCalls = 0;
let backupCalls = 0;

function waitForTerminal(id, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const state = getGenerationState(id);
      if (!state) {
        reject(new Error('missing generation state'));
        return;
      }
      if (state.status === 'complete' || state.status === 'error' || state.status === 'cancelled') {
        resolve(state);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`timeout waiting for terminal status (last=${state.status})`));
        return;
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}

before(async () => {
  homeDir = setTestHome(process.env, 'minnow-test-fallback-upstream');
  await ensureMinnowLayout();

  primaryServer = http.createServer((req, res) => {
    primaryCalls += 1;
    if (req.method === 'POST') {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end('primary unavailable');
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  backupServer = http.createServer((req, res) => {
    backupCalls += 1;
    if (req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });

  await new Promise((resolve) => primaryServer.listen(0, '127.0.0.1', resolve));
  await new Promise((resolve) => backupServer.listen(0, '127.0.0.1', resolve));

  const primaryPort = /** @type {import('net').AddressInfo} */ (primaryServer.address()).port;
  const backupPort = /** @type {import('net').AddressInfo} */ (backupServer.address()).port;
  primaryBaseUrl = `http://127.0.0.1:${primaryPort}`;
  backupBaseUrl = `http://127.0.0.1:${backupPort}`;

  await createProvider({
    id: 'primary-fixed',
    label: 'Primary',
    baseUrl: primaryBaseUrl,
    apiKind: 'openai-v1',
  });
  await createProvider({
    id: 'backup-fixed',
    label: 'Backup',
    baseUrl: backupBaseUrl,
    apiKind: 'openai-v1',
  });

  await writeConfigJson('config.json', {
    fallbackChains: {
      enabled: true,
      cooldownSeconds: 60,
      maxChainLength: 4,
      roles: {
        default: [{ providerId: 'backup-fixed', modelId: '' }],
        utility: [],
        research: [],
        vision: [],
      },
    },
  });
});

after(async () => {
  deleteGenerationsForProviderShutdown();
  resetHostCooldownForTests();
  await new Promise((resolve) => primaryServer.close(resolve));
  await new Promise((resolve) => backupServer.close(resolve));
  await rmTestHome(homeDir);
  mock.restoreAll();
});

describe('upstream failover', () => {
  test('Go utility and orchestrator requests reach the correct endpoint with supported controls', async (t) => {
    await createProvider({
      id: 'go-compatibility', label: 'Go',
      baseUrl: 'https://opencode.ai/zen/go/v1', apiKind: 'openai-v1',
    });
    const requests = [];
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body.toString()) });
      const sse = String(url).endsWith('/responses')
        ? 'data: {"type":"response.output_text.delta","delta":"ok"}\n\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n'
        : 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n';
      return new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } });
    });
    for (const model of ['glm-5.3-flash', 'kimi-k3', 'grok-4.6']) {
      for (const fallbackRole of ['utility', 'default']) {
        const { body: thinking } = thinkingToCompletionBody('off', 'openai-v1', undefined, null, model);
        const state = createGenerationState({
          providerId: 'go-compatibility', fallbackRole,
          body: { model, messages: [{ role: 'user', content: 'Hi' }], max_tokens: 700, stream: true, ...thinking },
        });
        await pumpUpstreamAsync({ state });
        if (state.evictTimer) clearTimeout(state.evictTimer);
        assert.equal(state.status, 'complete', state.errorMessage);
        const { url, body } = requests.at(-1);
        assert.equal(body.thinking, undefined);
        assert.equal(body.enable_thinking, undefined);
        assert.equal(body.chat_template_kwargs, undefined);
        if (model === 'grok-4.6') {
          assert.equal(url, 'https://opencode.ai/zen/go/v1/responses');
          assert.deepEqual(body.reasoning, { effort: 'low' });
          assert.equal(body.max_output_tokens, fallbackRole === 'utility' ? 2048 : 700);
        } else {
          assert.equal(url, 'https://opencode.ai/zen/go/v1/chat/completions');
          assert.equal(body.reasoning, undefined);
          if (model.startsWith('glm')) assert.equal(body.reasoning_effort, 'low');
          assert.equal(body.max_tokens, fallbackRole === 'utility' ? 2048 : 700);
        }
      }
    }
    assert.equal(requests.length, 6);
  });

  test('retries next candidate before first token when primary refuses connection', async () => {
    resetHostCooldownForTests();
    primaryCalls = 0;
    backupCalls = 0;

    const state = createGenerationState({
      providerId: 'primary-fixed',
      body: { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] },
      candidates: [
        { providerId: 'primary-fixed', modelId: 'test-model' },
        { providerId: 'backup-fixed', modelId: 'test-model' },
      ],
    });

    pumpUpstream({ state });
    const terminal = await waitForTerminal(state.id);

    assert.equal(terminal.status, 'complete');
    assert.equal(terminal.fallbackUsed, true);
    assert.equal(terminal.chosenProviderId, 'backup-fixed');
    assert.ok(terminal.totalBytes > 0);
    assert.ok(primaryCalls >= 1);
    assert.ok(backupCalls >= 1);
  });

  test('does not switch models after bytes were emitted', async () => {
    resetHostCooldownForTests();
    mock.method(globalThis, 'fetch', async () => ({
      ok: true,
      body: {
        getReader() {
          let sent = false;
          return {
            async read() {
              if (!sent) {
                sent = true;
                return { done: false, value: new TextEncoder().encode('data: chunk\n\n') };
              }
              const err = new Error('socket hang up');
              err.code = 'ECONNRESET';
              throw err;
            },
          };
        },
      },
    }));

    const state = createGenerationState({
      providerId: 'primary-fixed',
      body: { model: 'test-model', messages: [] },
      candidates: [{ providerId: 'primary-fixed', modelId: 'test-model' }],
    });

    pumpUpstream({ state });
    const terminal = await waitForTerminal(state.id);

    assert.equal(terminal.fallbackUsed, false);
    assert.equal(terminal.chosenProviderId, 'primary-fixed');
    assert.equal(terminal.status, 'error');
    assert.ok(terminal.totalBytes > 0);
    mock.restoreAll();
  });

  test('zero-byte upstream marks error instead of complete', async () => {
    resetHostCooldownForTests();
    const emptyServer = http.createServer((req, res) => {
      if (req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end('');
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    });
    await new Promise((resolve) => emptyServer.listen(0, '127.0.0.1', resolve));
    const port = /** @type {import('net').AddressInfo} */ (emptyServer.address()).port;
    const baseUrl = `http://127.0.0.1:${port}`;
    await createProvider({
      id: 'empty-upstream',
      label: 'Empty',
      baseUrl,
      apiKind: 'openai-v1',
    });

    const state = createGenerationState({
      providerId: 'empty-upstream',
      body: { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] },
      candidates: [{ providerId: 'empty-upstream', modelId: 'test-model' }],
    });

    pumpUpstream({ state });
    const terminal = await waitForTerminal(state.id);

    assert.equal(terminal.status, 'error');
    assert.match(terminal.errorMessage ?? '', /empty response/i);
    assert.equal(terminal.totalBytes, 0);

    await new Promise((resolve) => emptyServer.close(resolve));
  });

  test('HTTP 200 HTML proxy pages are errors instead of successful generations', async () => {
    resetHostCooldownForTests();
    mock.method(globalThis, 'fetch', async () =>
      new Response('<!doctype html><title>Proxy error</title>', {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      }),
    );
    const state = createGenerationState({
      providerId: 'primary-fixed',
      body: { model: 'test-model', messages: [] },
      candidates: [{ providerId: 'primary-fixed', modelId: 'test-model' }],
    });

    pumpUpstream({ state });
    const terminal = await waitForTerminal(state.id);

    assert.equal(terminal.status, 'error');
    assert.equal(terminal.totalBytes, 0);
    assert.match(terminal.errorMessage ?? '', /HTML error page/i);
    mock.restoreAll();
  });

  test('a generation cancelled before the upstream attempt never fetches', async () => {
    resetHostCooldownForTests();
    let fetchCalls = 0;
    mock.method(globalThis, 'fetch', async () => {
      fetchCalls += 1;
      return new Response('data: [DONE]\n\n');
    });
    const state = createGenerationState({
      providerId: 'primary-fixed',
      body: { model: 'test-model', messages: [] },
      candidates: [{ providerId: 'primary-fixed', modelId: 'test-model' }],
    });
    cancel(state);

    pumpUpstream({ state });
    await new Promise((resolve) => setTimeout(resolve, 25));

    assert.equal(state.status, 'cancelled');
    assert.equal(fetchCalls, 0);
    mock.restoreAll();
  });
});

describe('rate limit retries', () => {
  /**
   * Stand up an upstream that 429s a fixed number of times before streaming.
   * @param {{ failures: number, retryAfter?: string }} options
   */
  async function startRateLimitedServer({ failures, retryAfter }) {
    let calls = 0;
    const server = http.createServer((req, res) => {
      if (req.method !== 'POST') {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      calls += 1;
      if (calls <= failures) {
        const headers = { 'Content-Type': 'text/plain' };
        if (retryAfter) headers['Retry-After'] = retryAfter;
        res.writeHead(429, headers);
        res.end('rate limited');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = /** @type {import('net').AddressInfo} */ (server.address()).port;
    return { server, baseUrl: `http://127.0.0.1:${port}`, calls: () => calls };
  }

  test('retries the same candidate through 429s instead of failing the turn', async () => {
    resetHostCooldownForTests();
    const upstream = await startRateLimitedServer({ failures: 2, retryAfter: '0' });
    await createProvider({
      id: 'rate-limited',
      label: 'Rate limited',
      baseUrl: upstream.baseUrl,
      apiKind: 'openai-v1',
    });

    const state = createGenerationState({
      providerId: 'rate-limited',
      body: { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] },
      candidates: [{ providerId: 'rate-limited', modelId: 'test-model' }],
    });

    pumpUpstream({ state });
    const terminal = await waitForTerminal(state.id, 15_000);

    assert.equal(terminal.status, 'complete');
    assert.equal(terminal.fallbackUsed, false);
    assert.equal(terminal.chosenProviderId, 'rate-limited');
    assert.equal(upstream.calls(), 3, 'one initial attempt plus two retries');

    await new Promise((resolve) => upstream.server.close(resolve));
  });

  test('a persistently rate-limited candidate errors after the attempt cap', async () => {
    resetHostCooldownForTests();
    const upstream = await startRateLimitedServer({
      failures: Number.MAX_SAFE_INTEGER,
      retryAfter: '0',
    });
    await createProvider({
      id: 'always-limited',
      label: 'Always limited',
      baseUrl: upstream.baseUrl,
      apiKind: 'openai-v1',
    });

    const state = createGenerationState({
      providerId: 'always-limited',
      body: { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] },
      candidates: [{ providerId: 'always-limited', modelId: 'test-model' }],
    });

    pumpUpstream({ state });
    const terminal = await waitForTerminal(state.id, 15_000);

    assert.equal(terminal.status, 'error');
    assert.match(terminal.errorMessage ?? '', /429/);
    assert.equal(upstream.calls(), 3, 'capped at MAX_SAME_CANDIDATE_ATTEMPTS');

    await new Promise((resolve) => upstream.server.close(resolve));
  });

  test('a rate-limited host is not put into cooldown', async () => {
    resetHostCooldownForTests();
    const upstream = await startRateLimitedServer({ failures: 1, retryAfter: '0' });
    await createProvider({
      id: 'limited-once',
      label: 'Limited once',
      baseUrl: upstream.baseUrl,
      apiKind: 'openai-v1',
    });

    const first = createGenerationState({
      providerId: 'limited-once',
      body: { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] },
      candidates: [{ providerId: 'limited-once', modelId: 'test-model' }],
    });
    pumpUpstream({ state: first });
    assert.equal((await waitForTerminal(first.id, 15_000)).status, 'complete');

    const second = createGenerationState({
      providerId: 'limited-once',
      body: { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] },
      candidates: [{ providerId: 'limited-once', modelId: 'test-model' }],
    });
    pumpUpstream({ state: second });
    const terminal = await waitForTerminal(second.id, 15_000);

    assert.equal(terminal.status, 'complete', 'host must not be in cooldown');

    await new Promise((resolve) => upstream.server.close(resolve));
  });
});
