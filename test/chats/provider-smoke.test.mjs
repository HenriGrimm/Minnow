import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { validateSmokeTargets, discoverSmokeConfiguration, runSmokeCase } from '../../scripts/verify-agent-conversations.mjs';

const exec = promisify(execFile);
const script = path.resolve('scripts/verify-agent-conversations.mjs');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-smoke-test-'));
  t.after(async () => {
    const absolute = path.resolve(root), temporary = path.resolve(os.tmpdir());
    assert.equal(path.dirname(absolute).toLowerCase(), temporary.toLowerCase()); assert.ok(path.basename(absolute).startsWith('minnow-smoke-test-'));
    await fs.rm(absolute, { recursive: true, force: true });
  });
  const provider = path.join(root, 'providers', 'fixture'); await fs.mkdir(provider, { recursive: true });
  return { root, provider };
}

test('smoke target contract bounds cases, exact pairs/options and explicitly declared pool membership', () => {
  const target = { kind: 'cli', selection: { providerId: 'codex-cli', modelId: 'fixture', options: { reasoningEffort: 'low' } } };
  assert.deepEqual(validateSmokeTargets({ version: 1, targets: [target] }), [target]);
  for (const targets of [[target, target], [{ kind: 'api', selection: { modelId: 'partial' } }],
    [{ kind: 'pool', selection: { providerId: 'minnow-router', modelId: 'pool' }, pool: { members: Array(5).fill(target.selection) } }]]) {
    assert.throws(() => validateSmokeTargets({ version: 1, targets }), /invalid/);
  }
});

test('default discovery is read-only, emits explicit not-run SKIPs and never prints credential or unrelated settings', async t => {
  const f = await fixture(t), sentinel = 'CREDENTIAL_MUST_NEVER_APPEAR';
  await fs.writeFile(path.join(f.provider, 'profile.json'), JSON.stringify({ id: 'fixture', apiKind: 'openai-v1', enabled: true, customHeaders: { secret: sentinel } }));
  await fs.writeFile(path.join(f.provider, 'secrets.json'), JSON.stringify({ apiKey: sentinel }));
  await fs.writeFile(path.join(f.root, 'config.json'), JSON.stringify({ integrations: { secret: sentinel } }));
  const targets = path.join(f.root, 'targets.json'); await fs.writeFile(targets, JSON.stringify({ version: 1, targets: [{ kind: 'api', selection: { providerId: 'fixture', modelId: 'fixture' } }] }));
  const before = await fs.readFile(path.join(f.provider, 'secrets.json'), 'utf8');
  const { stdout, stderr } = await exec(process.execPath, [script, '--source-home', f.root, '--targets-file', targets]);
  const report = JSON.parse(stdout); assert.equal(report.inference, false); assert.equal(report.paths[0].status, 'SKIP'); assert.equal(report.paths[0].code, 'not_run');
  assert.equal(report.paths.filter(row => row.status === 'PASS').length, 0); assert.equal(stdout.includes(sentinel), false); assert.equal(stderr.includes(sentinel), false);
  assert.equal(await fs.readFile(path.join(f.provider, 'secrets.json'), 'utf8'), before);
  await assert.rejects(fs.access(path.join(f.root, '.key'))); assert.equal((await discoverSmokeConfiguration(f.root)).providers.length, 1);
});

