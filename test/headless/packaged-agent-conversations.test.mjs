import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { PACKAGED_AGENT_CHECKS, PACKAGED_AGENT_RECEIPT, parsePackagedVerificationArgs,
  resolvePackagedApp, verifyPackagedAgentConversations } from '../../scripts/verify-packaged-agent-conversations.mjs';

const exec = promisify(execFile);

test('release jobs verify the newly packaged runtime before artifacts can be uploaded', async () => {
  for (const workflow of ['version-release', 'beta-nightly-release']) {
    const yml = await fs.readFile(new URL(`../../.github/workflows/${workflow}.yml`, import.meta.url), 'utf8');
    const build = yml.indexOf('- name: Build package');
    const check = yml.indexOf('node scripts/verify-packaged-agent-conversations.mjs --app-dir', build);
    const upload = yml.indexOf('uses: actions/upload-artifact', build);
    assert.ok(build >= 0 && check > build && upload > check, workflow);
  }
});
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-packaged-check-test-'));
  t.after(async () => {
    const actual = await fs.realpath(directory), temporary = await fs.realpath(os.tmpdir());
    const key = value => process.platform === 'win32' ? value.toLowerCase() : value;
    assert.equal(key(path.dirname(actual)), key(temporary));
    assert.ok(path.basename(actual).startsWith('minnow-packaged-check-test-'));
    await fs.rm(actual, { recursive: true, force: true });
  });
  return directory;
}
async function layout(root, platform) {
  const bundle = platform === 'darwin' ? path.join(root, 'Minnow.app') : root;
  const executable = platform === 'darwin' ? path.join(bundle, 'Contents/MacOS/Minnow')
    : path.join(root, platform === 'win32' ? 'Minnow.exe' : 'minnow');
  const archive = platform === 'darwin' ? path.join(bundle, 'Contents/Resources/app.asar') : path.join(root, 'resources/app.asar');
  for (const file of [executable, archive]) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, 'fixture artifact'); }
  return { bundle, executable, archive };
}

test('packaged worker accepts a symlink home alias but rejects a different cwd', async t => {
  const root = await fixture(t);
  const home = path.join(root, 'home'), alias = path.join(root, 'alias');
  const other = path.join(root, 'other'), app = path.join(root, 'app.asar');
  await fs.mkdir(home); await fs.mkdir(other);
  await fs.symlink(home, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const modules = {
    'config/home.js': 'export function ensureMinnowLayout() {}',
    'chats/repository.js': 'export function createChatRepository() { throw new Error("fixture stops at sqlite"); }',
    'chats/runtime.js': 'export function createProductionChatRuntime() {}',
    'chats/preparation.js': 'export function loadChatPreparationComposer() {} export function captureChatProfile() {}',
    'chats/archive.js': 'export function exportChatArchive() {}',
    'config/sessions-db.js': 'export function closeSessionsDb() {}',
  };
  await fs.mkdir(app, { recursive: true });
  await fs.writeFile(path.join(app, 'package.json'), '{"type":"module"}');
  for (const [name, source] of Object.entries(modules)) {
    const file = path.join(app, 'server', name);
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, source);
  }
  const bootstrap = path.join(root, 'bootstrap.mjs');
  await fs.writeFile(bootstrap, 'Object.defineProperty(process.versions, "electron", { value: "fixture" });');
  const worker = path.resolve('scripts/verify-packaged-agent-conversations-worker.mjs');
  for (const [cwd, expected] of [[home, ['asar-esm-runtime']], [other, []]]) {
    await assert.rejects(exec(process.execPath, ['--import', pathToFileURL(bootstrap).href, worker, app, 'fixture'], {
      cwd, env: { ...process.env, MINNOW_HOME: alias },
    }), error => {
      assert.equal(error.code, 1);
      const line = error.stdout.split(/\r?\n/).find(line => line.startsWith(PACKAGED_AGENT_RECEIPT));
      assert.ok(line, error.stderr);
      const result = JSON.parse(line.slice(PACKAGED_AGENT_RECEIPT.length));
      assert.deepEqual(result.checks, expected);
      assert.equal(result.failedCheck, expected.length ? 'native-sqlite' : 'asar-esm-runtime');
      return true;
    });
  }
});

