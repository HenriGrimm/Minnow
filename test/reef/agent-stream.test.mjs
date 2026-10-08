import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { applyAgentEvent, createAgentEventParser } from '../../server/reef/agent-stream.js';

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'reef-agent-stream-'));
process.env.MINNOW_HOME = home;
const { createApp, updateApp, readApp } = await import('../../server/reef/store.js');
const { runAgent } = await import('../../server/reef/agent.js');
const { runBuilderWithRecovery } = await import('../../server/reef/pipeline.js');
const { createRunActivity } = await import('../../server/reef/activity.js');
const { createReefMiddleware } = await import('../../server/reef/middleware.js');
const { recordEvent, reefEvents } = await import('../../server/reef/events.js');
after(() => fs.rm(home, { recursive: true, force: true }));

test('JSON lines survive arbitrary chunk boundaries and activity preserves reasoning and concurrent tool ids', async () => {
  const app = await createApp({ prompt: 'Stream test' }), runId = randomUUID();
  await updateApp(app.id, app => app.runs.push({ id: runId, chatIds: [], log: '' }));
  const activity = createRunActivity(app.id, runId);
  const parse = createAgentEventParser(event => activity.event({ ...event, chatId: 'planner', phase: 'plan' }));
  const events = [
    { type: 'agent_start' }, { type: 'round_start', index: 0 },
    { type: 'thinking', text: 'Think' }, { type: 'thinking', text: 'Think 🐟 about tests' },
    { type: 'delta', text: '**Plan**' },
    { type: 'tool_call', id: 'a', name: 'read_file', arguments: '{"path":"first.ts"}' },
    { type: 'tool_call', id: 'b', name: 'read_file', arguments: { path: 'second.ts' } },
    { type: 'tool_result', id: 'b', name: 'read_file', content: 'Second' },
    { type: 'tool_result', id: 'a', name: 'read_file', content: 'First' },
    { type: 'round_end', text: '**Plan**', reasoning: 'Think 🐟 about tests' }, { type: 'agent_end' },
  ];
  const wire = events.map(event => JSON.stringify(event) + '\n').join('');
  for (let i = 0; i < wire.length; i += 3) parse(wire.slice(i, i + 3));
  await activity.flush();
  const session = (await readApp(app.id)).runs[0].agentSessions[0];
  assert.equal(session.state, 'complete'); assert.equal(session.phase, 'plan');
  assert.equal(session.rounds.length, 1); assert.equal(session.rounds[0].reasoning, 'Think 🐟 about tests');
  assert.deepEqual(session.rounds[0].tools.map(tool => tool.result), ['First', 'Second']);
});

test('display data stays bounded, large arguments remain valid and planner/builder streams are isolated', () => {
  const run = {};
  const send = (chatId, event) => applyAgentEvent(run, { chatId, phase: chatId === 'plan' ? 'plan' : 'build', ...event });
  send('plan', { type: 'agent_start' }); send('plan', { type: 'delta', text: 'Planner response' }); send('plan', { type: 'agent_end' });
  send('build', { type: 'agent_start' });
  for (let i = 0; i < 200; i++) {
    send('build', { type: 'round_start', index: i });
    send('build', { type: 'delta', text: 'x'.repeat(20000) });
    send('build', { type: 'tool_call', id: String(i), name: 'save_file', arguments: { path: 'main.ts', content: 'y'.repeat(50000) } });
    send('build', { type: 'tool_result', id: String(i), name: 'save_file', content: 'z'.repeat(20000) });
  }
  assert.ok(JSON.stringify(run.agentSessions).length <= 512000);
  const session = run.agentSessions.at(-1); assert.ok(session.truncated);
  assert.equal(session.phase, 'build'); assert.equal(session.rounds.at(-1).tools[0].args.path, 'main.ts');
  assert.ok(session.rounds.every(round => round.text !== 'Planner response'));
});

