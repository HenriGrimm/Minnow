import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile, fork, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { functionCallChunks, proseSseChunks } from '../../scripts/fake-model-server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// Each CLI turn cold-compiles the headless graph through tsx; Windows CI runners need far longer.
const SLOW = process.platform === 'win32' ? 3 : 1;
let home, workspace, foreign, model, host, base, token;
const children = new Set();
let modelStarted;
let notifyModelStarted;
let lastModelText = '';

async function awaitModel(run) {
  let timer;
  try {
    await Promise.race([
      modelStarted,
      run.done.then(outcome => { throw new Error(`CLI ended before scripted model barrier: ${JSON.stringify(outcome)}`); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Model barrier timeout; last request: ${lastModelText.slice(-1000)}`)), 10000); }),
    ]);
  } finally { clearTimeout(timer); }
}

function ipc(type, requestId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(() => reject(new Error(`Host ${type} timeout`))), 15000);
    function receive(message) {
      if (message.type === type && (!requestId || message.requestId === requestId)) finish(() => resolve(message));
    }
    function fail(code) { finish(() => reject(new Error(`Host exited (${code})`))); }
    function finish(fn) { clearTimeout(timer); host.off('message', receive); host.off('exit', fail); fn(); }
    host.on('message', receive);
    host.on('exit', fail);
  });
}
async function api(route, options = {}) {
  return fetch(`${base}${route}`, {
    ...options,
    headers: { 'X-Minnow-Token': token, 'X-Minnow-Workspace': workspace, 'Content-Type': 'application/json', ...options.headers },
  });
}
async function states() {
  const requestId = crypto.randomUUID();
  const answer = ipc('states', requestId);
  host.send({ type: 'states', requestId });
  return (await answer).states;
}
async function until(predicate) {
  for (let i = 0; i < 500; i++) {
    const value = await predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('production boundary condition did not settle');
}
function launch(prompt, chatId) {
  const child = spawn(process.execPath, [path.join(root, 'bin/minnow.mjs'), 'run', '--json', '--profile', 'lite', '--prompt', prompt,
    '--workspace', workspace, '--base-url', base, '--token', token, '--provider', 'boundary-fixture', '--model', 'fixture',
    '--persist-chat', '--chat-id', chatId], { cwd: root, env: { ...process.env, MINNOW_HOME: home, BROWSER: 'none', MINNOW_HEADLESS: '1' }, windowsHide: true });
  children.add(child);
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => {
      children.delete(child);
      try { resolve({ code, result: JSON.parse(stdout), stderr }); }
      catch (error) { reject(new Error(`CLI result missing (${code}): ${stderr}`, { cause: error })); }
    });
  });
  void done.catch(() => {});
  return { child, done };
}

before(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-production-boundary-'));
  workspace = path.join(home, 'project');
  foreign = path.join(home, 'other-project');
  await fs.mkdir(workspace);
  await fs.mkdir(foreign);
  await fs.writeFile(path.join(workspace, 'README.md'), 'boundary read persisted');
  await fs.writeFile(path.join(foreign, 'secret.txt'), 'foreign data');
  model = http.createServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'fixture', object: 'model', context_length: 32768 }] }));
      return;
    }
    if (req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return; }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    // Provider normalization may express user text as typed content blocks.
    const text = JSON.stringify(body.messages);
    lastModelText = text;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (text.includes('[hold-generation]')) {
      res.write('data: {"choices":[{"delta":{"content":"Partial waiting text"}}]}\n\n');
      notifyModelStarted?.();
      return;
    }
    if (text.includes('[provider-error]')) {
      res.write('data: {"choices":[{"delta":{"content":"Partial failure text"}}]}\n\n');
      notifyModelStarted?.();
      // The shared core retries transport interruptions. Fail every attempt,
      // after the actual generation store confirms its partial bytes arrived.
      void until(async () => (await states()).find(row => row.status === 'streaming' && row.totalBytes > 0))
        .then(() => res.destroy(new Error('Scripted provider failure')), () => res.destroy());
      return;
    }
    if (body.tools?.some(tool => tool.function.name === 'report_outcome')) {
      res.end(functionCallChunks('report_outcome', { outcome: 'pass', summary: 'Child completed', evidence: [] }).join(''));
      return;
    }
    res.end(body.messages.some(row => row.role === 'tool')
      ? proseSseChunks('Read confirmed.').join('')
      : functionCallChunks('read_file', { path: 'README.md' }, 'boundary-read').join(''));
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  await startHost();
  const toolsResponse = await api('/api/config/tools');
  const tools = await toolsResponse.json();
  tools.enabled.read_file = true;
  tools.permissions.default.read_file = 'full';
  assert.equal((await api('/api/config/tools', { method: 'PUT', body: JSON.stringify(tools) })).status, 200);
  const sessions = await (await api('/api/config/sessions')).json();
  const seed = { id: 'boundary-binding', name: 'Boundary binding', workspacePath: workspace, providerId: 'boundary-fixture', modelId: 'fixture', modeId: 'general', history: [], lastStats: null, modelInfo: {}, updatedAt: Date.now() };
  assert.equal((await api('/api/config/sessions', { method: 'PATCH', body: JSON.stringify({ baseVersion: sessions.version, chats: [seed], scalars: { activeId: seed.id } }) })).status, 200);
});

async function startHost() {
  host = fork(path.join(root, 'test/fixtures/production-boundary-host.mjs'), [], {
    cwd: root,
    env: { ...process.env, MINNOW_HOME: home, BOUNDARY_MODEL_URL: `http://127.0.0.1:${model.address().port}`, MINNOW_HEADLESS: '1', BROWSER: 'none' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
  });
  let diagnostics = '';
  host.stderr.on('data', chunk => { diagnostics += chunk; });
  host.stdout.on('data', () => {});
  let ready;
  try { ready = await ipc('ready'); }
  catch (error) { throw new Error(`${error.message}\n${diagnostics}`); }
  base = ready.baseUrl;
  token = ready.token;
  const registered = await api('/api/workspace/open', { method: 'POST', headers: { 'X-Minnow-Workspace': '' }, body: JSON.stringify({ path: workspace }) });
  assert.equal(registered.status, 200, await registered.text());
}

async function killOwnedChild(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise(resolve => execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, () => resolve()));
  } else child.kill('SIGKILL');
}
async function stopHost() {
  if (!host || host.exitCode !== null) return;
  const stopped = new Promise(resolve => host.once('exit', resolve));
  host.send({ type: 'stop' });
  let timer;
  await Promise.race([stopped, new Promise(resolve => { timer = setTimeout(() => { void killOwnedChild(host).then(resolve); }, 5000); })]);
  clearTimeout(timer);
}
after(async () => {
  for (const child of children) await killOwnedChild(child);
  await stopHost();
  model?.closeAllConnections();
  if (model) await new Promise(resolve => model.close(resolve));
  if (home) await fs.rm(home, { recursive: true, force: true });
});

async function parentStream(parentChatId) {
  const controller = new AbortController();
  const response = await api(`/api/agents/events?parentChatId=${encodeURIComponent(parentChatId)}`, { signal: controller.signal });
  assert.equal(response.status, 200, await (response.status !== 200 ? response.text() : Promise.resolve('')));
  const frames = [];
  const reader = response.body.getReader();
  const pump = (async () => {
    let buffer = '';
    const decoder = new TextDecoder();
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) return;
        buffer += decoder.decode(next.value, { stream: true });
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const raw = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const event = /^event: (.+)$/m.exec(raw)?.[1];
          const data = /^data: (.+)$/m.exec(raw)?.[1];
          if (event && data) frames.push({ event, data: JSON.parse(data) });
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    }
  })();
  void pump.catch(() => {});
  return {
    frames,
    wait: (event, predicate = () => true) => until(() => frames.find(frame => frame.event === event && predicate(frame.data))),
    close: async () => { controller.abort(); await pump; },
  };
}

