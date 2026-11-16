import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { detectAgentCli } from '../../server/models/agent-cli-detect.js';
import { createAgentCliUpdates } from '../../server/models/agent-cli-updates.js';
import { admitAgentCli } from '../../server/generations/agent-cli/admission.js';
import { resolveWindowsCmdShim } from '../../server/generations/agent-cli/resolve-bin.js';
import { handleAgentCliModelsRequest } from '../../server/models/agent-cli-middleware.js';
import { setRequestIngress } from '../../server/network/ingress.js';

test('checks only installed CLIs and treats unparseable or ambiguous feeds as unavailable', async () => {
  const versions = { claude: '2.9.0 (Claude Code)', codex: null, cursor: '2026.11.11-abcdef0' };
  const requested = [];
  const updates = createAgentCliUpdates({
    detect: async kind => ({ installed: Boolean(versions[kind]), version: versions[kind] }),
    fetch: async url => {
      requested.push(url);
      return url.includes('cursor.com') ? new Response('DOWNLOAD_URL="https://downloads.cursor.com/lab/2026.11.11-fedcba0/windows/x64/"')
        : Response.json({ version: '2.10.0' });
    },
  });
  const [first, second] = await Promise.all([updates.check(), updates.check(true)]);
  assert.deepEqual(first, second);
  assert.equal(requested.length, 2);
  assert.deepEqual(first.items.map(({ kind, state }) => [kind, state]), [['claude', 'available'], ['cursor', 'unavailable']]);
});

test('executes fixed updater argv once, protects active work and rechecks the installed version', async () => {
  let version = '1.1.0';
  const verified = [];
  let finish;
  let launched;
  const started = new Promise(resolve => { launched = resolve; });
  const providerId = 'claude-code-cli';
  const updates = createAgentCliUpdates({
    detect: async (kind, fresh, verify) => {
      if (verify) verified.push([kind, fresh, version]);
      return kind === 'claude' ? { installed: true, version, resolvedCommand: 'fixture-cli', resolvedArgsPrefix: ['fixture.js'] }
        : { installed: false };
    },
    fetch: async () => Response.json({ version: '1.2.0' }),
    run: async (command, args, options) => {
      launched({ command, args, options });
      await new Promise(resolve => { finish = resolve; });
      version = '1.2.0';
      return { code: 0 };
    },
  });
  assert.equal((await updates.check()).items[0].state, 'available');
  const release = await admitAgentCli(providerId);
  assert.throws(() => updates.update('claude'), /Finish or stop active/);
  release();
  const work = updates.update('claude');
  assert.equal(updates.update('claude'), work);
  const invocation = await started;
  await assert.rejects(admitAgentCli(providerId), /is updating/);
  assert.deepEqual(invocation.args, ['fixture.js', 'update']);
  assert.equal(invocation.command, 'fixture-cli');
  assert.equal(invocation.options.ignoreStdin, true);
  finish();
  assert.deepEqual(await work, { installedVersion: '1.2.0' });
  assert.deepEqual(verified, [['claude', true, '1.2.0']]);
  assert.equal((await updates.check()).items[0].state, 'current');
  (await admitAgentCli(providerId))();
});

test('paired ingress cannot launch CLI updates even with a loopback peer', async () => {
  const pathname = '/api/models/agent-clis/claude/update';
  const request = { method: 'POST', url: pathname, socket: { remoteAddress: '127.0.0.1' } };
  setRequestIngress(request, 'tailnet');
  const response = { setHeader() {}, end() {} };
  assert.equal(await handleAgentCliModelsRequest(request, response, pathname), true);
  assert.equal(response.statusCode, 403);
});

test('reports a Claude update connection failure without returning vendor output', async () => {
  const updates = createAgentCliUpdates({
    detect: async () => ({ installed: true, version: '2.1.323', resolvedCommand: 'claude', resolvedArgsPrefix: [] }),
    run: async () => ({ code: 1, stderr: 'getaddrinfo ENOTFOUND downloads.claude.ai private-value' }),
  });
  await assert.rejects(updates.update('claude'), {
    message: 'Could not update Claude Code. The updater could not reach the download server. Check your network or proxy and retry.',
  });
});

