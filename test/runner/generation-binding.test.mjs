/**
 * P2-C — in-process generation binding (MIN-700).
 *
 * The runner obtains a completion stream via the generations store, not HTTP
 * `/api/generations`. Fake host is `scripts/fake-model-server.mjs`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, afterEach, before, describe, test } from 'node:test';
import {
  createFakeModelServer,
  proseSseChunks,
} from '../../scripts/fake-model-server.mjs';
import { setTestHome, rmTestHome } from '../config/test-helpers.js';
import { ensureMinnowLayout } from '../../server/config/home.js';
import { createProvider } from '../../server/providers/store.js';
import {
  createCompletionStream,
  createMemoryTranscriptStore,
  DEFAULT_REPORT_TOOL_NAME,
  postChatCompletionsInProcess,
  runHeadlessToolBatchStub,
  RUNNER_FALLBACK_ROLE,
  runTurn,
} from '../../server/runner/node.js';
import {
  deleteGenerationsForProviderShutdown,
  getGenerationState,
  hasActiveUserAgentGenerations,
  listGenerationStates,
  NON_AGENT_FALLBACK_ROLES,
} from '../../server/generations/store.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BINDING_JS = path.join(PROJECT_ROOT, 'server', 'runner', 'generation-binding.js');
const PROVIDER_ID = 'local-fake';
const CHAT_UUID = '550e8400-e29b-41d4-a716-446655440000';

/**
 * @param {string} name
 * @param {unknown} args
 * @param {string} [toolCallId]
 */
function functionCallChunks(name, args, toolCallId = 'call_report') {
  const argStr = typeof args === 'string' ? args : JSON.stringify(args);
  const delta = JSON.stringify({
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: toolCallId,
              type: 'function',
              function: { name, arguments: argStr },
            },
          ],
        },
      },
    ],
  });
  const finish = JSON.stringify({
    choices: [{ delta: {}, finish_reason: 'tool_calls' }],
  });
  return [
    `data: ${delta}\n\n`,
    `data: ${finish}\n\n`,
    'event: end\ndata: {"status":"complete"}\n\n',
  ];
}

function stubDeps(overrides = {}) {
  return {
    transcriptStore: createMemoryTranscriptStore(),
    postChatCompletions: postChatCompletionsInProcess,
    runHeadlessToolBatch: runHeadlessToolBatchStub,
    resolveProvider: async () => ({
      id: PROVIDER_ID,
      label: 'Local fake',
      baseUrl: 'http://127.0.0.1:1',
      apiKind: 'openai-v1',
      chatCompletionsPath: '/v1/chat/completions',
    }),
    getSubAgentTypeConfig: async () => ({}),
    resolveSamplerPreset: () => ({ preset: {}, maxTokens: 256 }),
    resolveThinkingMode: () => ({ mode: 'off' }),
    resolveThinkingBudgetTokens: () => ({ budgetTokens: null }),
    loadToolCallsMeta: async () => {},
    getToolCallsMetaSync: () => ({ useConstrainedDecoding: false }),
    isConstrainedDecodingEnabledForProvider: () => false,
    readProviderCapabilities: async () => null,
    isStructuredOutcomeResponseFormatAvailable: () => false,
    resolveSendCapabilities: () => ({}),
    resolveModelContextLimit: () => null,
    applyContextPolicy: async (input) => ({
      applied: false,
      messages: input.messages,
    }),
    ...overrides,
  };
}

function assertAgentGeneration(state) {
  assert.equal(state.persist, false, 'journal is the record; generations stay ephemeral');
  assert.ok(state.fallbackRole, 'fallback role must be set');
  assert.equal(
    NON_AGENT_FALLBACK_ROLES.has(state.fallbackRole),
    false,
    `fallbackRole ${state.fallbackRole} must be agent-family, not a utility/eval role`,
  );
}

async function waitFor(predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error('timed out waiting');
}

