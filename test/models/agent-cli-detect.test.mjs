import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { EventEmitter } from 'node:events';
import { runRequestWork } from '../../server/runtime/request-work.js';
import {
  detectAgentCli,
  parseAgentCliAuthStatus,
  resetAgentCliDetectionCacheForTests,
} from '../../server/models/agent-cli-detect.js';

const tempDirs = [];

async function tempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-agent-cli-detect-'));
  tempDirs.push(dir);
  return dir;
}

async function versionFixture() {
  const homeDir = await tempDir();
  const script = path.join(homeDir, 'fixture.mjs');
  const trace = path.join(homeDir, 'versions.log');
  await fs.writeFile(script, `import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(trace)}, 'version\\n');
await new Promise(resolve => setTimeout(resolve, Number(process.env.MINNOW_PROBE_DELAY_MS ?? 200)));
process.stdout.write((process.env.MINNOW_PROBE_VERSION ?? 'fixture 1.0') + '\\n');
`);
  const binPath = path.join(homeDir, process.platform === 'win32' ? 'probe.cmd' : 'probe');
  await fs.writeFile(binPath, process.platform === 'win32'
    ? '@node "%~dp0\\fixture.mjs" %*\r\n'
    : `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${script.replaceAll("'", "'\\''")}' "$@"\n`);
  await fs.chmod(binPath, 0o700);
  return { options: { homeDir, binPath, env: {} }, trace };
}