test('planner, builder and continuations launch separate roles and fresh contexts; structured errors replace stdout dumps', async () => {
  const app = await createApp({ prompt: 'Build test', modelId: 'test' }), runId = randomUUID();
  await updateApp(app.id, app => app.runs.push({ id: runId, chatIds: [] }));
  const invocations = [], events = [];
  const execute = async (bin, args, options) => {
    assert.equal(options.timeout, 0, 'the supervisor owns the agent deadline');
    invocations.push({ args, prompt: options.input });
    options.stdout('{"type":"round_start","index":0}\n{"type":"delta","text":"Hello"}\n');
    const failing = invocations.length === 2;
    await fs.writeFile(args[args.indexOf('--json-out') + 1], JSON.stringify({ ok: !failing, assistantFinal: 'Done', error: failing ? 'context budget exceeded' : null }));
    if (failing) throw new Error('Command failed (1): huge response and tool stdout');
  };
  const input = { app, runId, workspace: home, baseUrl: 'http://unused', signal: new AbortController().signal, event: event => events.push(event), execute };
  const plan = await runAgent({ ...input, phase: 'plan', prompt: 'Plan only' });
  await updateApp(app.id, current => { current.providerId = 'next-provider'; current.modelId = 'next-model'; });
  await runBuilderWithRecovery({ ...input, prompt: `Implement plan: ${plan.text}` }, runAgent);
  assert.equal(invocations.length, 3);
  const ids = invocations.map(({ args }) => args[args.indexOf('--chat-id') + 1]);
  assert.equal(new Set(ids).size, 3);
  assert.deepEqual(invocations.map(({ args }) => args[args.indexOf('--agent') + 1]), ['planner', 'builder', 'builder']);
  assert.deepEqual(invocations.map(({ args }) => args[args.indexOf('--model') + 1]), ['test', 'next-model', 'next-model']);
  assert.ok(invocations.slice(1).every(({ args }) => args[args.indexOf('--provider') + 1] === 'next-provider'));
  assert.ok(invocations.every(({ args }) => args.includes('--stream-json')));
  assert.equal(invocations[1].prompt, 'Implement plan: Done');
  assert.match(invocations[2].prompt, /Inspect the existing files first/);
  assert.ok(!invocations[2].prompt.includes('Hello'));
  assert.equal(events.find(event => event.type === 'agent_end' && event.error).error, 'context budget exceeded');
  assert.deepEqual((await readApp(app.id)).runs[0].chatIds, ids);
});

test('agent process failures without a result report diagnostics and preserve cancellation', async () => {
  const app = await createApp({ prompt: 'Process failure', modelId: 'test' }), runId = randomUUID();
  await updateApp(app.id, current => current.runs.push({ id: runId, chatIds: [] }));
  const events = [];
  const input = { app, runId, workspace: home, prompt: 'Build', phase: 'build', baseUrl: 'http://unused',
    signal: new AbortController().signal, event: event => events.push(event) };
  await assert.rejects(runAgent({ ...input, execute: async () => { throw new Error('Command failed (1): provider crashed'); } }), /provider crashed/);
  assert.match(events.at(-1).error, /provider crashed/);
  const controller = new AbortController(), reason = new Error('Build exceeded the 45-minute deadline');
  await assert.rejects(runAgent({ ...input, signal: controller.signal, execute: async () => {
    controller.abort(reason);
    throw new Error('Command failed (1): process killed');
  } }), error => error === reason);
  assert.equal(events.at(-1).error, reason.message);
});