test('isolated worker uses real production preparation, command ownership, native chat tool dispatch and generation binding against a fixture upstream', async t => {
  const f = await fixture(t), calls = [], credentials = [];
  const upstream = http.createServer(async (request, response) => {
    credentials.push(request.headers.authorization);
    if (request.method === 'GET') { response.end(JSON.stringify({ data: ['fixture', 'fixture-alt'].map(id => ({ id, capabilities: { tools: true },
      reasoning: { allowed_options: ['off', 'low', 'high'], default: 'high' } })) })); return; }
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw); calls.push(body);
    const toolRound = !body.messages.some(message => message.role === 'tool');
    const marker = JSON.stringify(body.messages).match(/MINNOW_SMOKE_[a-f0-9]+/)?.[0];
    const delta = toolRound ? { tool_calls: [{ index: 0, id: 'read-capabilities', type: 'function', function: { name: 'agent_capabilities', arguments: '{"limit":1}' } }] } : { content: marker };
    response.setHeader('Content-Type', 'text/event-stream'); response.end('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\ndata: ' +
      JSON.stringify({ choices: [{ delta: {}, finish_reason: toolRound ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 4 } }) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise((resolve, reject) => { upstream.once('error', reject); upstream.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); });
  const secret = 'SELECTED_SECRET_DO_NOT_PRINT';
  await fs.writeFile(path.join(f.provider, 'profile.json'), JSON.stringify({ id: 'fixture', label: 'Fixture', apiKind: 'openai-v1', enabled: true,
    authStyle: 'bearer', baseUrl: 'http://127.0.0.1:' + upstream.address().port, modelsPath: '/v1/models', chatCompletionsPath: '/v1/chat/completions' }));
  const sourceHomeBefore = process.env.MINNOW_HOME;
  const homes = await import('../../server/config/home.js'), boxes = await import('../../server/security/secret-box.js');
  process.env.MINNOW_HOME = f.root; homes.resetMinnowHomeCache(); boxes.resetSecretBoxCacheForTests();
  try { await boxes.writeEncryptedJsonFile(path.join(f.provider, 'secrets.json'), { apiKey: secret }); }
  finally {
    if (sourceHomeBefore === undefined) delete process.env.MINNOW_HOME; else process.env.MINNOW_HOME = sourceHomeBefore;
    homes.resetMinnowHomeCache(); boxes.resetSecretBoxCacheForTests();
  }
  const keyBefore = await fs.readFile(path.join(f.root, '.key'));
  const before = await fs.readFile(path.join(f.provider, 'secrets.json'), 'utf8');
  const report = await runSmokeCase({ sourceHome: f.root, target: { kind: 'api', selection: { providerId: 'fixture', modelId: 'fixture', options: {} } }, timeoutMs: 20000 });
  assert.equal(report.status, 'PASS', JSON.stringify({ report, calls: calls.map(body => ({ model: body.model, roles: body.messages.map(message => message.role) })) })); assert.equal(report.code, 'production_tool_round');
  assert.deepEqual(report.capturedSelection, { providerId: 'fixture', modelId: 'fixture', options: {} });
  assert.equal(report.resolvedSelection.modelId, 'fixture'); assert.equal(calls.length, 2);
  assert.ok(calls.every(body => body.max_tokens === 512), 'the smoke request clamps the actual runner sampler output budget');
  assert.deepEqual(calls[0].tools.map(tool => tool.function.name), ['agent_capabilities']);
  assert.ok(calls.every(body => body.reasoning_effort !== 'high'), 'the clear selection does not resurrect the catalog default over the captured thinking-off settings');
  assert.ok(credentials.some(value => value === 'Bearer ' + secret)); assert.equal(JSON.stringify(report).includes(secret), false);
  assert.equal(await fs.readFile(path.join(f.provider, 'secrets.json'), 'utf8'), before);
  assert.equal(Buffer.compare(await fs.readFile(path.join(f.root, '.key')), keyBefore), 0, 'source encryption key is read without modification');
  const pool = await runSmokeCase({ sourceHome: f.root, timeoutMs: 20000, target: { kind: 'pool',
    selection: { providerId: 'minnow-router', modelId: 'smoke-pool', options: { reasoningEffort: 'low' } },
    pool: { members: [{ providerId: 'fixture', modelId: 'fixture' }, { providerId: 'fixture', modelId: 'fixture-alt' }] } } });
  assert.equal(pool.status, 'PASS', JSON.stringify(pool)); assert.equal(pool.capturedSelection.providerId, 'minnow-router');
  assert.equal(pool.pool.revision, 1); assert.deepEqual(pool.pool.eligibleEntryIds, ['entry-0', 'entry-1']);
  assert.equal(pool.resolvedSelection.providerId, 'fixture'); assert.equal(calls.length, 4);
  assert.ok(calls.slice(2).every(body => body.max_tokens === 512));
  assert.ok(calls.slice(2).every(body => body.reasoning_effort === 'low'), 'explicit pool effort takes precedence over catalog high');
});

test('a disabled local path is explicitly skipped before any provider request', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.provider, 'profile.json'), JSON.stringify({ id: 'fixture', apiKind: 'openai-v1', enabled: false, baseUrl: 'http://127.0.0.1:1' }));
  const result = await runSmokeCase({ sourceHome: f.root, target: { kind: 'local', selection: { providerId: 'fixture', modelId: 'fixture' } }, timeoutMs: 1000 });
  assert.equal(result.status, 'SKIP'); assert.equal(result.code, 'provider_unavailable');
});

test('a provider catalog that never answers cannot outlive the owned worker deadline', { timeout: 30000 }, async t => {
  const f = await fixture(t), upstream = http.createServer(() => {});
  await new Promise((resolve, reject) => { upstream.once('error', reject); upstream.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); });
  await fs.writeFile(path.join(f.provider, 'profile.json'), JSON.stringify({ id: 'fixture', label: 'Unresponsive fixture', apiKind: 'openai-v1', enabled: true,
    authStyle: 'bearer', baseUrl: 'http://127.0.0.1:' + upstream.address().port, modelsPath: '/v1/models', chatCompletionsPath: '/v1/chat/completions' }));
  const started = Date.now();
  const result = await runSmokeCase({ sourceHome: f.root, target: { kind: 'api', selection: { providerId: 'fixture', modelId: 'fixture' } }, timeoutMs: 1000 });
  assert.ok(result.status === 'FAIL' && result.code === 'worker_timeout_or_exit' || result.status === 'SKIP' && result.code === 'model_unavailable', JSON.stringify(result));
  assert.ok(Date.now() - started < 25000, 'owned process exits and scratch cleanup finishes within its startup/kill allowance');
});