test('packaged verifier requires an explicit bounded target and resolves known Windows/Linux/macOS layouts', async t => {
  assert.deepEqual(parsePackagedVerificationArgs(['--app-dir', 'unpacked']), { appDir: 'unpacked', timeoutMs: 30_000 });
  for (const args of [[], ['--app-dir'], ['--app-dir', 'a', '--app-dir', 'b'], ['--app-dir', 'a', '--timeout-ms', '0'],
    ['--app-dir', 'a', '--timeout-ms', '60001'], ['--app-dir', 'a', '--run-provider']]) assert.throws(() => parsePackagedVerificationArgs(args), /invalid_arguments/);
  const root = await fixture(t);
  for (const platform of ['win32', 'linux', 'darwin']) {
    const directory = path.join(root, platform), expected = await layout(directory, platform);
    const actual = await resolvePackagedApp(directory, platform);
    assert.equal(actual.executable, expected.executable); assert.equal(actual.archive, expected.archive);
    if (platform === 'darwin') assert.equal((await resolvePackagedApp(expected.bundle, platform)).archive, expected.archive);
    await fs.unlink(expected.archive);
    await assert.rejects(resolvePackagedApp(directory, platform), /app_asar_missing/);
  }
  await assert.rejects(resolvePackagedApp(path.join(root, 'absent')), /app_executable_missing/);
});

test('packaged verifier uses an isolated owned home, requires the exact worker receipt and fails closed on incomplete or timed-out checks', async t => {
  const root = await fixture(t), app = await layout(root, process.platform), sentinel = 'UNTRUSTED_DIAGNOSTIC_DO_NOT_ECHO';
  const originalHome = process.env.MINNOW_HOME;
  for (const kind of ['pass', 'partial', 'stale', 'timeout']) {
    let scratch;
    const report = await verifyPackagedAgentConversations({ appDir: root }, { launch(executable, args, options) {
      assert.equal(executable, app.executable); assert.equal(args[1], app.archive);
      assert.ok(args[0].endsWith('verify-packaged-agent-conversations-worker.mjs'));
      scratch = options.cwd;
      assert.equal(options.env.MINNOW_HOME, scratch); assert.notEqual(scratch, originalHome);
      assert.equal(options.env.ELECTRON_RUN_AS_NODE, '1'); assert.equal(options.env.MINNOW_HEADLESS, '1');
      assert.equal(options.windowsHide, true); assert.equal(options.timeout, 30_000);
      const result = { version: 1, nonce: kind === 'stale' ? 'stale' : args[2], status: 'PASS',
        checks: kind === 'partial' ? PACKAGED_AGENT_CHECKS.slice(0, -1) : PACKAGED_AGENT_CHECKS };
      return { status: 0, stdout: sentinel + '\n' + PACKAGED_AGENT_RECEIPT + JSON.stringify(result) + '\n', stderr: sentinel,
        ...(kind === 'timeout' ? { error: { code: 'ETIMEDOUT' } } : {}) };
    } });
    assert.equal(report.inference, false); assert.equal(report.status, kind === 'pass' ? 'PASS' : 'FAIL');
    assert.equal(report.code, { pass: 'packaged_runtime_verified', partial: 'runtime_checks_incomplete', stale: 'runtime_receipt_missing', timeout: 'runtime_timeout' }[kind]);
    assert.equal(JSON.stringify(report).includes(sentinel), false);
    await assert.rejects(fs.access(scratch), 'the verifier removes only its owned scratch home');
    assert.equal(process.env.MINNOW_HOME, originalHome);
  }
  assert.equal(await fs.readFile(app.archive, 'utf8'), 'fixture artifact', 'the supplied package is never rewritten');
});

test('packaged verifier CLI reports a missing app as FAIL with nonzero exit rather than a successful skip', async t => {
  const root = await fixture(t);
  await assert.rejects(exec(process.execPath, [path.resolve('scripts/verify-packaged-agent-conversations.mjs'), '--app-dir', path.join(root, 'missing')]), error => {
    assert.equal(error.code, 1);
    const report = JSON.parse(error.stdout);
    assert.equal(report.status, 'FAIL'); assert.equal(report.code, 'app_executable_missing');
    assert.deepEqual(report.checks, []); assert.equal(report.inference, false);
    return true;
  });
});