async function spawnChild(parentChatId, runId) {
  const response = await api('/api/agents', { method: 'POST', body: JSON.stringify({
    type: 'explore', task: 'Report success immediately.', parentChatId, runId, cwd: workspace, providerId: 'boundary-fixture', modelId: 'fixture',
  }) });
  assert.equal(response.status, 201, await response.text());
}

async function acceptDelivery(parentChatId, frame) {
  const sessions = await (await api('/api/config/sessions')).json();
  let parent = sessions.chats.find(chat => chat.id === parentChatId);
  parent ??= { id: parentChatId, name: 'Boundary parent', workspacePath: workspace, providerId: 'boundary-fixture', modelId: 'fixture', modeId: 'general', history: [], lastStats: null, modelInfo: {}, updatedAt: Date.now() };
  const receipt = new Set(parent.subAgentDeliveryReceipts ?? []);
  const fresh = frame.runIds.filter(id => !receipt.has(id));
  if (fresh.length) {
    parent.history.push({ role: 'user', content: frame.message, hiddenFromTranscript: true });
    parent.subAgentDeliveryReceipts = [...receipt, ...fresh];
  }
  const persisted = await api('/api/config/sessions', { method: 'PATCH', body: JSON.stringify({ baseVersion: sessions.version, chats: [parent] }) });
  assert.equal(persisted.status, 200, await persisted.text());
  // ACK comes only after durable acceptance, matching the renderer protocol.
  const ack = await api('/api/agents/delivery/ack', { method: 'POST', body: JSON.stringify({ parentChatId, runIds: frame.runIds }) });
  assert.equal(ack.status, 200);
  return (await ack.json()).accepted;
}

