import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { unzipSync } from 'fflate';
import http from 'node:http';

const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-reef-test-')));
process.env.MINNOW_HOME = home;
const { createApp, readApp, updateApp, appRoot, safePath, copyTree, atomicJson } = await import('../../server/reef/store.js');
const { ReefSupervisor } = await import('../../server/reef/supervisor.js');
const { cleanEnvironment, command } = await import('../../server/reef/process.js');
const { startApp } = await import('../../server/reef/runtime-host.mjs');
const { readEvents, recordEvent } = await import('../../server/reef/events.js');
const { reefToolAllowed, reefProtectedPath } = await import('../../server/reef/tool-policy.js');
const { EXPORT_EXCLUDES, zipDirectory, githubWorkflow, runGithubExport } = await import('../../server/reef/exports.js');
const { planBackup } = await import('../../server/backup/plan.js');

after(async () => { await fs.rm(home, { recursive: true, force: true }); });
async function until(fn) { for (let i = 0; i < 200; i++) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('Timed out waiting for state'); }

test('app identities, concurrent metadata updates, and path containment', async () => {
  const app = await createApp({ prompt: 'A bill splitter', modelId: 'test' });
  await Promise.all(Array.from({ length: 12 }, () => updateApp(app.id, row => { row.count = (row.count ?? 0) + 1; })));
  assert.equal((await readApp(app.id)).count, 12);
  await assert.rejects(safePath(appRoot(app.id), '..', 'foreign'), /outside/);
  assert.throws(() => appRoot('../../escape'), /identifier/);
  assert.equal((await readApp(app.id)).release, null);
});