function wrapFetchCountingGenerationsHttp() {
  const orig = globalThis.fetch;
  let hits = 0;
  globalThis.fetch = async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : String(input?.url ?? '');
    if (url.includes('/api/generations')) hits += 1;
    return orig(input, init);
  };
  return {
    hits: () => hits,
    restore() {
      globalThis.fetch = orig;
    },
  };
}

describe('generation-binding source contract', () => {
  const source = fs.readFileSync(BINDING_JS, 'utf8');

  test('does not import the HTTP generations routes', () => {
    const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    assert.equal(code.includes('generations/routes'), false);
    assert.equal(code.includes('/api/generations'), false);
  });

  test('default fallback role is agent-family', () => {
    assert.equal(RUNNER_FALLBACK_ROLE, 'sub-agent');
    assert.equal(NON_AGENT_FALLBACK_ROLES.has(RUNNER_FALLBACK_ROLE), false);
  });
});

describe('in-process generation binding', { concurrency: false }, () => {
  const fake = createFakeModelServer({
    scenario: [
      {
        emit: functionCallChunks(DEFAULT_REPORT_TOOL_NAME, {
          outcome: 'pass',
          summary: 'in-process turn',
          evidence: ['ok'],
        }),
      },
    ],
  });
  /** @type {string} */
  let homeDir = '';
  /** @type {string} */
  let baseUrl = '';

  before(async () => {
    homeDir = setTestHome(process.env, 'minnow-test-p2c-binding');
    await ensureMinnowLayout();
    fake.reset();
    const port = await fake.listen(0);
    baseUrl = `http://127.0.0.1:${port}`;
    await createProvider({
      id: PROVIDER_ID,
      label: 'Local fake',
      baseUrl,
      apiKind: 'openai-v1',
    });
  });

  afterEach(() => {
    deleteGenerationsForProviderShutdown();
  });

  after(async () => {
    deleteGenerationsForProviderShutdown();
    await fake.close();
    await rmTestHome(homeDir);
  });

  test('runTurn completes with zero HTTP hits to /api/generations', { timeout: 20_000 }, async () => {
    const probe = wrapFetchCountingGenerationsHttp();
    try {
      const result = await runTurn({
        chatId: CHAT_UUID,
        seed: 'Do the work, then report.',
        tools: [],
        model: { providerId: PROVIDER_ID, id: 'test-model' },
        deps: stubDeps(),
      });
      assert.deepEqual(result, {
        outcome: 'pass',
        summary: 'in-process turn',
        evidence: ['ok'],
      });
      assert.equal(probe.hits(), 0, 'in-process binding must not POST /api/generations');
      const generations = listGenerationStates();
      assert.ok(generations.length > 0, 'expected at least one generation in the store');
      for (const state of generations) {
        assertAgentGeneration(state);
      }
    } finally {
      probe.restore();
    }
  });

  test('createCompletionStream sets persist false and sub-agent fallback', { timeout: 20_000 }, async () => {
    const stream = await createCompletionStream(
      PROVIDER_ID,
      {
        model: 'test-model',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      },
      {},
    );
    const state = getGenerationState(stream.generationId);
    assert.ok(state);
    assertAgentGeneration(state);
    assert.equal(state.fallbackRole, RUNNER_FALLBACK_ROLE);
    assert.equal(state.persist, false);

    const parts = [];
    for await (const payload of stream) {
      parts.push(payload);
    }
    assert.ok(parts.join('').includes('data:'), 'expected SSE payloads for sse-parse');
  });

  test('non-agent fallbackRole is coerced to sub-agent', { timeout: 20_000 }, async () => {
    const stream = await createCompletionStream(
      PROVIDER_ID,
      { model: 'test-model', messages: [{ role: 'user', content: 'hi' }], stream: true },
      { fallbackRole: 'utility' },
    );
    const state = getGenerationState(stream.generationId);
    assert.equal(state.fallbackRole, RUNNER_FALLBACK_ROLE);
    assert.equal(NON_AGENT_FALLBACK_ROLES.has(state.fallbackRole), false);
    for await (const _ of stream) {
      /* drain */
    }
  });

  test('captured options stay internal and explicit models cannot fall back', { timeout: 20_000 }, async () => {
    const options = { reasoningEffort: 'high' };
    const stream = await createCompletionStream(PROVIDER_ID, {
      model: 'test-model', messages: [{ role: 'user', content: 'Exact model.' }], stream: true,
    }, { agentModelOptions: options, exactModel: true });
    options.reasoningEffort = 'low';
    const state = getGenerationState(stream.generationId);
    assert.deepEqual(state.agentModelOptions, { reasoningEffort: 'high' });
    assert.equal(state.failoverDisabled, true);
    assert.deepEqual(state.candidates, [{ providerId: PROVIDER_ID, modelId: 'test-model' }]);
    const upstream = JSON.parse(state.requestBody.toString());
    assert.equal(upstream.agentModelOptions, undefined);
    assert.equal(upstream.exactModel, undefined);
    for await (const _ of stream) { /* consume production completion */ }
  });

  test('aborting mid-stream cancels upstream and leaves no streaming state', { timeout: 20_000 }, async () => {
    let upstreamClosed = false;
    const slow = http.createServer((req, res) => {
      if (req.method === 'POST') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write('data: {"choices":[{"delta":{"content":"hold"}}]}\n\n');
        const markClosed = () => {
          upstreamClosed = true;
        };
        req.on('close', markClosed);
        req.on('aborted', markClosed);
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    });
    await new Promise((resolve) => slow.listen(0, '127.0.0.1', resolve));
    const port = /** @type {import('net').AddressInfo} */ (slow.address()).port;
    await createProvider({
      id: 'slow-stream',
      label: 'Slow stream',
      baseUrl: `http://127.0.0.1:${port}`,
      apiKind: 'openai-v1',
    });

    const ac = new AbortController();
    const stream = await createCompletionStream(
      'slow-stream',
      { model: 'test-model', messages: [{ role: 'user', content: 'hang' }], stream: true },
      { signal: ac.signal },
    );
    const state = getGenerationState(stream.generationId);
    assert.ok(state);

    const consume = (async () => {
      try {
        for await (const _ of stream) {
          /* wait for abort */
        }
      } catch (err) {
        assert.equal(err?.name, 'AbortError');
      }
    })();

    await waitFor(() => state.totalBytes > 0);
    ac.abort();
    await consume;

    assert.equal(state.status, 'cancelled');
    assert.equal(hasActiveUserAgentGenerations(), false);
    await waitFor(() => upstreamClosed);
    assert.equal(upstreamClosed, true, 'upstream request must be aborted, not left hanging');

    await new Promise((resolve) => slow.close(resolve));
  });

  test('provider error surfaces as crashed TurnResult with the upstream message', { timeout: 20_000 }, async () => {
    const UNIQUE = 'model exploded uniquely for p2c';
    const errServer = http.createServer((req, res) => {
      if (req.method === 'POST') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: UNIQUE } }));
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    });
    await new Promise((resolve) => errServer.listen(0, '127.0.0.1', resolve));
    const port = /** @type {import('net').AddressInfo} */ (errServer.address()).port;
    await createProvider({
      id: 'error-host',
      label: 'Error host',
      baseUrl: `http://127.0.0.1:${port}`,
      apiKind: 'openai-v1',
    });

    const result = await runTurn({
      chatId: CHAT_UUID,
      seed: 'Go.',
      tools: [],
      model: { providerId: 'error-host', id: 'test-model' },
      deps: stubDeps({
        resolveProvider: async () => ({
          id: 'error-host',
          label: 'Error host',
          baseUrl: `http://127.0.0.1:${port}`,
          apiKind: 'openai-v1',
          chatCompletionsPath: '/v1/chat/completions',
        }),
      }),
    });

    assert.equal(result.outcome, 'crashed');
    assert.match(result.error, new RegExp(UNIQUE));

    await new Promise((resolve) => errServer.close(resolve));
  });
});
