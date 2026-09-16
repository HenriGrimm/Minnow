import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHarnessManager, validateRun } from '../../server/harness-evals/manager.js';
import { createHarnessEvalsMiddleware } from '../../server/harness-evals/middleware.js';

const options = { model: 'fixture/model', providerId: 'local', preset: 'smoke', attempts: 1,
  max_steps: 2, max_tokens: 512, context_window: 8192, timeout: 60 };
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
async function settle(manager) {
  for (let i = 0; i < 100; i++) {
    const state = await manager.status();
    if (state.active?.status !== 'running') return state;
    await tick();
  }
  throw new Error('Coordinator did not finish');
}
async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-harness-manager-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'evals/harness');
  for (const dir of ['artifacts', '.venv', 'datasets/terminal-2.1/tasks', 'datasets/deepswe/tasks']) await fs.mkdir(path.join(home, dir), { recursive: true });
  for (const file of ['gui.py', '.venv/pyvenv.cfg', 'artifacts/minnow-runtime.tar.gz.json']) await fs.writeFile(path.join(home, file), '');
  const launches = [];
  const launch = (command, args, opts) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    launches.push({ command, args, opts, child });
    return child;
  };
  const manager = createHarnessManager({ root, launch,
    probeCommand: async cmd => ({ stdout: cmd === 'docker' ? 'linux' : 'version' }),
    provider: async () => ({ profile: { enabled: true, apiKind: 'openai-v1', baseUrl: 'http://localhost:1234' },
      paths: { chatCompletionsPath: '/v1/chat/completions' }, headers: { Authorization: 'Bearer private-token', 'X-Custom': 'custom-secret' } }),
    kill: child => child.emit('close', 1), ...overrides });
  return { manager, launches, root, home };
}

test('run validates budgets and rejects malformed providers before launch', () => {
  assert.equal(validateRun(options).smoke, true);
  for (const invalid of [{ providerId: '../x' }, { attempts: 0 }, { attempts: '3' }, { timeout: Infinity }, { preset: 'full' }, { max_tokens: 8192 }, { model: '\n' }]) {
    assert.throws(() => validateRun({ ...options, ...invalid }));
  }
});

test('run isolates secrets, rejects duplicates, redacts split output and persists verifier results', async t => {
  const { manager, launches, home } = await fixture(t);
  const { id } = await manager.start('run', options);
  await assert.rejects(manager.start('setup'), /already running/);
  const { child, args, opts } = launches[0];
  assert.ok(args.includes('evals/harness/gui.py'));
  assert.equal(opts.shell, undefined);
  assert.equal(opts.env.MINNOW_EVAL_API_URL, 'http://localhost:1234/v1/chat/completions');
  assert.match(opts.env.MINNOW_EVAL_HEADERS, /private-token/);
  assert.doesNotMatch(JSON.stringify(await manager.status()), /private-token|custom-secret/);
  child.stdout.write('Bearer private-'); child.stdout.write('token and custom-secret\n');
  child.stderr.write('private-token\n'); child.stdout.end(); child.stderr.end(); child.emit('close', 0);
  const done = await settle(manager);
  assert.equal(done.active.status, 'completed');
  assert.doesNotMatch(done.active.log, /private-token|custom-secret/);
  assert.match(done.active.log, /redacted/);
  const jobs = path.join(home, 'artifacts', id, 'jobs'); await fs.mkdir(jobs, { recursive: true });
  await fs.writeFile(path.join(jobs, 'summary.json'), JSON.stringify({ build: { trials: 2, passed: 1 } }));
  // A new manager recovers saved history without restarting paid work.
  await tick();
  const restored = await createHarnessManager({ root: path.resolve(home, '../..') }).status();
  assert.equal(restored.active, null);
  assert.equal(restored.history[0].summary.build.passed, 1);
  assert.doesNotMatch(JSON.stringify(restored), /private-token|custom-secret/);
});

test('stopping setup prevents its dataset stage and releases the run lock', async t => {
  const { manager, launches } = await fixture(t);
  await manager.start('setup'); manager.stop();
  assert.equal((await settle(manager)).active.status, 'stopped');
  assert.equal(launches.length, 1);
  await manager.start('runtime');
  launches[1].child.emit('error', new Error('uv missing'));
  assert.equal((await settle(manager)).active.status, 'failed');
});

test('Docker unavailability stops a paid run before any child starts', async t => {
  const { manager, launches } = await fixture(t, { probeCommand: async cmd => ({ stdout: cmd === 'docker' ? 'windows' : 'version' }) });
  await assert.rejects(manager.start('run', options), /Linux containers/);
  assert.equal(launches.length, 0);
});

test('middleware only accepts fixed operations and bounds request bodies', async () => {
  let called = false;
  const handler = createHarnessEvalsMiddleware({ start: async () => { called = true; } });
  async function request(url, raw) {
    const req = new PassThrough(); req.method = 'POST'; req.url = url;
    const res = { setHeader() {}, end(value) { this.body = JSON.parse(value); } };
    req.end(raw); await handler(req, res, () => {}); return res;
  }
  assert.equal((await request('/api/harness-evals/shell', '{}')).statusCode, 404);
  assert.equal((await request('/api/harness-evals/run', 'x'.repeat(9000))).statusCode, 413);
  assert.equal((await request('/api/harness-evals/run', '{')).statusCode, 400);
  assert.equal(called, false);
});