test('builder context recovery is bounded and does not retry cancellation or unrelated failures', async () => {
  const input = { prompt: 'Build', signal: new AbortController().signal };
  let attempts = 0;
  await assert.rejects(runBuilderWithRecovery(input, async () => { attempts++; throw new Error('context budget exceeded'); }), /context budget exceeded/);
  assert.equal(attempts, 3);
  attempts = 0;
  await assert.rejects(runBuilderWithRecovery(input, async () => { attempts++; throw new Error('provider unavailable'); }), /provider unavailable/);
  assert.equal(attempts, 1);
  const abort = new AbortController(); abort.abort(new Error('Cancelled'));
  await assert.rejects(runBuilderWithRecovery({ ...input, signal: abort.signal }, async () => { attempts++; }), /Cancelled/);
  assert.equal(attempts, 1);
});

test('model changes persist during a build and invalid selections preserve the previous binding', async t => {
  const { createProvider } = await import('../../server/providers/store.js');
  const { reefSupervisor } = await import('../../server/reef/supervisor.js');
  const { readEvents } = await import('../../server/reef/events.js');
  await createProvider({ id: 'model-switch', baseUrl: 'http://localhost:1234', apiKind: 'openai-v1' });
  const app = await createApp({ prompt: 'Switch models', providerId: 'original', modelId: 'original' });
  const runId = randomUUID();
  await updateApp(app.id, current => {
    current.status = 'building'; current.runs.push({ id: runId, state: 'building', progress: 20, chatIds: [] });
  });
  const middleware = createReefMiddleware();
  const server = http.createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end(); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const previousBaseUrl = reefSupervisor.baseUrl;
  reefSupervisor.baseUrl = base;
  const request = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url).endsWith('/api/providers/model-switch/models')) return Response.json({ data: [{ id: 'replacement' }] });
    return request(url, options);
  });
  const choose = input => request(`${base}/api/reef/apps/${app.id}/model`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  });
  try {
    const response = await choose({ providerId: 'model-switch', modelId: 'replacement' });
    assert.equal(response.status, 200);
    const saved = await readApp(app.id);
    assert.equal(saved.providerId, 'model-switch'); assert.equal(saved.modelId, 'replacement');
    assert.equal(saved.status, 'building'); assert.deepEqual(saved.runs, (await response.json()).runs);
    assert.equal(saved.runs[0].id, runId);
    assert.equal((await readEvents(app.id)).at(-1).type, 'model');
    for (const [input, status] of [
      [{ providerId: 'model-switch', modelId: 'missing' }, 400],
      [{ providerId: 'missing-provider', modelId: 'replacement' }, 404],
      [{ providerId: 'model-switch', modelId: '' }, 400],
    ]) {
      assert.equal((await choose(input)).status, status);
      assert.equal((await readApp(app.id)).modelId, 'replacement');
      assert.equal((await readApp(app.id)).providerId, 'model-switch');
    }
  } finally {
    reefSupervisor.baseUrl = previousBaseUrl;
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});

test('SSE backpressure pauses and drains in order without disconnecting the subscriber', async () => {
  const app = await createApp({ prompt: 'Backpressure' });
  await recordEvent(app.id, { type: 'stage' }); await recordEvent(app.id, { type: 'activity' });
  const res = new EventEmitter(), output = [];
  let first = true;
  Object.assign(res, {
    destroyed: false, writeHead() {}, flushHeaders() {},
    write(text) { output.push(text); if (text.startsWith('id:') && first) { first = false; return false; } return true; },
    destroy() { res.destroyed = true; res.emit('close'); },
  });
  const req = { url: `/api/reef/apps/${app.id}/events`, method: 'GET', headers: {}, socket: { setTimeout() {} } };
  try {
    await createReefMiddleware()(req, res, () => {});
    assert.equal(res.destroyed, false);
    assert.match(output.join(''), /id: 1/); assert.doesNotMatch(output.join(''), /id: 2/);
    await recordEvent(app.id, { type: 'activity' });
    res.emit('drain');
    assert.match(output.join(''), /id: 2[\s\S]*id: 3/); assert.equal(res.destroyed, false);
  } finally { res.emit('close'); }
  assert.equal(reefEvents.listenerCount(app.id), 0);
});
