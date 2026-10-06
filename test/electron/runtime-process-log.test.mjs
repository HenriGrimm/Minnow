import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRuntimeLog, observeRuntimeProcess } from '../../scripts/runtime-process-log.mjs';

function scratch(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'minnow-runtime-log-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { MINNOW_HOME: home };
}

function contents(log, stream) {
  return fs.readFileSync(path.join(log.directory, `${log.runId}.${stream}.log`), 'utf8');
}

test('captures stdout, fatal stderr and exit status outside a failing child', async (t) => {
  const env = scratch(t);
  const child = spawn(process.execPath, ['-e', `
    process.stdout.write('ready\\n');
    process.stderr.write('last diagnostic\\n');
    throw new Error('fatal fixture');
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  const log = observeRuntimeProcess(child, 'server', { env, echo: false });
  const [code] = await once(child, 'close');
  assert.equal(code, 1);
  assert.equal(contents(log, 'stdout'), 'ready\n');
  assert.match(contents(log, 'stderr'), /last diagnostic[\s\S]*Error: fatal fixture/);
  const events = contents(log, 'events').trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.map((event) => event.kind), ['launch', 'spawn', 'exit', 'close']);
  assert.equal(events[2].code, 1);
  assert.equal(events[2].pid, child.pid);
  assert.ok(events.every((event) => Number.isFinite(Date.parse(event.ts))));
});

test('retains final stderr even when the child writes a large tail and exits', async (t) => {
  const child = spawn(process.execPath, ['-e', `
    process.stderr.write('x'.repeat(128 * 1024) + 'TAIL', () => process.exit(23));
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  const log = observeRuntimeProcess(child, 'electron', { env: scratch(t), echo: false });
  await once(child, 'close');
  assert.equal(contents(log, 'stderr'), 'x'.repeat(128 * 1024) + 'TAIL');
  assert.match(contents(log, 'events'), /"kind":"exit".*"code":23/);
});

test('records spawn errors without hiding them from callers', async (t) => {
  const env = scratch(t);
  const child = spawn(path.join(env.MINNOW_HOME, 'missing-executable'), [], { stdio: 'pipe' });
  const closed = new Promise((resolve) => child.once('close', resolve));
  const log = observeRuntimeProcess(child, 'electron', { env, echo: false });
  await closed;
  assert.match(contents(log, 'events'), /"kind":"spawn-error".*"code":"ENOENT"/);
});

test('records termination signals separately from exit codes', async (t) => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'pipe' });
  const log = observeRuntimeProcess(child, 'server', { env: scratch(t), echo: false });
  const closed = once(child, 'close');
  await once(child, 'spawn');
  child.kill('SIGTERM');
  await closed;
  const exit = contents(log, 'events').trim().split('\n').map(JSON.parse).find((event) => event.kind === 'exit');
  assert.equal(exit.signal, 'SIGTERM');
  assert.equal(exit.code, null);
});

test('bounds large chunks and keeps the latest bytes in two rotated files', (t) => {
  const log = createRuntimeLog('server', { env: scratch(t), maxBytes: 8 });
  log.write('stderr', 'aaaaaaaa');
  log.write('stderr', 'bbbbbbbbccccccccddddddd');
  assert.equal(contents(log, 'stderr'), 'ddddddd');
  assert.equal(fs.readFileSync(path.join(log.directory, `${log.runId}.stderr.log.1`), 'utf8'), 'cccccccc');
  assert.equal(fs.readFileSync(path.join(log.directory, `${log.runId}.stderr.log.2`), 'utf8'), 'bbbbbbbb');
  assert.ok(fs.readdirSync(log.directory).every((file) => fs.statSync(path.join(log.directory, file)).size <= 8));
});

