import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { clearAgentCliModelCatalogCache, listAgentCliModels, listAgentCliModelsWithConfig, resetAgentCliCatalogCacheForTests } from '../../server/models/agent-cli-catalog.js';
import { readCodexModelCatalog } from '../../server/models/codex-cli-catalog.js';
import { admitAgentCli, tryAdmitAgentCliProbe } from '../../server/generations/agent-cli/admission.js';

const fixture = fileURLToPath(new URL('../fixtures/fake-codex-catalog.mjs', import.meta.url));

async function fakeCodex(root) {
  const binPath = path.join(root, process.platform === 'win32' ? 'codex.cmd' : 'codex');
  await fs.copyFile(fixture, path.join(root, 'fixture.mjs'));
  await fs.writeFile(binPath, process.platform === 'win32'
    ? '@node "%~dp0\\fixture.mjs" %*\r\n'
    : `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${path.join(root, 'fixture.mjs').replaceAll("'", "'\\''")}' "$@"\n`);
  await fs.chmod(binPath, 0o700);
  return binPath;
}

const traceRuns = async (trace) => (await fs.readFile(trace, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);

test('Codex token refreshes keep the catalog cached; a busy Codex serves the last known catalog', async () => {
  resetAgentCliCatalogCacheForTests();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-codex-discovery-busy-'));
  try {
    const binPath = await fakeCodex(root);
    const trace = path.join(root, 'trace.jsonl');
    const env = { ...process.env, CODEX_HOME: root, CODEX_CATALOG_TRACE: trace };
    const auth = (token) => JSON.stringify({ OPENAI_API_KEY: null, tokens: { account_id: 'acct-1', access_token: token } });
    await fs.writeFile(path.join(root, 'auth.json'), auth('first-token'));
    const options = { binPath, env, cliVersion: 'cli-version' };
    assert.deepEqual((await listAgentCliModelsWithConfig('codex-cli', options)).map(row => row.id), ['cli-model']);
    await fs.writeFile(path.join(root, 'auth.json'), auth('refreshed-token'));
    await listAgentCliModelsWithConfig('codex-cli', options);
    assert.equal((await traceRuns(trace)).length, 1, 'a token refresh for the same account reuses the catalog');

    const release = tryAdmitAgentCliProbe('codex-cli');
    assert.ok(release);
    try {
      clearAgentCliModelCatalogCache('codex');
      assert.deepEqual((await listAgentCliModelsWithConfig('codex-cli', { ...options, refresh: true })).map(row => row.id), ['cli-model'],
        'busy Codex returns the last known catalog instead of failing');
    } finally { release(); }
    assert.equal((await traceRuns(trace)).length, 1);
  } finally {
    resetAgentCliCatalogCacheForTests();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('Cold Codex discovery waits for a competing background probe and returns installed models', async () => {
  resetAgentCliCatalogCacheForTests();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-codex-discovery-overlap-'));
  try {
    const binPath = await fakeCodex(root);
    const trace = path.join(root, 'trace.jsonl');
    const options = { binPath, env: { ...process.env, CODEX_HOME: root, CODEX_CATALOG_TRACE: trace } };
    const release = tryAdmitAgentCliProbe('codex-cli');
    assert.ok(release);
    const releaseUsage = delay(250).then(release);
    try {
      const results = await Promise.all([
        listAgentCliModelsWithConfig('codex-cli', options),
        listAgentCliModelsWithConfig('codex-cli', options),
      ]);
      for (const rows of results) assert.deepEqual(rows.map(row => row.id), ['cli-model']);
      assert.equal((await traceRuns(trace)).length, 1, 'overlapping startup reads share discovery');
    } finally { await releaseUsage; }
  } finally {
    resetAgentCliCatalogCacheForTests();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('An active Codex turn before any discovery falls back to the static catalog', async () => {
  resetAgentCliCatalogCacheForTests();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-codex-discovery-cold-'));
  try {
    const binPath = await fakeCodex(root);
    await fs.writeFile(path.join(root, 'auth.json'), '{"account":"cold"}');
    const release = await admitAgentCli('codex-cli');
    try {
      const rows = await listAgentCliModelsWithConfig('codex-cli', { binPath, env: { ...process.env, CODEX_HOME: root } });
      assert.deepEqual(rows.map(row => row.id), listAgentCliModels('codex-cli').map(row => row.id));
    } finally { release(); }
  } finally {
    resetAgentCliCatalogCacheForTests();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('Codex picker queries its installed CLI, isolates desktop metadata, caches and invalidates on login/version changes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-codex-discovery-test-'));
  try {
    const binPath = path.join(root, process.platform === 'win32' ? 'codex.cmd' : 'codex');
    await fs.copyFile(fixture, path.join(root, 'fixture.mjs'));
    await fs.writeFile(binPath, process.platform === 'win32'
      ? '@node "%~dp0\\fixture.mjs" %*\r\n'
      : `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${path.join(root, 'fixture.mjs').replaceAll("'", "'\\''")}' "$@"\n`);
    await fs.chmod(binPath, 0o700);
    const trace = path.join(root, 'trace.jsonl');
    const env = { ...process.env, CODEX_HOME: root, CODEX_CATALOG_TRACE: trace };
    await fs.writeFile(path.join(root, 'auth.json'), '{"account":"first"}');
    await fs.writeFile(path.join(root, 'models_cache.json'), JSON.stringify({ client_version: 'desktop-version', models: [{ slug: 'gpt-6.1-sol', visibility: 'list' }] }));
    const options = { binPath, env, cliVersion: 'cli-version' };
    const [rows, concurrent] = await Promise.all([
      listAgentCliModelsWithConfig('codex-cli', options), listAgentCliModelsWithConfig('codex-cli', options),
    ]);
    assert.deepEqual(rows, concurrent);
    assert.deepEqual(rows.map(row => row.id), ['cli-model']);
    assert.equal(rows[0].display_name, 'CLI Model');
    assert.equal(rows[0].supportsFastMode, true);
    assert.equal(rows[0].catalogVision, true, 'model/list modalities override cached metadata');
    assert.equal(rows[0].max_context_length, 272000);
    assert.deepEqual(rows[0].reasoning.allowed_options, ['low', 'xhigh']);
    assert.equal(rows[0].reasoning.default, 'low');
    await listAgentCliModelsWithConfig('codex-cli', options);
    let runs = (await fs.readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(runs.length, 1, 'concurrent and repeated discovery share a cached result');
    assert.equal(runs[0].inheritedCache, null);
    assert.equal(runs[0].auth, '{"account":"first"}');
    assert.deepEqual(runs[0].args, ['app-server', '--listen', 'stdio://']);
    await assert.rejects(fs.access(runs[0].home), 'private discovery home is removed');
    await fs.writeFile(path.join(root, 'auth.json'), '{"account":"second"}');
    await listAgentCliModelsWithConfig('codex-cli', options);
    await listAgentCliModelsWithConfig('codex-cli', { ...options, cliVersion: 'new-cli-version' });
    runs = (await fs.readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(runs.length, 3);
    await listAgentCliModelsWithConfig('codex-cli', { ...options, refresh: true });
    runs = (await fs.readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(runs.length, 4, 'explicit refresh bypasses the catalog TTL');
    assert.match(await fs.readFile(path.join(root, 'models_cache.json'), 'utf8'), /gpt-6.1-sol/);
  } finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }); }
});

test('Codex discovery times out without hanging the picker or leaving a child alive', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-codex-discovery-timeout-'));
  try {
    await assert.rejects(readCodexModelCatalog({ command: process.execPath, argsPrefix: [fixture], cwd: root,
      env: { ...process.env, CODEX_HOME: root, CODEX_CATALOG_HANG: '1' } }, 150), /timed out/);
  } finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }); }
});

test('Codex shared RPC discovery rejects malformed catalogs, cursor loops and redacts server errors', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-codex-discovery-protocol-'));
  try {
    for (const [scenario, expected] of [['malformed', /invalid model catalog/], ['cycle', /repeated.*cursor/], ['error', /failed/]]) {
      await assert.rejects(readCodexModelCatalog({ command: process.execPath, argsPrefix: [fixture], cwd: root,
        env: { ...process.env, CODEX_HOME: root, CODEX_CATALOG_SCENARIO: scenario } }), error => {
        assert.match(error.message, expected);
        assert.ok(!error.message.includes('secret-must-not-appear'));
        return true;
      });
    }
  } finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }); }
});
