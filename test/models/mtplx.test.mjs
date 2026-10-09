import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { isMtplxSupported } from '../../server/models/mtplx-runtime.js';
import { descriptorFromInspect, descriptorFromHealth, getCachedMtplxDescriptor, getMtplxDescriptor, recordMtplxHealthDescriptor } from '../../server/models/mtplx-descriptor.js';
import { buildMtplxServeLaunch, getMtplxLoadDefaults, readMtplxConfig } from '../../server/models/mtplx-args.js';
import { normalizeLaunchSettings, llamaSettingsFromLaunchRow, setLibraryLaunchSettings } from '../../server/models/launch-prefs.js';
import { scanMtplxCache } from '../../server/models/mtplx-cache.js';
import { startMtplxServe, mtplxLastUsedAt } from '../../server/models/mtplx-serve.js';
import { diagnoseMtplxFailure } from '../../server/models/mtplx-memory.js';
import { readMtplxActivity } from '../../server/models/mtplx-activity.js';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { resetServesForTests, listServes, shutdownAllModelServes, stopServe, tickServeHeartbeatForTests } from '../../server/models/serve.js';
import { resolveLibraryAttemptBinding } from '../../server/models/library-binding.js';
import { normalizeModelsResponse } from '../../server/providers/paths.js';
import { isLocalServeProviderId, PROVIDER_ID_BY_ENGINE } from '../../src/models/engine-ids.mjs';

let home, modelPath;
const previousHome = process.env.MINNOW_HOME;
const controls = {
  draft_control: { supported: true, minimum: 1, maximum: 2, default: 2, value_labels: ['D1', 'D2'] },
  context_window: { supported: true, minimum: 4096, maximum: 16384, default: 8192, step: 1024 },
  kv_quant: { supported: true, modes: ['off', 'q8'], restart_required: true },
  reasoning: { supported: true, parser: 'qwen3', modes: ['auto', 'on'], effort_levels: ['low', 'medium'], default_effort: 'medium' },
};
const inspection = () => ({ model_dir: modelPath, compatibility: { can_run: true, mtp_supported: true }, model_controls: controls });
const health = () => ({ ok: true, model_path: modelPath, context_window: 12288, depth: 2, startup: { pid: process.pid, backend: { model_controls: controls } } });

before(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-mtplx-'));
  process.env.MINNOW_HOME = home; resetMinnowHomeCache();
  modelPath = path.join(home, 'model'); await fs.mkdir(modelPath);
  await fs.writeFile(path.join(modelPath, 'config.json'), JSON.stringify({ max_position_embeddings: 32768, quantization: { bits: 4 } }));
});
after(async () => {
  await resetServesForTests();
  if (previousHome === undefined) delete process.env.MINNOW_HOME; else process.env.MINNOW_HOME = previousHome;
  resetMinnowHomeCache(); await fs.rm(home, { recursive: true, force: true });
});