afterEach(async () => {
  resetAgentCliDetectionCacheForTests();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('agent CLI passive detection', () => {
  test('concurrent chat preflights share one version subprocess and refresh remains explicit', async () => {
    const { options, trace } = await versionFixture();
    const statuses = await Promise.all(Array.from({ length: 5 }, () => detectAgentCli('codex', options)));
    assert.ok(statuses.every(status => status.version === 'fixture 1.0'));
    assert.equal((await fs.readFile(trace, 'utf8')).trim().split('\n').length, 1);
    await detectAgentCli('codex', options);
    assert.equal((await fs.readFile(trace, 'utf8')).trim().split('\n').length, 1);
    await detectAgentCli('codex', { ...options, fresh: true });
    assert.equal((await fs.readFile(trace, 'utf8')).trim().split('\n').length, 2);
  });

  test('one disconnected chat does not cancel shared CLI detection', async () => {
    const { options, trace } = await versionFixture();
    const req = new EventEmitter(), res = new EventEmitter();
    const first = runRequestWork(req, res, () => detectAgentCli('codex', options));
    const second = detectAgentCli('codex', options);
    const deadline = Date.now() + 3000;
    while (!await fs.access(trace).then(() => true, () => false)) {
      assert.ok(Date.now() < deadline, 'version subprocess did not start');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    req.emit('aborted');
    const statuses = await Promise.all([first, second]);
    assert.ok(statuses.every(status => status.version === 'fixture 1.0'));
    assert.equal((await fs.readFile(trace, 'utf8')).trim().split('\n').length, 1);
  });

  test('an older pending preflight cannot replace an explicit refresh', async () => {
    const { options, trace } = await versionFixture();
    const older = detectAgentCli('codex', { ...options, env: { MINNOW_PROBE_DELAY_MS: '500', MINNOW_PROBE_VERSION: 'old' } });
    const deadline = Date.now() + 3000;
    while (!await fs.access(trace).then(() => true, () => false)) {
      assert.ok(Date.now() < deadline, 'older version subprocess did not start');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const refreshed = await detectAgentCli('codex', { ...options, fresh: true,
      env: { MINNOW_PROBE_DELAY_MS: '10', MINNOW_PROBE_VERSION: 'new' } });
    assert.equal(refreshed.version, 'new');
    assert.equal((await older).version, 'old');
    assert.strictEqual(await detectAgentCli('codex', options), refreshed);
    assert.equal((await fs.readFile(trace, 'utf8')).trim().split('\n').length, 2);
  });

  test('parses mixed status output only from explicit authentication signals', () => {
    assert.equal(
      parseAgentCliAuthStatus('update available\n{"loggedIn":true,"account":"hidden"}\nwarning'),
      'signed-in',
    );
    assert.equal(parseAgentCliAuthStatus('\u001B[32m{"loggedIn":true}\u001B[0m'), 'signed-in');
    assert.equal(parseAgentCliAuthStatus('{"authenticated":false}'), 'signed-out');
    assert.equal(parseAgentCliAuthStatus('{"is_error":false,"result":"ok"}'), 'unknown');
    assert.equal(parseAgentCliAuthStatus('command failed for an unrelated reason'), 'unknown');
  });

  test('reports configured executable and token without exposing token contents', async () => {
    const homeDir = await tempDir();
    const status = await detectAgentCli('codex', {
      binPath: process.execPath,
      cliToken: 'super-secret-token-value',
      homeDir,
      env: {},
      fresh: true,
    });
    assert.equal(status.installed, true);
    assert.equal(status.authStatus, 'token');
    assert.equal(JSON.stringify(status).includes('super-secret-token-value'), false);
  });

  test('detects credential-file presence without reading its contents', async () => {
    const homeDir = await tempDir();
    const credentialsDir = path.join(homeDir, '.claude');
    await fs.mkdir(credentialsDir, { recursive: true });
    await fs.writeFile(path.join(credentialsDir, '.credentials.json'), 'not-json-secret-material');
    const status = await detectAgentCli('claude', {
      binPath: process.execPath,
      homeDir,
      env: {},
      fresh: true,
    });
    assert.equal(status.installed, true);
    assert.equal(status.authStatus, 'unknown');
    assert.equal(status.hasCredentialFile, true);
    assert.equal(JSON.stringify(status).includes('secret-material'), false);
  });

  test('honors CLI-specific config directory environment variables', async () => {
    const homeDir = await tempDir();
    const codexHome = await tempDir();
    await fs.writeFile(path.join(codexHome, 'auth.json'), 'opaque-keyring-metadata');
    const status = await detectAgentCli('codex', {
      binPath: process.execPath,
      homeDir,
      env: { CODEX_HOME: codexHome },
      fresh: true,
    });
    assert.equal(status.authStatus, 'unknown');
    assert.equal(status.hasCredentialFile, true);
  });

  test('does not treat Cursor settings as proof of authentication', async () => {
    const homeDir = await tempDir();
    const cursorHome = await tempDir();
    await fs.writeFile(path.join(cursorHome, 'cli-config.json'), '{"theme":"dark"}');
    const status = await detectAgentCli('cursor', {
      binPath: process.execPath,
      homeDir,
      env: { CURSOR_CONFIG_DIR: cursorHome },
      fresh: true,
    });
    assert.equal(status.authStatus, 'unknown');
  });

  test('treats a well-known Cursor install as installed without PATH', async () => {
    const homeDir = await tempDir();
    const local = path.join(homeDir, 'AppData', 'Local');
    const versionDir = path.join(local, 'cursor-agent', 'versions', '2026.09.08-6caf4ff');
    await fs.mkdir(versionDir, { recursive: true });
    await fs.writeFile(path.join(versionDir, 'node.exe'), 'fake-node');
    await fs.writeFile(path.join(versionDir, 'index.js'), 'fake-index');
    await fs.writeFile(
      path.join(local, 'cursor-agent', 'cursor-agent.cmd'),
      '%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -File "%SCRIPT_DIR%\\cursor-agent.ps1" %*\r\n',
    );
    const status = await detectAgentCli('cursor', {
      homeDir,
      env: { LOCALAPPDATA: local },
      fresh: true,
    });
    if (process.platform === 'win32') {
      assert.equal(status.installed, true);
      assert.equal(status.resolvedCommand, path.join(versionDir, 'node.exe'));
    } else {
      assert.equal(status.installed, false);
    }
  });

  test('uses a 60-second cache for passive status', async () => {
    const homeDir = await tempDir();
    const first = await detectAgentCli('cursor', {
      binPath: process.execPath,
      homeDir,
      env: {},
      fresh: true,
    });
    await fs.rm(process.execPath + '.definitely-not-used', { force: true });
    const second = await detectAgentCli('cursor', {
      binPath: process.execPath,
      homeDir,
      env: {},
    });
    assert.strictEqual(second, first);
  });
});
