import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  applyAgentCliCaptureEnv,
  cursorAgentVersionSortKey,
  findAgentCliOnPath,
  resolveAgentCliBin,
  resolveWindowsCmdShim,
  stripAnsiFromCliText,
  wellKnownAgentCliPaths,
} from '../../server/generations/agent-cli/resolve-bin.js';

test('Windows npm command shims become shell-free Node script invocations', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-agent-cli-shim-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const script = path.join(root, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  const shim = path.join(root, 'codex.cmd');
  await fs.mkdir(path.dirname(script), { recursive: true });
  await fs.writeFile(script, 'process.stdout.write("ok")', 'utf8');
  await fs.writeFile(
    shim,
    '@IF EXIST "%~dp0\\node.exe" (\r\n' +
      '  "%~dp0\\node.exe" "%~dp0\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n' +
      ') ELSE (\r\n' +
      '  node "%~dp0\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n' +
      ')\r\n',
    'utf8',
  );

  const resolved = await resolveWindowsCmdShim(shim);
  assert.equal(resolved.command, process.execPath);
  assert.deepEqual(resolved.argsPrefix, [script]);
  assert.equal(resolved.display, shim);
});

test('Windows PATH discovery skips npm POSIX launchers and unwraps its command shim', { skip: process.platform !== 'win32' }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-agent-cli-path-'));
  const original = process.env.PATH;
  t.after(async () => { process.env.PATH = original; await fs.rm(root, { recursive: true, force: true }); });
  const script = path.join(root, 'cli.mjs');
  await fs.writeFile(script, '// fixture');
  await fs.writeFile(path.join(root, 'minnow-test-cli'), '#!/bin/sh\n');
  await fs.writeFile(path.join(root, 'minnow-test-cli.cmd'), 'node "%~dp0\\cli.mjs" %*\r\n');
  process.env.PATH = `${root}${path.delimiter}${original}`;
  const resolved = await resolveAgentCliBin({ kind: 'codex', binPath: 'minnow-test-cli' });
  assert.equal(resolved.command, process.execPath);
  assert.deepEqual(resolved.argsPrefix, [script]);
});

test('current npm _prog command shims unwrap to the package JS entry', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-agent-cli-npm-prog-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const script = path.join(root, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  const shim = path.join(root, 'codex.cmd');
  await fs.mkdir(path.dirname(script), { recursive: true });
  await fs.writeFile(script, 'process.stdout.write("ok")', 'utf8');
  await fs.writeFile(
    shim,
    '@ECHO off\r\n' +
      'GOTO start\r\n' +
      ':find_dp0\r\n' +
      'SET dp0=%~dp0\r\n' +
      'EXIT /b\r\n' +
      ':start\r\n' +
      'SETLOCAL\r\n' +
      'CALL :find_dp0\r\n' +
      'IF EXIST "%dp0%\\node.exe" (\r\n' +
      '  SET "_prog=%dp0%\\node.exe"\r\n' +
      ') ELSE (\r\n' +
      '  SET "_prog=node"\r\n' +
      ')\r\n' +
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n',
    'utf8',
  );

  const resolved = await resolveWindowsCmdShim(shim);
  assert.equal(resolved.command, process.execPath);
  assert.deepEqual(resolved.argsPrefix, [script]);
});

test('Cursor Windows launchers unwrap to the newest bundled node.exe', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-cursor-agent-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const versionDir = path.join(root, 'versions', '2026.09.08-6caf4ff');
  const nodePath = path.join(versionDir, 'node.exe');
  const indexPath = path.join(versionDir, 'index.js');
  await fs.mkdir(versionDir, { recursive: true });
  await fs.writeFile(nodePath, 'fake-node');
  await fs.writeFile(indexPath, 'fake-index');
  const shim = path.join(root, 'cursor-agent.cmd');
  await fs.writeFile(
    shim,
    '@echo off\r\n' +
      '%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%\\cursor-agent.ps1" %*\r\n',
    'utf8',
  );

  const resolved = await resolveWindowsCmdShim(shim);
  assert.equal(resolved.command, nodePath);
  assert.deepEqual(resolved.argsPrefix, [indexPath]);
  assert.equal(cursorAgentVersionSortKey('2026.09.08-6caf4ff') < cursorAgentVersionSortKey('2026.09.08-20-24-33-abc'), true);
});

test('Cursor discovery uses the vendor install dir when PATH misses it', async (t) => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-cursor-home-'));
  const originalPath = process.env.PATH;
  t.after(async () => {
    process.env.PATH = originalPath;
    await fs.rm(homeDir, { recursive: true, force: true });
  });
  process.env.PATH = process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')
    : '/usr/bin';

  const local = path.join(homeDir, 'AppData', 'Local');
  const expected = wellKnownAgentCliPaths('cursor-agent', {
    homeDir,
    env: { LOCALAPPDATA: local, APPDATA: path.join(homeDir, 'AppData', 'Roaming') },
  })[0];
  await fs.mkdir(path.dirname(expected), { recursive: true });
  await fs.writeFile(expected, '@echo off\n');

  const found = await findAgentCliOnPath('cursor-agent', {
    homeDir,
    env: { LOCALAPPDATA: local, APPDATA: path.join(homeDir, 'AppData', 'Roaming') },
  });
  assert.equal(found, expected);
});

test('capture env disables inherited FORCE_COLOR and stripAnsi removes CSI', () => {
  const env = applyAgentCliCaptureEnv({ FORCE_COLOR: '1', PATH: '/bin' }, process.execPath);
  assert.equal(env.FORCE_COLOR, '0');
  assert.equal(env.NO_COLOR, undefined);
  assert.equal(stripAnsiFromCliText('\u001B[32mauto\u001B[0m - Auto'), 'auto - Auto');
});

test('POSIX resolution finds well-known installs under a bare GUI PATH and spawns them by absolute path', { skip: process.platform === 'win32' }, async (t) => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-agent-cli-home-'));
  const originalPath = process.env.PATH;
  t.after(async () => { process.env.PATH = originalPath; await fs.rm(homeDir, { recursive: true, force: true }); });
  const bin = path.join(homeDir, '.local', 'bin', 'cursor-agent');
  await fs.mkdir(path.dirname(bin), { recursive: true });
  await fs.writeFile(bin, '#!/bin/sh\n', { mode: 0o755 });
  process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

  const resolved = await resolveAgentCliBin({ kind: 'cursor-agent', homeDir });
  assert.equal(resolved.command, bin);
  assert.deepEqual(resolved.argsPrefix, []);
});

test('POSIX spawn env appends the CLI directory and install dirs so env-node launchers work', { skip: process.platform === 'win32' }, () => {
  const env = applyAgentCliCaptureEnv({ PATH: '/usr/bin:/bin' }, '/Users/me/.nvm/versions/node/v22/bin/codex');
  const dirs = env.PATH.split(path.delimiter);
  assert.deepEqual(dirs.slice(0, 3), ['/usr/bin', '/bin', '/Users/me/.nvm/versions/node/v22/bin']);
  assert.ok(dirs.includes('/opt/homebrew/bin'));
  assert.ok(dirs.includes('/usr/local/bin'));
  assert.equal(new Set(dirs).size, dirs.length);
});