test('MTPLX hardware gate requires macOS 14 and Apple Silicon', () => {
  assert.equal(isMtplxSupported('darwin', 'arm64', '23.0.0'), true);
  for (const args of [['darwin', 'arm64', '22.9'], ['darwin', 'x64', '24'], ['win32', 'arm64', '24']]) assert.equal(isMtplxSupported(...args), false);
  assert.equal(isLocalServeProviderId(PROVIDER_ID_BY_ENGINE.mtplx), true);
});
test('descriptor producers normalize actual MTPLX control keys and runtime-contract bounds', () => {
  const descriptor = descriptorFromInspect(inspection());
  assert.equal(descriptor.canRun, true); assert.equal(descriptor.contextWindow.maximum, 16384);
  assert.deepEqual(descriptor.draft.valueLabels, ['D1', 'D2']);
  assert.deepEqual(descriptor.kvQuant.modes, ['off', 'q8']);
  assert.equal(descriptorFromHealth(health()).source, 'health');
  assert.equal(descriptorFromInspect({ compatibility: { runtime_contract: { mtp_depth_max: 1 } } }).draft.maximum, 1);
});
test('MTPLX 2.12 health controls and profile override older inspect metadata', async () => {
  const captured = JSON.parse(await fs.readFile(new URL('../fixtures/mtplx/health-2.12.json', import.meta.url), 'utf8'));
  const inspect = JSON.parse(await fs.readFile(new URL('../fixtures/mtplx/inspect-2.12.json', import.meta.url), 'utf8'));
  assert.equal(descriptorFromInspect(inspect).mtpSupported, true);
  assert.equal(descriptorFromInspect(inspect).draft.maximum, 6);
  const descriptor = descriptorFromHealth(captured);
  assert.equal(descriptor.mtpSupported, true); assert.equal(descriptor.recommendedProfile, 'turbo');
  assert.equal(descriptor.archId, 'qwen3-next-mtp'); assert.equal(descriptor.supportLevel, 'qa_verified');
  assert.equal(descriptor.draft.maximum, 3); assert.equal(descriptor.contextWindow.maximum, 262144);
  assert.deepEqual(descriptor.kvQuant.modes, ['off', 'q8', 'q4']);
  assert.deepEqual(descriptor.reasoning.effortLevels, ['xhigh', 'medium', 'low']);
  assert.deepEqual(descriptor.sampling, { temperature: 1, top_p: .95, top_k: 20 });
  const launch = buildMtplxServeLaunch({ modelPath, port: 8088, descriptor });
  assert.equal(launch.settings.profile, 'turbo'); assert.equal(launch.settings.reasoning_effort, 'medium');
  for (const flag of [false, 'no', 'false', {}, 1]) assert.equal(descriptorFromInspect({ compatibility: { mtp_supported: flag } }).mtpSupported, false);
  assert.equal(descriptorFromHealth({ profile: { unexpected: true }, startup: { model_controls: [] } }).recommendedProfile, null);
});
test('successful contract verification and unverified warnings do not block crash recovery', () => {
  for (const log of ['Runtime contract verified — profile: sustained', 'WARNING: unverified MTPLX model; startup will continue', 'Model loaded; memory limit: 64GB']) {
    assert.equal(diagnoseMtplxFailure(log, null).code, 'unknown');
  }
  for (const log of ['Runtime contract validation failed', 'MTPLX has not validated this model', 'Missing model file: mtp.safetensors', 'Model architecture is not supported']) {
    assert.equal(diagnoseMtplxFailure(log, 1).code, 'model_incompatible');
  }
  assert.equal(diagnoseMtplxFailure('Metal out of memory', 1).code, 'oom_vram');
  assert.equal(diagnoseMtplxFailure('Address already in use', 1).code, 'port_conflict');
});
test('descriptor support flags reject malformed and negative values', () => {
  const descriptor = descriptorFromHealth({ ok: true, startup: { model_controls: {
    draft_control: { supported: 'no' }, context_window: { supported: 'false' },
    reasoning: { supported: 1, parser: {}, default_mode: [] }, kv_quant: { supported: {} },
    backend_id: {}, support_level: [],
  } } });
  assert.equal(descriptor.mtpSupported, false);
  assert.equal(descriptor.draft.supported, false);
  assert.equal(descriptor.contextWindow.supported, false);
  assert.equal(descriptor.reasoning.supported, false);
  assert.equal(descriptor.kvQuant.supported, false);
  assert.equal(descriptor.reasoning.parser, null);
  assert.equal(descriptor.backendId, null);
});