test('junctions and symbolic links are never followed by source/export copies', async t => {
  const root = path.join(home, 'links'), outside = path.join(home, 'outside');
  await fs.mkdir(root); await fs.mkdir(outside);
  try { await fs.symlink(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') { t.skip('Host does not permit symlink creation'); return; } throw error; }
  await assert.rejects(safePath(root, 'escape', 'file'), /symbolic/);
  await assert.rejects(copyTree(root, path.join(home, 'copied')), /Symbolic/);
});

test('source export excludes data, history, secrets and build metadata', async () => {
  const source = path.join(home, 'export-source'), target = path.join(home, 'export-target');
  await fs.mkdir(source);
  for (const name of ['.git', 'node_modules', 'data', 'runs', 'logs', 'exports']) {
    await fs.mkdir(path.join(source, name)); await fs.writeFile(path.join(source, name, 'private.txt'), 'private');
  }
  await fs.writeFile(path.join(source, '.env.local'), 'API_KEY=secret');
  await fs.writeFile(path.join(source, '.npmrc'), 'token=secret');
  await fs.writeFile(path.join(source, 'backend.mjs'), 'export const value = 42;');
  await copyTree(source, target, { exclude: EXPORT_EXCLUDES });
  const zip = path.join(home, 'source.zip'); await zipDirectory(target, zip);
  assert.deepEqual(Object.keys(unzipSync(await fs.readFile(zip))), ['backend.mjs']);
});

test('source-only agent policy cannot execute commands, publish, ask or use connectors', () => {
  for (const name of ['execute_command', 'git_push', 'ask_question', 'mcp__mail__send', 'plugin__test', 'apply_patch']) assert.equal(reefToolAllowed(name), false);
  assert.equal(reefToolAllowed('save_file', 'build'), true);
  assert.equal(reefToolAllowed('save_file', 'chat'), false);
  assert.equal(reefToolAllowed('read_file', 'plan'), true);
  assert.equal(reefProtectedPath({ path: '.git/config' }), true);
  assert.equal(reefProtectedPath({ path: 'src/main.ts' }), false);
  process.env.MINNOW_TOKEN = 'secret'; process.env.OPENAI_API_KEY = 'secret';
  assert.equal(cleanEnvironment().MINNOW_TOKEN, undefined);
  assert.equal(cleanEnvironment().OPENAI_API_KEY, undefined);
});

test('runtime requires its own capability and rejects foreign origins and private paths', async () => {
  const root = path.join(home, 'runtime'); await fs.mkdir(path.join(root, 'dist'), { recursive: true });
  await fs.writeFile(path.join(root, 'backend.mjs'), 'export async function handle(req,res){res.end("api result")}');
  await fs.writeFile(path.join(root, 'dist', 'index.html'), '<h1>Calculator</h1>');
  await fs.writeFile(path.join(root, 'secret'), 'private');
  const runtime = await startApp({ root, dataDir: path.join(root, 'data') });
  try {
    assert.equal((await fetch(runtime.url)).status, 200);
    assert.equal((await fetch(new URL('/', runtime.url))).status, 403);
    assert.equal((await fetch(runtime.url, { headers: { Origin: 'https://foreign.invalid' } })).status, 403);
    assert.equal((await fetch(`${runtime.url}%2e%2e%2fsecret`)).status, 403);
    assert.equal(await (await fetch(`${runtime.url}api/value`)).text(), 'api result');
    assert.equal((await fetch(`${runtime.url}__health`)).headers.get('referrer-policy'), 'no-referrer');
  } finally { await new Promise(resolve => runtime.server.close(resolve)); }
});

test('FIFO queue, monotonic progress, successful publication and failed revision preservation', async () => {
  const calls = [];
  const supervisor = new ReefSupervisor({ build: async ({ app, run, stage }) => {
    calls.push(app.id); await stage('checking', 70); await stage('repairing', 20);
    assert.equal((await readApp(app.id)).runs.at(-1).progress, 70);
    if (run.prompt === 'break') throw new Error('Tests failed');
    return { id: run.id, commit: 'a'.repeat(40), createdAt: Date.now() };
  } });
  const first = await createApp({ prompt: 'one' }), second = await createApp({ prompt: 'two' });
  await supervisor.enqueue(first.id, 'one'); await supervisor.enqueue(second.id, 'two');
  await supervisor.start('http://127.0.0.1:1');
  await until(async () => (await readApp(second.id)).status === 'ready');
  assert.deepEqual(calls, [first.id, second.id]);
  const release = (await readApp(first.id)).release;
  await supervisor.enqueue(first.id, 'break');
  await until(async () => (await readApp(first.id)).status === 'failed');
  assert.deepEqual((await readApp(first.id)).release, release);
  assert.match((await readApp(first.id)).runs.at(-1).error, /Tests failed/);
  supervisor.stop();
});

test('cancel, duplicate admission, deadline and restart recovery', async () => {
  const app = await createApp({ prompt: 'slow' });
  const supervisor = new ReefSupervisor({ timeout: 150, build: ({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) });
  await supervisor.start('http://127.0.0.1:1');
  const run = await supervisor.enqueue(app.id, 'slow');
  await assert.rejects(supervisor.enqueue(app.id, 'duplicate'), /already/);
  await until(() => supervisor.active?.runId === run.id);
  await supervisor.cancel(app.id, run.id);
  await until(async () => (await readApp(app.id)).status === 'cancelled');
  await supervisor.enqueue(app.id, 'timeout');
  await until(async () => (await readApp(app.id)).status === 'failed');
  assert.match((await readApp(app.id)).runs.at(-1).error, /deadline/);
  supervisor.stop();
  await updateApp(app.id, row => { row.runs.push({ id: randomUUID(), state: 'checking', progress: 80 }); });
  const recovered = new ReefSupervisor(); await recovered.start('http://127.0.0.1:1'); recovered.stop();
  assert.equal((await readApp(app.id)).runs.at(-1).state, 'interrupted');
});

test('event history survives restart and concurrent append preserves order', async () => {
  const app = await createApp({ prompt: 'events' });
  await Promise.all(Array.from({ length: 10 }, (_, value) => recordEvent(app.id, { type: 'log', text: String(value) })));
  const rows = await readEvents(app.id); assert.deepEqual(rows.map(row => row.id), [1,2,3,4,5,6,7,8,9,10]);
});

test('Reef status writes retry transient Windows reader locks without losing updates', async t => {
  const app = await createApp({ prompt: 'locked status' });
  const destination = path.join(appRoot(app.id), 'app.json'), rename = fs.rename;
  let retries = 0;
  t.mock.method(fs, 'rename', async (source, target) => {
    if (target === destination && retries++ < 2) throw Object.assign(new Error('Reader briefly locked status'), { code: 'EPERM' });
    return rename(source, target);
  });
  await updateApp(app.id, row => { row.description = 'Preserved through a reader lock'; });
  assert.equal(retries, 3);
  assert.equal((await readApp(app.id)).description, 'Preserved through a reader lock');
});

test('agent tokens are visible and persisted before a build finishes, with final chunks retained', async () => {
  const app = await createApp({ prompt: 'live stream' });
  let finish;
  const supervisor = new ReefSupervisor({ build: async ({ run, stage, log, stream }) => {
    await stage('planning', 10);
    log('Setting up\n');
    for (const text of ['I ', 'will ', 'build ', 'a ', 'timer.']) stream(text);
    await new Promise(resolve => { finish = resolve; });
    stream('\nFinal output');
    return { id: run.id, commit: 'a'.repeat(40), createdAt: Date.now() };
  } });
  try {
    await supervisor.enqueue(app.id, 'live stream'); await supervisor.start('http://unused');
    await until(async () => (await readApp(app.id)).runs.at(-1).agentLog === 'I will build a timer.');
    const running = (await readApp(app.id)).runs.at(-1);
    assert.equal(running.state, 'planning'); assert.equal(running.log, 'Setting up\n');
    assert.ok(running.startedAt > 0); assert.ok(running.lastActivityAt >= running.startedAt);
    assert.equal((await readEvents(app.id)).filter(event => event.type === 'activity').length, 1);
    finish(); await until(async () => (await readApp(app.id)).status === 'ready');
    assert.equal((await readApp(app.id)).runs.at(-1).agentLog, 'I will build a timer.\nFinal output');
  } finally { finish?.(); supervisor.stop(); }
});

test('process streams stdout before exit, keeps stderr in the build log and preserves split Unicode', async () => {
  let agent = '', log = '', completed = false;
  const result = command(process.execPath, ['-e', "const bytes=Buffer.from('Hello 🌊');process.stdout.write(bytes.subarray(0,8));setTimeout(()=>{process.stdout.write(bytes.subarray(8));process.stderr.write('diagnostic');},50);setTimeout(()=>{},150);"], {
    stdout: text => { assert.equal(completed, false); agent += text; }, log: text => { log += text; },
  });
  const output = await result; completed = true;
  assert.equal(agent, 'Hello 🌊'); assert.equal(log, 'diagnostic');
  assert.match(output, /Hello 🌊/);
});

test('process timeout keeps its cause when killing the child triggers close first', async () => {
  await assert.rejects(command(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeout: 50 }), /Command timed out:/);
});

test('streamed process failures use stderr diagnostics instead of agent JSON', async () => {
  let streamed = '';
  await assert.rejects(command(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({type:"delta",text:"Agent response"}));process.stderr.write("Provider disconnected");process.exit(1);'], {
    stdout: text => { streamed += text; },
  }), error => {
    assert.match(error.message, /Command failed \(1\): Provider disconnected/);
    assert.doesNotMatch(error.message, /Agent response|"type"/);
    return true;
  });
  assert.match(streamed, /Agent response/);
  await assert.rejects(command(process.execPath, ['-e', 'process.stdout.write("verification failed");process.exit(1);']), /verification failed/);
});

