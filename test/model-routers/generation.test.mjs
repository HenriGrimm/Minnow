import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTestHome, rmTestHome } from '../config/test-helpers.js';
import { ensureMinnowLayout } from '../../server/config/home.js';
import { createProvider } from '../../server/providers/store.js';
import { getRouterWorkspace } from '../../server/model-routers/store.js';
import { runRouterGeneration } from '../../server/model-routers/generation.js';
import { createGenerationState, cancel, deleteGenerationsForProviderShutdown } from '../../server/generations/store.js';
import { createCompletionStream } from '../../server/runner/generation-binding.js';

let home; let upstream; let mode = 'healthy'; let calls = []; let workspace;
before(async () => {
  home = setTestHome(process.env, 'minnow-test-model-routers'); await ensureMinnowLayout();
  upstream = http.createServer(async (req, res) => {
    if (req.method === 'GET') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: ['primary', 'backup'].map((id) => ({ id })) })); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); calls.push(body.model);
    if (mode === 'always-error' || (mode === 'error' && body.model === 'primary')) { res.writeHead(503); res.end('unavailable'); return; }
    res.setHeader('Content-Type', body.stream === false ? 'application/json' : 'text/event-stream');
    if (body.stream === false) { res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'complete' } }], usage: { total_tokens: 8 } })); return; }
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: body.model === 'primary' ? 'partial' : 'replacement' } }] })}\n\n`);
    if (mode === 'broken' && body.model === 'primary') { setTimeout(() => res.destroy(), 25); return; }
    if (mode === 'early-end' && body.model === 'primary') { res.end(); return; }
    setTimeout(() => res.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"total_tokens":8}}\n\ndata: [DONE]\n\n'), mode === 'long' && body.model === 'primary' ? 3500 : mode === 'slow' ? 150 : 5);
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  await createProvider({ id: 'router-test', label: 'Router test', apiKind: 'openai-v1', baseUrl: `http://127.0.0.1:${upstream.address().port}` });
  workspace = await getRouterWorkspace();
  await workspace.save({ revision: workspace.revision, defaultRouterId: 'test', routers: [{ id: 'test', name: 'Test router', enabled: true, policy: 'priority', entries: ['primary', 'backup'].map((id) => ({ id, modelId: id, providerId: 'router-test', enabled: true, concurrencyLimit: 1 })) }] });
});
after(async () => { await workspace?.flush(); deleteGenerationsForProviderShutdown(); upstream.closeAllConnections(); await new Promise((resolve) => upstream.close(resolve)); await rmTestHome(home); });
const generation = (chatId, stream = true) => createGenerationState({ providerId: 'minnow-router', chatId, body: { model: 'test', messages: [{ role: 'user', content: 'hi' }], stream } });

test('sub-agent completion moves off its busy sticky model through the in-process adapter', { timeout: 5000 }, async () => {
  mode = 'healthy'; calls = [];
  const router = workspace.routers[0];
  workspace.scheduler.select(router, 'worker-rounds', () => true);
  workspace.scheduler.select(router, 'parent-chat', () => true);
  const release = await workspace.scheduler.acquire(router, 'parent-chat', router.entries[0]);
  try {
    const stream = await createCompletionStream('minnow-router', {
      model: 'test', messages: [{ role: 'user', content: 'worker task' }], stream: true,
    }, { chatId: 'worker-rounds', routerPreferAvailable: true });
    for await (const _chunk of stream) { /* drain the real provider completion */ }
    assert.deepEqual(calls, ['backup']);
    assert.equal(workspace.scheduler.assignments[workspace.scheduler.assignmentKey('test', 'parent-chat')].assignedEntryId, 'primary');
    assert.equal(workspace.scheduler.activity(router).entries[0].queued, 0);
  } finally { release(); }
});
test('mid-stream failure emits a restart boundary and rebinds subsequent generations', async () => {
  mode = 'broken'; calls = []; const state = generation('failover');
  await runRouterGeneration(state);
  assert.equal(state.status, 'complete'); assert.deepEqual(calls, ['primary', 'backup']);
  const text = Buffer.concat(state.chunks).toString();
  assert.ok(text.indexOf('partial') < text.indexOf('"reset":true'));
  assert.ok(text.indexOf('"reset":true') < text.indexOf('replacement'));
  assert.match(text, /Response restarted/);
  mode = 'healthy'; calls = []; const next = generation('failover'); await runRouterGeneration(next);
  assert.deepEqual(calls, ['backup']);
});
test('non-streaming generations use router scheduling and record token telemetry', async () => {
  mode = 'healthy'; const state = generation('nonstream', false); await runRouterGeneration(state);
  assert.equal(state.status, 'complete'); assert.equal(JSON.parse(Buffer.concat(state.chunks).toString()).choices[0].message.content, 'complete');
  assert.ok(workspace.scheduler.activity(workspace.routers[0]).entries[0].telemetry.tokens >= 8);
});
test('queued stop does not call a provider or fail over and does not leak capacity', async () => {
  mode = 'slow'; calls = [];
  workspace.scheduler.override(workspace.routers[0], 'queued', 'primary');
  const first = generation('busy'); const firstRun = runRouterGeneration(first);
  while (!calls.length) await new Promise((resolve) => setTimeout(resolve, 5));
  const second = generation('queued'); const secondRun = runRouterGeneration(second);
  while (!workspace.scheduler.activity(workspace.routers[0]).entries[0].queued) await new Promise((resolve) => setTimeout(resolve, 5));
  cancel(second); await secondRun; await firstRun;
  assert.deepEqual(calls, ['primary']); assert.equal(second.status, 'cancelled');
  assert.equal(workspace.scheduler.activity(workspace.routers[0]).entries[0].active, 0);
});
test('configuration and assignments are persisted; activity is session-only', async () => {
  await workspace.flush(); const directory = path.join(home, 'model-routers');
  const files = await fs.readdir(directory); const saved = JSON.parse(await fs.readFile(path.join(directory, files[0]), 'utf8'));
  assert.equal(saved.defaultRouterId, 'test'); assert.equal(saved.routers[0].entries[0].modelId, 'primary');
  assert.ok(Object.values(saved.assignments).some((a) => a.chatId === 'failover' && a.assignedEntryId === 'backup'));
  assert.equal(saved.events, undefined);
  await assert.rejects(workspace.save({ ...saved, revision: -1 }), /another window/);
});