test('native completion timestamps use epoch seconds and reject malformed activity', () => {
  const now = 1_790_000_000_000;
  assert.equal(mtplxLastUsedAt({ last_request_at: (now - 5000) / 1000 }, now), now - 5000);
  assert.equal(mtplxLastUsedAt({ idle_seconds: 12 }, now), now - 12000);
  assert.equal(mtplxLastUsedAt({ last_request_at: now / 1000 + 2 }, now), now);
  for (const row of [{}, { last_request_at: 0, idle_seconds: null }, { last_request_at: now }, { idle_seconds: -1 }, { idle_seconds: '0' }, { idle_seconds: Infinity }]) assert.equal(mtplxLastUsedAt(row, now), null);
});
test('layering, bounded clamps, warning, argv tokens and fixed transcript flags', () => {
  const result = buildMtplxServeLaunch({ modelPath: '/model with spaces', port: 8088, descriptor: descriptorFromInspect(inspection()),
    defaults: { depth: 1, context_window: 4096 }, saved: { depth: 6 }, settings: { context_window: 10000, paged_kv_quantization: 'q4', extra_args: '--max-tokens=99' } });
  assert.equal(result.settings.depth, 2); assert.equal(result.settings.context_window, 10240);
  assert.equal(result.settings.paged_kv_quantization, 'off'); assert.match(result.warning, /clamped/);
  assert.ok(result.args.includes('/model with spaces')); assert.ok(result.args.includes('--no-stats-footer'));
  assert.deepEqual(result.args.slice(-4), ['--agent-rewrites', 'off', '--yes', '--no-auth']);
  assert.equal(result.args.filter((a) => a.startsWith('--max-tokens')).length, 1);
  for (const extra_args of ['--agent-rewrites on', '--agent-rew=on', '--stats-footer', '--model other', '--port=9000', '--no-auth', '--api-key secret', '--']) {
    assert.throws(() => buildMtplxServeLaunch({ modelPath, port: 8088, settings: { extra_args } }), /cannot override/);
  }
  const lan = buildMtplxServeLaunch({ modelPath, port: 8088, settings: { extra_args: '--host 0.0.0.0' } });
  assert.ok(lan.apiKeyFile.endsWith('api-key')); assert.ok(!lan.args.includes('--no-auth'));
  const repeatedHost = buildMtplxServeLaunch({ modelPath, port: 8088, settings: { extra_args: '--host localhost --host 0.0.0.0' } });
  assert.ok(repeatedHost.apiKeyFile); assert.ok(!repeatedHost.args.includes('--no-auth'));
  assert.throws(() => buildMtplxServeLaunch({ modelPath, port: 8088, settings: { extra_args: '--ho 0.0.0.0' } }), /full --host/);
});
test('engine preferences stay namespaced, preserve progress and never become llama flags', () => {
  const normalized = normalizeLaunchSettings({ engine: 'mtplx', mtplx: { depth: 6, reasoning: 'invalid', env: { OK: 'yes', BAD: 3 } }, ctx: 8192, lastLoadMs: 100 }, { descriptor: descriptorFromInspect(inspection()) });
  assert.equal(normalized.engine, 'mtplx'); assert.equal(normalized.mtplx.depth, 2);
  assert.deepEqual(normalized.mtplx.env, { OK: 'yes' }); assert.equal(normalized.lastLoadMs, 100);
  assert.deepEqual(llamaSettingsFromLaunchRow(normalized), { ctx: 8192 });
});
test('load defaults match descriptor and configured launch defaults without pinning engine policies', async () => {
  const captured = JSON.parse(await fs.readFile(new URL('../fixtures/mtplx/health-2.12.json', import.meta.url), 'utf8'));
  const descriptor = descriptorFromHealth(captured);
  const values = getMtplxLoadDefaults(descriptor);
  assert.equal(values.profile, 'turbo'); assert.equal(values.depth, 3);
  assert.equal(values.context_window, 262144); assert.equal(values.reasoning, 'auto');
  assert.equal(values.reasoning_effort, 'medium'); assert.equal(values.reasoning_parser, 'qwen3');
  assert.equal(values.paged_kv_quantization, 'off'); assert.equal(values.scheduler_mode, 'serial');
  assert.equal(values.default_temperature, 1); assert.equal(values.default_top_p, .95);
  assert.equal(values.default_top_k, 20); assert.equal(values.default_presence_penalty, 0);
  assert.match(values.generation_mode, /Model recommendation/);
  assert.match(values.preserve_thinking, /model history policy/);
  assert.equal(values.enable_thermal_poll, false);
  const configFile = path.join(home, 'mtplx.json');
  try {
    await fs.writeFile(configFile, JSON.stringify({ defaults: { profile: 'sustained', depth: 1,
      context_window: 10000, paged_kv_quantization: 'q8', default_temperature: 0, enable_thermal_poll: true } }));
    const defaults = await readMtplxConfig();
    const configured = getMtplxLoadDefaults(descriptor, defaults);
    const launch = buildMtplxServeLaunch({ modelPath, port: 8088, descriptor, defaults });
    for (const [key, value] of Object.entries(launch.settings)) assert.deepEqual(configured[key], value);
    assert.equal(configured.profile, 'sustained'); assert.equal(configured.default_temperature, 0);
    assert.equal(configured.context_window, 10240); assert.equal(configured.enable_thermal_poll, true);
    assert.match(configured.draft_temperature, /^0 /);
    assert.equal(launch.settings.scheduler_mode, undefined);
    assert.equal(launch.settings.generation_mode, undefined);
    assert.match(getMtplxLoadDefaults(descriptor, { extra_args: '--paged-kv-quantization q4' }).paged_kv_quantization, /extra arguments/);
  } finally { await fs.rm(configFile, { force: true }); }
});
test('discovery trusts CLI validation, keeps incomplete rows and deduplicates repo ids', async () => {
  const seen = new Set();
  const rows = await scanMtplxCache(seen, { run: async () => ({ models: [
    { repo_id: 'Org/Good', path: modelPath, has_runtime_contract: true, validation: { ok: true }, size_bytes: 123 },
    { repo_id: 'Org/Bad', path: modelPath, has_runtime_contract: true, validation: { ok: false, missing_files: ['mtp.safetensors'] } },
  ] }) });
  assert.equal(rows[0].mtplx_validated, true); assert.equal(rows[0].mlx_quant, 'mlx-4bit');
  assert.equal(rows[1].has_incomplete, true); assert.match(rows[1].mtplx_reason, /mtp.safetensors/);
  assert.equal(seen.has('Org/Good'), true);
  assert.equal(rows[0].mtplx_vision, undefined);
  const vlmPath = path.join(home, 'vlm'); await fs.mkdir(vlmPath, { recursive: true });
  await fs.writeFile(path.join(vlmPath, 'config.json'), JSON.stringify({ vision_config: { depth: 27 }, quantization: { bits: 4 } }));
  const [vlm] = await scanMtplxCache(new Set(), { run: async () => ({ models: [{ repo_id: 'Org/Vlm', path: vlmPath, has_runtime_contract: true, validation: { ok: true } }] }) });
  assert.equal(vlm.mtplx_vision, true);
  assert.deepEqual(await scanMtplxCache(seen, { run: async () => ({ models: [{ repo_id: 'Org/Good', path: modelPath }] }) }), []);
});
test('descriptor cache persists health precedence and invalidates after model changes', async () => {
  let calls = 0;
  const inspect = async () => { calls++; return inspection(); };
  await getMtplxDescriptor(modelPath, { inspect });
  await recordMtplxHealthDescriptor(modelPath, health());
  assert.equal((await getMtplxDescriptor(modelPath, { inspect })).source, 'health'); assert.equal(calls, 1);
  await fs.writeFile(path.join(modelPath, 'mtplx_runtime.json'), '{"changed":true}');
  assert.equal((await getMtplxDescriptor(modelPath, { inspect })).source, 'inspect'); assert.equal(calls, 2);
});
test('upgrading an old health cache refreshes inspect and health without manual deletion', async () => {
  const file = path.join(home, 'models', 'mtplx-descriptors.json');
  const cache = JSON.parse(await fs.readFile(file, 'utf8'));
  delete cache[modelPath].version; cache[modelPath].descriptor = { source: 'health', mtpSupported: false };
  await fs.writeFile(file, JSON.stringify(cache));
  assert.equal(await getCachedMtplxDescriptor(modelPath), null);
  let calls = 0;
  const inspect = async () => { calls++; return inspection(); };
  const [first, second] = await Promise.all([getMtplxDescriptor(modelPath, { inspect }), getMtplxDescriptor(modelPath, { inspect })]);
  assert.equal(calls, 1); assert.equal(first.source, 'inspect'); assert.deepEqual(first, second);
  await recordMtplxHealthDescriptor(modelPath, health());
  assert.equal((await getCachedMtplxDescriptor(modelPath)).mtpSupported, true);
  assert.equal((await getMtplxDescriptor(modelPath, { inspect })).source, 'health');
});

