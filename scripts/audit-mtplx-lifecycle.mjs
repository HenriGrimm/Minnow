#!/usr/bin/env node
/** Opt-in real MTPLX lifecycle checks. Requires an isolated running Minnow host and installed weights. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  'base-url': { type: 'string' }, home: { type: 'string' }, 'library-id': { type: 'string' },
  port: { type: 'string', default: '19488' }, output: { type: 'string' }, help: { type: 'boolean' },
} });
if (values.help) {
  console.log('node scripts/audit-mtplx-lifecycle.mjs --base-url http://127.0.0.1:19473 --home /tmp/minnow-audit-home --library-id mtplx:Publisher/Model --port 19488 --output /tmp/mtplx-lifecycle.json');
  process.exit(0);
}
assert.ok(values['base-url'] && values.home && values['library-id']?.startsWith('mtplx:'), 'Supply --base-url, a scratch --home and an installed --library-id');
const origin = new URL(values['base-url']);
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname), 'Only a loopback audit host is allowed');
const home = await fs.realpath(values.home);
assert.notEqual(home, await fs.realpath(path.join(os.homedir(), '.minnow')).catch(() => path.join(os.homedir(), '.minnow')), 'Use a scratch home, never the live profile');
const port = Number(values.port);
assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535, 'Invalid port');
const libraryId = values['library-id'];
const token = (await fs.readFile(path.join(home, 'session-token'), 'utf8')).trim();
const evidence = { libraryId, port, checks: {} };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function api(route, body) {
  const response = await fetch(new URL(route, origin), { method: body ? 'POST' : 'GET',
    headers: { 'X-Minnow-Token': token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(180_000) });
  const result = await response.json();
  assert.ok(response.ok, result.error || `HTTP ${response.status}`);
  return result;
}
async function until(probe, timeout = 90_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await probe(); if (result) return result; await sleep(1000); }
  throw new Error('Timed out waiting for the audit state');
}
const live = (row) => ['starting', 'running', 'unhealthy'].includes(row.status);
const initial = (await api('/api/models/serve')).serves;
assert.ok(!initial.some((row) => live(row) && (row.libraryId === libraryId || row.port === port)), 'Audit model and port must be unused by this host');
const target = (await api('/api/models/cached')).models.find((row) => `mtplx:${row.repo_id}` === libraryId);
assert.ok(target?.mtplx_validated, 'A complete validated MTPLX model is required');
const settings = { profile: 'sustained', generation_mode: 'ar', depth: 2, context_window: 8192,
  paged_kv_quantization: 'q4', reasoning: 'off', warmup_tokens: 0, idle_ttl_ms: 0 };
let launched = false;
async function start(idleTtlMs) {
  const { serve } = await api('/api/models/serve', { runtime: 'mtplx', modelPath: target.path,
    libraryId, port, weightsGb: target.size_bytes / 1024 ** 3, async: true,
    mtplx: { ...settings, idle_ttl_ms: idleTtlMs } });
  assert.equal(serve.ownership, 'minnow', 'Audit refuses to signal an external daemon');
  launched = true;
  return until(async () => {
    const row = (await api(`/api/models/serve/${serve.id}`)).serve;
    if (['error', 'crashed', 'stopped'].includes(row.status)) throw new Error(row.error || row.status);
    return row.status === 'running' ? row : null;
  });
}
async function complete(row) {
  // Only the just-created, owned loopback process receives the direct request.
  assert.equal(row.ownership, 'minnow'); assert.equal(row.port, port);
  const response = await fetch(`${row.baseUrl}/v1/chat/completions`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(90_000),
    body: JSON.stringify({ model: row.modelLabel, stream: false, max_tokens: 32,
      chat_template_kwargs: { enable_thinking: false }, messages: [{ role: 'user', content: 'Reply exactly MTPLX_AUDIT_OK' }] }) });
  assert.equal(response.status, 200);
  assert.match((await response.json()).choices[0].message.content, /MTPLX_AUDIT_OK/);
}
try {
  let row = await start(0);
  await complete(row);
  console.log('Healthy owned daemon; checking restart after 35 seconds');
  await sleep(35_000);
  const before = (await api(`/api/models/serve/${row.id}`)).serve;
  assert.equal(before.status, 'running'); assert.equal(before.ownership, 'minnow'); assert.equal(before.pid, row.pid);
  const health = await fetch(`${before.baseUrl}/health`).then((response) => response.json());
  assert.equal(await fs.realpath(health.model_path), await fs.realpath(before.modelPath));
  process.kill(before.pid, 'SIGKILL');
  row = await until(async () => (await api('/api/models/serve')).serves.find((next) =>
    next.id !== before.id && next.libraryId === libraryId && next.port === port && next.status === 'running'));
  assert.equal(row.ownership, 'minnow'); assert.notEqual(row.pid, before.pid);
  assert.deepEqual(row.mtplxSettings, before.mtplxSettings);
  await complete(row);
  evidence.checks.restart = { pass: true, oldPid: before.pid, newPid: row.pid };
  await api(`/api/models/serve/${row.id}/stop`, {});
  row = await start(15_000);
  const startedAt = Date.now();
  for (let index = 0; index < 6; index++) {
    await complete(row);
    assert.equal((await api(`/api/models/serve/${row.id}`)).serve.status, 'running');
    if (index < 5) await sleep(7000);
  }
  const trafficMs = Date.now() - startedAt;
  const native = await fetch(`${row.baseUrl}/health`).then((response) => response.json());
  const stopped = await until(async () => { const next = (await api(`/api/models/serve/${row.id}`)).serve; return next.status === 'stopped' ? next : null; }, 45_000);
  const idleMs = stopped.stoppedAt - native.last_request_at * 1000;
  assert.ok(idleMs >= 15_000);
  evidence.checks.nativeIdle = { pass: true, trafficMs, idleMs, ttlMs: 15_000 };
  console.log('PASS owned crash recovery, direct activity and eventual idle eviction');
} catch (error) {
  evidence.error = error.message;
  process.exitCode = 1;
} finally {
  if (launched) {
    for (const row of (await api('/api/models/serve')).serves.filter((row) =>
      row.libraryId === libraryId && row.port === port && row.ownership === 'minnow' && live(row))) {
      await api(`/api/models/serve/${row.id}/stop`, {});
    }
  }
  if (values.output) await fs.writeFile(values.output, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify(evidence, null, 2));
}
