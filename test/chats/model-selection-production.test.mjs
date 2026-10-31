import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, beforeEach, test } from 'node:test';
import { setTestHome, rmTestHome } from '../config/test-helpers.js';
import { ensureMinnowLayout } from '../../server/config/home.js';
import { createProvider } from '../../server/providers/store.js';
import { createCompletionStream } from '../../server/runner/generation-binding.js';
import { cancel, createGenerationState, deleteGenerationsForProviderShutdown } from '../../server/generations/store.js';
import { getRouterWorkspace } from '../../server/model-routers/store.js';
import { invalidateRouterProvider } from '../../server/model-routers/availability.js';
import { runRouterGeneration } from '../../server/model-routers/generation.js';
import { resolveAgentModelSelection } from '../../server/chats/model-selection.js';

let home;
let upstream;
let workspace;
let calls = [];
let catalogs;

before(async () => {
  home = setTestHome(process.env, 'minnow-test-agent-model-selection');
  await ensureMinnowLayout();
  upstream = http.createServer(async (request, response) => {
    if (request.method === 'GET') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ data: catalogs }));
      return;
    }
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    if (request.url.endsWith('/decisions')) {
      calls.push({ kind: 'evaluation' });
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ answers: {
        taskType: { type: 'choice', choice: 'general', confidence: 0.95 },
        tier: { type: 'choice', choice: 'fast', confidence: 0.95 },
        effort: { type: 'choice', choice: 'low', confidence: 0.95 },
      } }));
      return;
    }
    calls.push(body);
    response.setHeader('Content-Type', 'text/event-stream');
    response.end('data: {"choices":[{"delta":{"content":"Done"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  await createProvider({ id: 'agent-models', label: 'Agent models', apiKind: 'openai-v1', baseUrl: `http://127.0.0.1:${upstream.address().port}` });
  workspace = await getRouterWorkspace();
  await workspace.save({ revision: workspace.revision, routers: [{
    id: 'agent-pool', name: 'Agent pool', enabled: true, policy: 'evaluate', evaluator: { providerId: 'agent-models', modelId: 'jev' },
    entries: [
      { id: 'primary', providerId: 'agent-models', modelId: 'primary', enabled: true, concurrencyLimit: 1 },
      { id: 'backup', providerId: 'agent-models', modelId: 'backup', enabled: true, concurrencyLimit: 1 },
    ],
  }] });
});

beforeEach(() => {
  calls = [];
  catalogs = [
    { id: 'primary', reasoning: { allowed_options: ['off', 'low', 'high'], default: 'low' } },
    { id: 'backup', reasoning: { allowed_options: ['low', 'high', 'max'], default: 'low' } },
    { id: 'jev' },
  ];
  invalidateRouterProvider('agent-models');
});

after(async () => {
  await workspace?.flush();
  deleteGenerationsForProviderShutdown();
  upstream?.closeAllConnections();
  if (upstream?.listening) await new Promise((resolve) => upstream.close(resolve));
  if (home) await rmTestHome(home);
});

const generation = (chatId, options, body = {}) => {
  const state = createGenerationState({ providerId: 'minnow-router', chatId, body: { model: 'agent-pool', messages: [{ role: 'user', content: 'rename a variable' }], stream: true, ...body } });
  if (options !== undefined) state.agentModelOptions = options;
  return state;
};

test('production direct preflight and completion preserve exact effort through upstream sanitization', async () => {
  const resolved = await resolveAgentModelSelection({ target: { providerId: 'agent-models', modelId: 'primary', options: { reasoningEffort: 'high' } } });
  const stream = await createCompletionStream(resolved.selection.providerId, {
    model: resolved.selection.modelId, messages: [{ role: 'user', content: 'hello' }], stream: true, reasoning_effort: resolved.selection.options.reasoningEffort,
  }, { chatId: 'direct-selection', exactModel: resolved.exactModel, agentModelOptions: resolved.selection.options, modelCapabilities: resolved.sendCapabilities });
  for await (const _chunk of stream) { /* drain the real in-process generation path */ }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, 'primary');
  assert.equal(calls[0].reasoning_effort, 'high');
  assert.equal(Object.hasOwn(calls[0], 'agentModelOptions'), false);
  assert.equal(Object.hasOwn(calls[0], 'exactModel'), false);
});