function dependencies(overrides = {}) {
  return { rows: [], status: async () => ({ installed: true, supported: true, path: '/mtplx/bin/mtplx' }),
    descriptor: async () => descriptorFromInspect(inspection()), findPort: async (port) => port + 1,
    admit: async () => {}, commit: async () => {}, upsert: async () => {},
    probe: async () => null, createRun: async () => ({ runId: 'fake-run', pid: 101 }),
    stopRun: async () => {}, getRun: () => null, readLogTail: async () => '', models: async () => ({ data: [{ id: 'actual-api-id' }] }),
    ...overrides };
}
test('same-model daemon is adopted without spawning or applying launch preferences', async () => {
  const row = await startMtplxServe({ modelPath, port: 8000, mtplx: { depth: 1 } }, dependencies({
    probe: async () => health(), createRun: async () => assert.fail('must not spawn'), admit: async () => assert.fail('must not evict for adoption'),
  }));
  assert.equal(row.status, 'running'); assert.equal(row.ownership, 'external');
  assert.equal(row.mtplxSettings.depth, 2); assert.equal(row.mtplxSettings.context_window, 12288);
  assert.equal(row.modelLabel, 'actual-api-id'); assert.equal(row.runId, undefined);
});
test('different-model daemon is left alone; owned process uses a free port', async () => {
  let spawned = false, admitted = false, stopped = false;
  const row = await startMtplxServe({ modelPath, port: 8000, weightsGb: 2 }, dependencies({
    probe: async () => spawned ? health() : { ...health(), model_path: home },
    createRun: async (spec) => { spawned = true; assert.ok(spec.args.includes('--no-stats-footer')); return { runId: 'fake-run', pid: 101 }; },
    admit: async (plan) => { admitted = true; assert.ok(plan.estimateGb > 2); },
    wait: async () => ({ ok: true }), stopRun: async () => { stopped = true; },
  }));
  assert.equal(row.ownership, 'minnow'); assert.equal(row.port, 8001); assert.equal(row.status, 'running');
  assert.equal(admitted, true); assert.equal(stopped, false);
});
test('health failure stops only the owned process and preserves diagnostics', async () => {
  let stopped;
  const row = await startMtplxServe({ modelPath, port: 8000 }, dependencies({
    wait: async () => ({ ok: false, error: 'failed', logTail: 'Metal out of memory' }), stopRun: async (id) => { stopped = id; },
  }));
  assert.equal(row.status, 'error'); assert.equal(row.failure.code, 'oom_vram'); assert.equal(stopped, 'fake-run');
});
test('MTPLX telemetry keeps native metrics without fabricating slots', async () => {
  const activity = await readMtplxActivity({ id: 'serve', baseUrl: 'http://localhost:8000' }, async (url) => ({ ok: true, json: async () => url.endsWith('/health') ? { active_requests: 2, scheduler: { queued: 1 } } : { latest: { decode_tok_s: 44, mtp_depth: 2 } } }));
  assert.equal(activity.mtplx.activeRequests, 2); assert.equal(activity.queued, 1); assert.equal(activity.mtplx.latest.decode_tok_s, 44);
  assert.deepEqual(activity.slots, []);
});
test('library auto-load respects saved engine and remaps actual serve runtime', async () => {
  await setLibraryLaunchSettings('mtplx:Org/Good', { engine: 'mlx-lm' });
  const result = await resolveLibraryAttemptBinding({ providerId: 'minnow-library', id: 'mtplx:Org/Good' }, {
    findLiveLlamaCppServe: async () => null, findLiveMlxServe: async () => null, listServes: async () => [],
    listCachedModels: async () => ({ models: [{ repo_id: 'Org/Good', mtplx_root: modelPath, mtplx_validated: true }] }),
    startServe: async (body) => { assert.equal(body.runtime, 'mlx-lm'); return { ...body, status: 'running' }; },
  });
  assert.deepEqual(result, { providerId: 'mlx-lm-local', id: modelPath });
});
test('rich MTPLX model metadata survives OpenAI normalization', () => {
  const models = normalizeModelsResponse('openai-v1', { data: [{ id: 'model', owned_by: 'mtplx', supports_vision: true, context_length: 262144 }] });
  assert.ok(JSON.stringify(models).includes('262144')); assert.ok(JSON.stringify(models).includes('mtplx'));
});
test('idle eviction, eject and app shutdown never terminate an adopted daemon', async () => {
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(req.url === '/health' ? health() : { latest: {} })); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const id = '11111111-1111-4111-8111-111111111111';
  try {
    await resetServesForTests(); await fs.mkdir(path.join(home, 'models'), { recursive: true });
    await fs.writeFile(path.join(home, 'models', 'serves.json'), JSON.stringify({ serves: [{ id, runtime: 'mtplx', ownership: 'external', status: 'running', modelPath,
      baseUrl: `http://127.0.0.1:${port}`, port, startedAt: 1, pid: process.pid, runId: 'external-sentinel', mtplxSettings: { idle_ttl_ms: 1 } }] }));
    assert.equal((await listServes())[0].status, 'running');
    await tickServeHeartbeatForTests(); assert.equal((await listServes())[0].status, 'running');
    await shutdownAllModelServes(); assert.equal((await listServes())[0].status, 'stopped');
    await stopServe(id); assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).ok, true);
  } finally { await resetServesForTests(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});