test('supervised processes disable the command timer and still honour cancellation', async () => {
  const controller = new AbortController(), reason = new Error('Build deadline exceeded');
  await assert.rejects(command(process.execPath, ['-e', 'process.stdout.write("ready");setInterval(()=>{},1000)'], {
    timeout: 0, signal: controller.signal, stdout: () => controller.abort(reason),
  }), error => error === reason);
});

test('progress stream reconnect replays only later events and invalid routes fail cleanly', async () => {
  const { createReefMiddleware } = await import('../../server/reef/middleware.js');
  const middleware = createReefMiddleware();
  const server = http.createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end(); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/reef`;
  try {
    const app = await createApp({ prompt: 'SSE reconnect' });
    await recordEvent(app.id, { type: 'stage', state: 'planning' });
    await recordEvent(app.id, { type: 'stage', state: 'building' });
    const controller = new AbortController();
    const response = await fetch(`${base}/apps/${app.id}/events?after=1`, { signal: controller.signal });
    const reader = response.body.getReader();
    const chunk = new TextDecoder().decode((await reader.read()).value);
    assert.match(chunk, /id: 2/); assert.doesNotMatch(chunk, /id: 1\n/);
    controller.abort();
    assert.equal((await fetch(`${base}/apps/invalid/events`)).status, 400);
    assert.equal((await fetch(`${base}/apps/${randomUUID()}/events`)).status, 404);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('runtime dependency checks reject native code but permit WASM', async () => {
  const { checkRuntimeDependencies } = await import('../../server/reef/pipeline.js');
  const workspace = path.join(home, 'dependency-check');
  const dependency = path.join(workspace, 'node_modules', 'utility');
  await fs.mkdir(dependency, { recursive: true });
  await atomicJson(path.join(workspace, 'package-lock.json'), { packages: { 'node_modules/utility': { version: '1.0.0' } } });
  await fs.writeFile(path.join(dependency, 'compute.wasm'), 'fixture');
  await checkRuntimeDependencies(workspace);
  await fs.writeFile(path.join(dependency, 'compute.node'), 'fixture');
  await assert.rejects(checkRuntimeDependencies(workspace), /Native runtime dependency/);
});

test('Reef backup is omitted without encryption and retains source and data with encryption', async () => {
  const app = await createApp({ prompt: 'backup' });
  for (const name of ['repo', 'data', 'releases', 'exports', 'node_modules']) {
    await fs.mkdir(path.join(appRoot(app.id), name)); await fs.writeFile(path.join(appRoot(app.id), name, 'test.txt'), 'keep');
  }
  const plaintext = await planBackup({ home, categories: ['reef'], includeCredentials: false });
  assert.equal(plaintext.files.length, 0);
  const encrypted = await planBackup({ home, categories: ['reef'], includeCredentials: false, encrypted: true });
  assert.ok(encrypted.files.some(file => file.rel.endsWith('/data/test.txt')));
  assert.ok(encrypted.files.some(file => file.rel.endsWith('/releases/test.txt')));
  assert.ok(!encrypted.files.some(file => file.rel.includes('/exports/') || file.rel.includes('/node_modules/')));
});

test('cloud workflow builds only the selected target and never publishes releases', () => {
  const workflow = githubWorkflow('darwin', 'arm64');
  assert.match(workflow, /macos-14/); assert.match(workflow, /--mac --arm64 --publish never/);
  assert.match(workflow, /contents: read/); assert.match(workflow, /workflow_dispatch/);
});

test('GitHub export creates a private repo once, watches the exact commit, and retries without force-pushing', async () => {
  const app = await createApp({ prompt: 'cloud export' });
  const item = { id: randomUUID(), target: 'win32', arch: 'x64' };
  await updateApp(app.id, current => current.exports.push(item));
  const calls = [];
  const execute = async (bin, args) => {
    calls.push([bin, ...args]);
    if (args.includes('user')) return 'tester';
    if (args.includes('isPrivate')) return '{"isPrivate":true}';
    if (args.includes('ls-remote')) return `${'a'.repeat(40)} refs/heads/main`;
    if (args.includes('rev-parse') || args.includes('commit-tree')) return 'a'.repeat(40);
    if (bin === 'gh' && args[0] === 'run' && args[1] === 'list') return JSON.stringify([{ databaseId: 17, url: 'https://github.com/tester/export/actions/runs/17' }]);
    return '';
  };
  const options = { command: execute, signal: new AbortController().signal };
  await runGithubExport(app, path.join(home, 'cloud-one'), item, options);
  const saved = await readApp(app.id);
  assert.equal(saved.githubRepo, `tester/reef-${app.id}`);
  assert.ok(calls.some(args => args.includes('--private')));
  assert.ok(calls.some(args => args.includes('--commit') && args.includes('a'.repeat(40))));
  calls.length = 0;
  await runGithubExport(saved, path.join(home, 'cloud-two'), item, options);
  assert.ok(!calls.some(args => args.includes('create') || args.includes('--force')));
  assert.ok(calls.some(args => args.includes('commit-tree') && args.includes('-p')));
  await assert.rejects(runGithubExport(saved, path.join(home, 'cloud-public'), item, { ...options, command: async (bin, args) => args.includes('isPrivate') ? '{"isPrivate":false}' : execute(bin, args) }), /private repository/);
});

test('process cancellation kills a child and rejects promptly', async () => {
  const controller = new AbortController();
  const running = command(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: controller.signal });
  setTimeout(() => controller.abort(new Error('test cancellation')), 50);
  await assert.rejects(running, /test cancellation/);
});