test('a requested pool effort filters members and overrides the evaluator without leaking routing metadata', async () => {
  const resolved = await resolveAgentModelSelection({ target: { providerId: 'minnow-router', modelId: 'agent-pool', options: { reasoningEffort: 'max' } } });
  assert.deepEqual(resolved.pool.eligibleEntryIds, ['backup']);
  const state = generation('explicit-pool', resolved.selection.options, { reasoning: { effort: 'low' } });
  await runRouterGeneration(state);
  assert.equal(state.status, 'complete');
  const actual = calls.filter((row) => row.kind !== 'evaluation');
  assert.equal(actual.length, 1);
  assert.equal(actual[0].model, 'backup');
  assert.equal(actual[0].reasoning_effort, 'max');
  if (actual[0].reasoning?.effort) assert.equal(actual[0].reasoning.effort, 'max');
  assert.equal(Object.hasOwn(actual[0], 'agentModelOptions'), false);
  assert.equal(state.chosenModelId, 'backup');
});

test('explicit thinking off survives an evaluator that would enable effort', async () => {
  const state = generation('thinking-off', { thinkingMode: 'off' }, { reasoning_effort: 'high', reasoning: { effort: 'high' } });
  await runRouterGeneration(state);
  assert.equal(state.status, 'complete');
  const actual = calls.filter((row) => row.kind !== 'evaluation');
  assert.equal(actual.length, 1);
  assert.equal(actual[0].model, 'primary');
  assert.equal(actual[0].reasoning_effort, 'none');
  assert.notEqual(actual[0].reasoning?.effort, 'high');
});

test('unsupported captured pool options fail before either evaluation or model inference', async () => {
  const state = generation('impossible-options', { reasoningEffort: 'xhigh' });
  await assert.rejects(runRouterGeneration(state), (error) => error.code === 'options_unsupported');
  assert.deepEqual(calls, []);
  await assert.rejects(resolveAgentModelSelection({ target: { providerId: 'agent-models', modelId: 'primary', options: { reasoningEffort: 'max' } } }), (error) => error.code === 'options_unsupported');
  assert.deepEqual(calls, []);
});

test('ordinary pool generations retain the existing evaluator defaults when no captured override is present', async () => {
  const state = generation('ordinary-pool');
  await runRouterGeneration(state);
  assert.equal(state.status, 'complete');
  const actual = calls.filter((row) => row.kind !== 'evaluation');
  assert.equal(actual.length, 1);
  assert.equal(actual[0].reasoning_effort, 'low');
});

test('queued explicit options are revalidated before inference after a catalog change', { timeout: 5000 }, async () => {
  const router = workspace.routers[0];
  let release = await workspace.scheduler.acquire(router, 'holding-backup', router.entries[1]);
  const state = generation('queued-explicit-options', { reasoningEffort: 'max' });
  const settled = runRouterGeneration(state).then(() => ({ error: null }), (error) => ({ error }));
  try {
    const deadline = Date.now() + 3000;
    while (![...workspace.scheduler.requests.values()].some((row) => row.chatId === 'queued-explicit-options' && row.status === 'queued')) {
      if (Date.now() > deadline) throw new Error('The captured-option generation did not queue');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    catalogs[1].reasoning.allowed_options = ['low', 'high'];
    invalidateRouterProvider('agent-models');
    release(); release = null;
    const result = await settled;
    assert.equal(result.error?.code, 'options_unsupported');
    assert.equal(calls.filter((row) => row.kind !== 'evaluation').length, 0);
    assert.ok(workspace.scheduler.activity(router).entries.every((entry) => entry.active === 0 && entry.queued === 0));
  } finally {
    release?.();
    if (state.status !== 'complete') cancel(state);
    await settled;
  }
});