test('idle eviction preserves an owned daemon with native requests in flight', async () => {
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(req.url === '/health' ? { ...health(), active_requests: 1 } : { latest: {} })); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    await resetServesForTests();
    await fs.writeFile(path.join(home, 'models', 'serves.json'), JSON.stringify({ serves: [{ id: '22222222-2222-4222-8222-222222222222', runtime: 'mtplx', ownership: 'minnow', status: 'running', modelPath,
      baseUrl: `http://127.0.0.1:${port}`, port, startedAt: 1, pid: process.pid, mtplxSettings: { idle_ttl_ms: 1 } }] }));
    await tickServeHeartbeatForTests();
    assert.equal((await listServes())[0].status, 'running');
  } finally { await resetServesForTests(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});

test('boot reconciliation upgrades a persisted running descriptor from native health', async () => {
  const captured = JSON.parse(await fs.readFile(new URL('../fixtures/mtplx/health-2.12.json', import.meta.url), 'utf8'));
  const native = { ...captured, model_path: modelPath, startup: { ...captured.startup, pid: process.pid } };
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(native)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    await resetServesForTests();
    await fs.writeFile(path.join(home, 'models', 'serves.json'), JSON.stringify({ serves: [{ id: '44444444-4444-4444-8444-444444444444', runtime: 'mtplx', ownership: 'external', status: 'running', modelPath,
      baseUrl: `http://127.0.0.1:${port}`, port, startedAt: 1, pid: process.pid,
      mtplxDescriptor: { source: 'health', mtpSupported: false }, mtplxSettings: { profile: { name: 'turbo' } } }] }));
    const [row] = await listServes();
    assert.equal(row.mtplxDescriptor.mtpSupported, true); assert.equal(row.mtplxDescriptor.draft.maximum, 3);
    assert.equal(row.mtplxSettings.profile, 'turbo'); assert.equal(row.mtplxDescriptor.reasoning.parser, 'qwen3');
    assert.equal((await getCachedMtplxDescriptor(modelPath)).source, 'health');
  } finally { await resetServesForTests(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('recent completed native requests defer TTL but unchanged old activity eventually evicts', async () => {
  let lastRequest = Date.now() / 1000;
  let nativeAvailable = true;
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (!nativeAvailable) { res.writeHead(503); res.end('{}'); return; }
    res.end(JSON.stringify({ ...health(), active_requests: 0, last_request_at: lastRequest }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const id = '33333333-3333-4333-8333-333333333333';
  const file = path.join(home, 'models', 'serves.json');
  const seed = async () => {
    await resetServesForTests();
    await fs.writeFile(file, JSON.stringify({ serves: [{ id, runtime: 'mtplx', ownership: 'minnow', status: 'running', modelPath,
      baseUrl: `http://127.0.0.1:${port}`, port, startedAt: 1, lastUsedAt: 1, pid: process.pid, mtplxSettings: { idle_ttl_ms: 60000 } }] }));
  };
  try {
    await seed(); await tickServeHeartbeatForTests();
    assert.equal((await listServes())[0].status, 'running');
    await seed(); await listServes(); nativeAvailable = false; await tickServeHeartbeatForTests();
    assert.equal((await listServes())[0].status, 'running');
    nativeAvailable = true; lastRequest = (Date.now() - 120000) / 1000;
    await seed(); await tickServeHeartbeatForTests();
    assert.equal((await listServes())[0].status, 'stopped');
  } finally { await resetServesForTests(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});
