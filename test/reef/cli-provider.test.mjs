import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'reef-cli-provider-')));
process.env.MINNOW_HOME = home;
const { createReefMiddleware } = await import('../../server/reef/middleware.js');
const { reefSupervisor } = await import('../../server/reef/supervisor.js');
const { setAgentCliProviderEnabled } = await import('../../server/providers/store.js');
const { writeConfigJson } = await import('../../server/config/store.js');
const { getSessionToken } = await import('../../server/runtime/session-token.js');
const { toolchainPaths } = await import('../../server/reef/toolchain.js');
const { listApps, readApp } = await import('../../server/reef/store.js');
const { REEF_TOOLS, reefToolAllowed } = await import('../../server/reef/tool-policy.js');
const { buildAgentCliToolCatalog, createAgentCliBridge } = await import('../../server/generations/agent-cli/bridge.js');

let server, base;
let catalog = { data: [{ id: 'fixture-model' }] };
const probes = [];
before(async () => {
  await writeConfigJson('tools.json', {
    enabled: Object.fromEntries([...REEF_TOOLS].map(name => [name, true])),
    permissions: { default: Object.fromEntries([...REEF_TOOLS].map(name => [name, 'full'])) },
  });
  // Admission checks only need a cached toolchain; these files are never executed.
  const tools = toolchainPaths();
  for (const file of [tools.node, tools.npm]) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'test fixture');
  }
  const middleware = createReefMiddleware();
  server = http.createServer((req, res) => {
    if (req.url.startsWith('/api/providers/')) {
      assert.equal(req.headers['x-minnow-token'], getSessionToken());
      probes.push(req.url);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(catalog));
      return;
    }
    void middleware(req, res, () => { res.writeHead(404); res.end(); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  reefSupervisor.baseUrl = base;
  // Keep admitted runs queued; admission must not start inference or installations.
  assert.equal(reefSupervisor.stopped, true);
});
after(async () => {
  server?.closeAllConnections();
  if (server) await new Promise(resolve => server.close(resolve));
  reefSupervisor.baseUrl = '';
  await fs.rm(home, { recursive: true, force: true });
});
const post = (route, body) => fetch(`${base}/api/reef/${route}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

for (const kind of ['claude', 'codex', 'cursor']) {
  test(`${kind} CLI model passes Reef creation and revision preflight`, async () => {
    const provider = await setAgentCliProviderEnabled(kind, true);
    const response = await post('apps', { prompt: 'A local counter', providerId: provider.id, modelId: 'fixture-model' });
    const app = await response.json();
    assert.equal(response.status, 201, JSON.stringify(app));
    assert.equal(app.providerId, provider.id);
    assert.equal(app.modelId, 'fixture-model');
    assert.equal(app.runs[0].state, 'queued');
    await reefSupervisor.cancel(app.id, app.runs[0].id);
    const revision = await post(`apps/${app.id}/runs`, { prompt: 'Add a reset button' });
    assert.equal(revision.status, 202);
    assert.equal((await revision.json()).state, 'queued');
    assert.equal(probes.filter(url => url === `/api/providers/${provider.id}/models`).length, 2);
  });
}

test('runs API resumes the same stopped run and resets only through explicit actions', async () => {
  const provider = await setAgentCliProviderEnabled('codex', true);
  const response = await post('apps', { prompt: 'Recover a timer', providerId: provider.id, modelId: 'fixture-model' });
  const app = await response.json();
  const runId = app.runs[0].id;
  await reefSupervisor.cancel(app.id, runId);
  const resumed = await post(`apps/${app.id}/runs`, {});
  assert.equal(resumed.status, 202);
  assert.equal((await resumed.json()).id, runId);
  assert.equal((await readApp(app.id)).runs.length, 1);
  assert.equal((await post(`apps/${app.id}/runs`, { action: 'resume', runId })).status, 409);
  await reefSupervisor.cancel(app.id, runId);
  const phaseReset = await post(`apps/${app.id}/runs`, { action: 'reset-phase', runId });
  assert.equal(phaseReset.status, 202);
  assert.equal((await phaseReset.json()).recovery, 'reset-phase');
  await reefSupervisor.cancel(app.id, runId);
  const wholeReset = await post(`apps/${app.id}/runs`, { action: 'reset-build', runId });
  assert.equal(wholeReset.status, 202);
  const fresh = await wholeReset.json();
  assert.notEqual(fresh.id, runId);
  assert.equal(fresh.prompt, 'Recover a timer');
  assert.equal((await readApp(app.id)).runs.length, 2);
  await reefSupervisor.cancel(app.id, fresh.id);
  assert.equal((await post(`apps/${app.id}/runs`, { action: 'reset-build', runId })).status, 409);
  assert.equal((await post(`apps/${app.id}/runs`, { action: 'unknown', runId: fresh.id })).status, 400);
});

test('CLI admission retains provider, catalog and source-tool availability checks', async () => {
  const provider = await setAgentCliProviderEnabled('codex', false);
  const input = { prompt: 'A local counter', providerId: provider.id, modelId: 'fixture-model' };
  const beforeCount = (await listApps()).length;
  let response = await post('apps', input);
  assert.match((await response.json()).error, /provider is unavailable/);
  assert.equal(response.status, 400);
  await setAgentCliProviderEnabled('codex', true);
  try {
    catalog = { data: [], unreachable: true, error: 'CLI is not signed in' };
    response = await post('apps', input);
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /not signed in/);
    catalog = { data: [] };
    response = await post('apps', input);
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /selected model is unavailable/);
    catalog = { data: [{ id: 'fixture-model' }] };
    await writeConfigJson('tools.json', { enabled: { save_file: false } });
    response = await post('apps', input);
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /Enable save_file/);
    assert.equal((await listApps()).length, beforeCount);
  } finally {
    await writeConfigJson('tools.json', {});
    catalog = { data: [{ id: 'fixture-model' }] };
  }
});

for (const phase of ['plan', 'build', 'chat']) {
  test(`CLI bridge preserves Reef ${phase} source-tool restrictions and hands results back`, async t => {
    const names = [...REEF_TOOLS].filter(name => reefToolAllowed(name, phase));
    const tools = buildAgentCliToolCatalog({ tools: names.map(name => ({ type: 'function', function: {
      name, parameters: { type: 'object', properties: { path: { type: 'string' } } },
    } })) });
    const tempDir = await fs.mkdtemp(path.join(home, 'bridge-'));
    const calls = [];
    const bridge = await createAgentCliBridge({ tools, tempDir, onCall: call => {
      calls.push(call);
      bridge.resolveCall(call.id, 'source result');
    } });
    t.after(() => bridge.close());
    const request = name => fetch(bridge.config.env.MINNOW_CLI_BRIDGE_URL, {
      method: 'POST', headers: { authorization: `Bearer ${bridge.config.env.MINNOW_CLI_BRIDGE_TOKEN}` },
      body: JSON.stringify({ name, arguments: { path: 'src/main.ts' } }),
    });
    for (const name of ['execute_command', 'git_push', 'ask_question', 'mcp__mail__send', ...(phase === 'build' ? [] : ['save_file'])]) {
      assert.equal((await request(name)).status, 400, name);
    }
    const name = phase === 'build' ? 'save_file' : 'read_file';
    const response = await request(name);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { content: [{ type: 'text', text: 'source result' }] });
    assert.deepEqual(calls.map(call => call.function.name), [name]);
  });
}