test('new runs preserve previous logs and prune only old inactive matching files', (t) => {
  const env = scratch(t);
  const first = createRuntimeLog('server', { env });
  first.write('stderr', 'previous crash');
  const old = '1000000000000-2147483647-aaaaaaaa.stderr.log';
  fs.writeFileSync(path.join(first.directory, old), 'old');
  fs.writeFileSync(path.join(first.directory, 'unrelated.txt'), 'keep');
  const next = createRuntimeLog('server', { env, keepRuns: 1 });
  next.write('stderr', 'new run');
  assert.notEqual(first.runId, next.runId);
  assert.equal(contents(first, 'stderr'), 'previous crash');
  assert.equal(contents(next, 'stderr'), 'new run');
  assert.equal(fs.existsSync(path.join(first.directory, old)), false);
  assert.equal(fs.readFileSync(path.join(first.directory, 'unrelated.txt'), 'utf8'), 'keep');
});

test('an unwritable log location does not change child completion', async (t) => {
  const env = scratch(t);
  const blocked = path.join(env.MINNOW_HOME, 'file');
  fs.writeFileSync(blocked, 'not a directory');
  const child = spawn(process.execPath, ['-e', "process.stderr.write('still runs');"], { stdio: 'pipe' });
  observeRuntimeProcess(child, 'server', { echo: false, env: { MINNOW_HOME: blocked } });
  const [code] = await once(child, 'close');
  assert.equal(code, 0);
});

test('server launcher echoes output, preserves failure status and saves diagnostics', async (t) => {
  const env = scratch(t);
  // Run the real launcher against a tiny server in a scratch checkout.
  const scripts = path.join(env.MINNOW_HOME, 'scripts');
  fs.mkdirSync(scripts);
  for (const name of ['dev-server.mjs', 'runtime-process-log.mjs']) {
    fs.copyFileSync(new URL(`../../scripts/${name}`, import.meta.url), path.join(scripts, name));
  }
  fs.writeFileSync(path.join(env.MINNOW_HOME, 'server.js'), `
    console.log('fixture ready');
    process.stderr.write('fatal server fixture\\n', () => process.exit(23));
  `);
  const wrapper = spawn(process.execPath, [path.join(scripts, 'dev-server.mjs')], {
    env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  wrapper.stdout.on('data', (chunk) => { stdout += chunk; });
  wrapper.stderr.on('data', (chunk) => { stderr += chunk; });
  const [code] = await once(wrapper, 'close');
  assert.equal(code, 23);
  assert.match(stdout, /fixture ready/);
  assert.match(stderr, /fatal server fixture/);
  const directory = path.join(env.MINNOW_HOME, 'logs', 'runtime', 'server');
  const events = fs.readdirSync(directory).find((file) => file.endsWith('.events.log'));
  assert.match(fs.readFileSync(path.join(directory, events), 'utf8'), /"kind":"exit".*"code":23/);
});

test('detached shell supervisor stays alive until final output and exit are recorded', async (t) => {
  const env = scratch(t);
  const logger = new URL('../../scripts/runtime-process-log.mjs', import.meta.url).href;
  const supervisor = path.join(env.MINNOW_HOME, 'supervisor.mjs');
  fs.writeFileSync(supervisor, `
    import { spawn } from 'node:child_process';
    import { observeRuntimeProcess } from ${JSON.stringify(logger)};
    const child = spawn(process.execPath, ['-e', "setTimeout(() => { console.error('late shell failure'); process.exitCode = 17; }, 100)"], {
      detached: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    observeRuntimeProcess(child, 'electron', { echo: false });
  `);
  const launcher = spawn(process.execPath, [supervisor], {
    env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let errors = '';
  launcher.stderr.on('data', (chunk) => { errors += chunk; });
  const [code] = await once(launcher, 'close');
  assert.equal(code, 0, errors);
  const directory = path.join(env.MINNOW_HOME, 'logs', 'runtime', 'electron');
  const files = fs.readdirSync(directory);
  const stderr = files.find((file) => file.endsWith('.stderr.log'));
  const events = files.find((file) => file.endsWith('.events.log'));
  assert.match(fs.readFileSync(path.join(directory, stderr), 'utf8'), /late shell failure/);
  assert.match(fs.readFileSync(path.join(directory, events), 'utf8'), /"kind":"exit".*"code":17/);
});