test('a clean socket close without a finish marker restarts instead of accepting partial output', async () => {
  mode = 'early-end'; calls = []; const state = generation('early-end'); await runRouterGeneration(state);
  assert.equal(state.status, 'complete'); assert.deepEqual(calls, ['primary', 'backup']);
  assert.match(Buffer.concat(state.chunks).toString(), /"reset":true/);
});
test('each failed provider/model is attempted once and exhaustion is actionable', async () => {
  mode = 'always-error'; calls = []; const state = generation('exhausted');
  await assert.rejects(runRouterGeneration(state), /No eligible models.*Test router/);
  assert.deepEqual(calls, ['primary', 'backup']);
  assert.ok(workspace.scheduler.activity(workspace.routers[0]).entries.every((e) => e.active === 0 && e.queued === 0));
});
test('disabling a queued entry wakes its waiter and binds it to the replacement', { timeout: 6000 }, async () => {
  mode = 'long'; calls = [];
  const router = workspace.routers[0]; workspace.scheduler.override(router, 'disabled-waiter', 'primary');
  const first = generation('long'); const running = runRouterGeneration(first);
  while (!calls.length) await new Promise((resolve) => setTimeout(resolve, 5));
  const next = generation('disabled-waiter'); const waiting = runRouterGeneration(next);
  while (!workspace.scheduler.activity(router).entries[0].queued) await new Promise((resolve) => setTimeout(resolve, 5));
  router.entries[0].enabled = false;
  try { await waiting; assert.equal(next.chosenModelId, 'backup'); await running; }
  finally { router.entries[0].enabled = true; }
  assert.deepEqual(calls, ['primary', 'backup']);
});

test('My Models router entries remap and complete through the bound upstream', async () => {
  const { setLibraryServeDepsForTests } = await import('../../server/model-routers/library-serve.js');
  const { setLibraryBindingDepsForTests } = await import('../../server/models/library-binding.js');
  const libraryId = 'gguf:qwen/Qwen3.5-9B:weights.Q4_K_M.gguf';
  setLibraryBindingDepsForTests({
    listCachedModels: async () => ({
      models: [{
        repo_id: 'qwen/Qwen3.5-9B',
        path: '/models/hub/qwen--Qwen3.5-9B',
        is_local_dir: true,
        gguf_files: [{ name: 'Qwen3.5-9B.Q4_K_M.gguf', rel_path: 'weights.Q4_K_M.gguf', size_bytes: 6000, role: 'model' }],
      }],
    }),
    findLiveLlamaCppServe: async () => null,
    findLiveMlxServe: async () => null,
    listServes: async () => [],
    startServe: async () => ({ id: 's', runtime: 'llama-cpp', status: 'running', modelLabel: 'primary' }),
    getServe: async () => null,
    sleep: async () => {},
    now: () => 0,
  });
  setLibraryServeDepsForTests({
    resolveLibraryId: async () => libraryId,
    findLiveLlamaCppServe: async () => null,
    findLiveMlxServe: async () => null,
    listServes: async () => [],
    listGenerationStates: () => [],
    resolveBinding: async () => ({ providerId: 'router-test', id: 'primary' }),
    sleep: async () => {},
    now: () => Date.now(),
    loadTimeoutMs: 5_000,
  });
  const previous = { revision: workspace.revision, defaultRouterId: workspace.defaultRouterId, routers: structuredClone(workspace.routers) };
  try {
    await workspace.save({
      revision: workspace.revision,
      defaultRouterId: 'lib',
      routers: [{
        id: 'lib',
        name: 'Library',
        enabled: true,
        policy: 'priority',
        entries: [{ id: 'e1', providerId: 'minnow-library', modelId: libraryId, enabled: true, concurrencyLimit: 1 }],
      }],
    });
    mode = 'healthy'; calls = [];
    const state = createGenerationState({ providerId: 'minnow-router', chatId: 'library-chat', body: { model: 'lib', messages: [{ role: 'user', content: 'hi' }], stream: true } });
    await runRouterGeneration(state);
    assert.equal(state.status, 'complete');
    assert.deepEqual(calls, ['primary']);
    const text = Buffer.concat(state.chunks).toString();
    assert.match(text, /"phase":"loading"/);
    assert.match(text, /"phase":"generating"/);
  } finally {
    setLibraryServeDepsForTests(null);
    setLibraryBindingDepsForTests(null);
    await workspace.save({ ...previous, revision: workspace.revision });
  }
});