test('Windows Update verifies and stages the public Cursor package before switching versions', { skip: process.platform !== 'win32' }, async t => {
  const local = await fs.mkdtemp(fileURLToPath(new URL('./.cursor-update-', import.meta.url)));
  const originalLocal = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = local;
  t.after(async () => {
    process.env.LOCALAPPDATA = originalLocal;
    await fs.rm(local, { recursive: true, force: true });
  });
  const root = path.join(local, 'cursor-agent');
  const versions = path.join(root, 'versions');
  const oldVersion = '2026.10.01-e373342';
  const latest = '2026.11.13-eacade1';
  const launcher = path.join(root, 'agent.cmd');
  await fs.mkdir(path.join(versions, oldVersion), { recursive: true });
  await fs.writeFile(launcher, 'powershell.exe -File "%SCRIPT_DIR%\\agent.ps1" %*\r\n');
  await fs.writeFile(path.join(versions, oldVersion, 'node.exe'), '');
  await fs.writeFile(path.join(versions, oldVersion, 'index.js'), '');
  const requests = [];
  let probeVersion = oldVersion;
  const updates = createAgentCliUpdates({
    detect: async kind => {
      if (kind !== 'cursor') return { installed: false };
      const bin = await resolveWindowsCmdShim(launcher);
      return { installed: true, version: path.basename(path.dirname(bin.command)), resolvedBinPath: bin.display,
        resolvedCommand: bin.command, resolvedArgsPrefix: bin.argsPrefix };
    },
    fetch: async (url, options) => {
      requests.push(url);
      if (url.startsWith('https://cursor.com/')) {
        return new Response(`$downloadUrl = 'https://downloads.cursor.com/lab/${latest}/'\nthrow 'This script is metadata only'`);
      }
      const archiveUrls = ['x64', 'arm64'].map(arch => `https://downloads.cursor.com/lab/${latest}/windows/${arch}/agent-cli-package.zip`);
      assert.ok(archiveUrls.includes(url), url);
      assert.equal(options.redirect, 'error');
      return new Response('package fixture');
    },
    run: async (command, args, { cwd }) => {
      assert.equal(path.basename(path.dirname((await resolveWindowsCmdShim(launcher)).command)), oldVersion);
      const payload = path.join(cwd, 'dist-package');
      if (path.basename(command) === 'tar.exe') {
        assert.deepEqual(args, ['-xf', path.join(cwd, 'agent-cli-package.zip'), 'dist-package']);
        assert.equal(await fs.readFile(args[1], 'utf8'), 'package fixture');
        await fs.mkdir(payload);
        await fs.writeFile(path.join(payload, 'node.exe'), '');
        await fs.writeFile(path.join(payload, 'index.js'), '');
        return { code: 0 };
      }
      assert.equal(command, path.join(payload, 'node.exe'));
      assert.deepEqual(args, [path.join(payload, 'index.js'), '--version']);
      return { code: 0, stdout: probeVersion };
    },
  });
  assert.equal((await updates.check()).items[0].state, 'available');
  await assert.rejects(updates.update('cursor'), /could not report the expected version/);
  assert.deepEqual(await fs.readdir(versions), [oldVersion]);
  probeVersion = latest;
  assert.deepEqual(await updates.update('cursor'), { installedVersion: latest });
  assert.deepEqual((await fs.readdir(versions)).sort(), [oldVersion, latest]);
  assert.equal((await updates.check()).items[0].state, 'current');
  assert.equal(requests[0], 'https://cursor.com/install?win32=true&update=true&channel=prod');
});

test('Windows Update repairs a Codex shim whose version probe fails', { skip: process.platform !== 'win32' }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow codex repair-'));
  const originalPath = process.env.PATH;
  t.after(async () => {
    process.env.PATH = originalPath;
    await fs.rm(root, { recursive: true, force: true });
  });
  const shim = path.join(root, 'codex.cmd');
  const packageRoot = path.join(root, 'node_modules', '@openai', 'codex');
  const entry = path.join(packageRoot, 'bin', 'codex.js');
  const npmCli = path.join(root, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  await fs.mkdir(path.dirname(entry), { recursive: true });
  await fs.mkdir(path.dirname(npmCli), { recursive: true });
  await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: '@openai/codex', bin: { codex: 'bin/codex.js' } }));
  await fs.writeFile(shim, 'node "%~dp0\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n');
  await fs.writeFile(entry, 'process.exit(1);');
  await fs.writeFile(path.join(root, 'npm.cmd'), '');
  await fs.writeFile(npmCli, `
    const { writeFileSync } = require('node:fs');
    const { join } = require('node:path');
    const args = process.argv.slice(2);
    if (!args.includes('--include=optional') || !args.includes('@openai/codex@latest')) process.exit(1);
    const prefix = args[args.indexOf('--prefix') + 1];
    writeFileSync(join(prefix, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'), 'console.log("codex-cli 1.2.3");');
  `);
  process.env.PATH = `${root}${path.delimiter}${originalPath}`;
  const detect = () => detectAgentCli('codex', { binPath: shim, fresh: true });
  assert.equal((await detect()).version, undefined);
  assert.deepEqual(await createAgentCliUpdates({ detect }).update('codex'), { installedVersion: '1.2.3' });
});