test('normal runtime rejects missing/bad tokens and keeps tools inside the request workspace', async () => {
  assert.equal((await fetch(`${base}/api/tools/ping`)).status, 401);
  assert.equal((await api('/api/tools/ping', { headers: { 'X-Minnow-Token': 'invalid' } })).status, 401);
  assert.equal((await api('/api/tools/ping')).status, 200);
  const read = await api('/api/tools', { method: 'POST', body: JSON.stringify({ name: 'read_file', args: { path: path.join(foreign, 'secret.txt') } }) });
  const body = await read.json();
  assert.match(JSON.stringify(body), /outside|workspace|not allowed|boundary/i);
  assert.doesNotMatch(JSON.stringify(body), /foreign data/);
});

test('actual CLI shared turn executes a read-only tool and survives durable session reload', { timeout: 30000 * SLOW }, async () => {
  const run = await launch('Read README.md and confirm.', 'boundary-success').done;
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.result.ok, true);
  assert.equal(run.result.assistantFinal, 'Read confirmed.');
  assert.equal(run.result.turns[0].toolCalls[0].name, 'read_file');
  const sessions = await (await api('/api/config/sessions')).json();
  const chat = sessions.chats.find(row => row.id === 'boundary-success');
  assert.ok(chat);
  assert.ok(chat.history.some(row => row.role === 'tool' && row.content.includes('boundary read persisted')), JSON.stringify(chat.history));
  assert.equal(chat.history.at(-1).content, 'Read confirmed.');
});

test('provider terminal failure keeps partial text and reports failure through actual CLI', { timeout: 30000 * SLOW }, async () => {
  modelStarted = new Promise(resolve => { notifyModelStarted = resolve; });
  const pending = launch('[provider-error]', 'boundary-failure');
  await awaitModel(pending);
  const run = await pending.done;
  assert.equal(run.code, 1, run.stderr);
  assert.equal(run.result.ok, false);
  assert.match(run.result.assistantFinal, /Partial failure text/);
  assert.ok(run.result.error);
});

test('Stop through the real generations handler cancels upstream and produces exit 130', { timeout: 30000 * SLOW }, async () => {
  modelStarted = new Promise(resolve => { notifyModelStarted = resolve; });
  const run = launch('[hold-generation]', 'boundary-cancel');
  await awaitModel(run);
  const active = await until(async () => (await states()).find(row => row.status === 'streaming' || row.status === 'pending'));
  assert.equal((await api(`/api/generations/${active.id}/cancel`, { method: 'POST' })).status, 200);
  const outcome = await run.done;
  assert.equal(outcome.code, 130, outcome.stderr);
  assert.equal(outcome.result.ok, false);
  assert.match(outcome.result.assistantFinal, /Partial waiting text/);
  await until(async () => !(await states()).some(row => row.status === 'pending' || row.status === 'streaming'));
});

test('real disk-journal completion delivers live and offline, and durable ACK survives host reload', { timeout: 30000 * SLOW }, async () => {
  const liveParent = 'boundary-parent-live';
  const offlineParent = 'boundary-parent-offline';
  const stream = await parentStream(liveParent);
  try {
    await spawnChild(liveParent, 'boundary-child-live');
    const delivered = await stream.wait('deliver', data => data.runIds.includes('boundary-child-live'));
    assert.deepEqual(await acceptDelivery(liveParent, delivered.data), ['boundary-child-live']);
    const journal = await (await api('/api/agents/boundary-child-live/journal')).json();
    assert.equal(journal.events.filter(event => event.type === 'result.delivered').length, 1);
  } finally { await stream.close(); }

  await spawnChild(offlineParent, 'boundary-child-offline');
  await until(async () => {
    const state = await (await api('/api/agents/boundary-child-offline')).json();
    return ['passed', 'failed', 'abandoned', 'cancelled'].includes(state.run?.phase) ? state : false;
  });
  const before = await (await api('/api/agents/boundary-child-offline/journal')).json();
  assert.equal(before.events.filter(event => event.type === 'result.delivered').length, 0);
  const reconnect = await parentStream(offlineParent);
  try {
    const delivered = await reconnect.wait('deliver', data => data.runIds.includes('boundary-child-offline'));
    assert.deepEqual(await acceptDelivery(offlineParent, delivered.data), ['boundary-child-offline']);
  } finally { await reconnect.close(); }

  await stopHost();
  await startHost();
  const persisted = await (await api('/api/config/sessions')).json();
  for (const [parentId, runId] of [[liveParent, 'boundary-child-live'], [offlineParent, 'boundary-child-offline']]) {
    const parent = persisted.chats.find(chat => chat.id === parentId);
    assert.deepEqual(parent.subAgentDeliveryReceipts, [runId]);
    assert.equal(parent.history.filter(row => row.hiddenFromTranscript).length, 1);
    const replay = await parentStream(parentId);
    try {
      const state = await (await api(`/api/agents/${runId}`)).json();
      assert.equal(state.run.delivered, true);
      assert.equal(replay.frames.filter(frame => frame.event === 'deliver').length, 0);
    } finally { await replay.close(); }
  }
});
