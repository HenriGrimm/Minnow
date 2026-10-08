import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { listAgentCliModelsWithConfig } from '../../server/models/agent-cli-catalog.js';
import { readCodexModelCatalog } from '../../server/models/codex-cli-catalog.js';

const fixture = fileURLToPath(new URL('../fixtures/fake-codex-catalog.mjs', import.meta.url));

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
    assert.equal(rows[0].catalogVision, true, 'model/list modalities override cached metadata');
    assert.equal(rows[0].max_context_length, 272000);
    assert.deepEqual(rows[0].reasoning.allowed_options, ['low', 'max']);
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
