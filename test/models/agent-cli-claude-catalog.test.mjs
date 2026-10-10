import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { claudeCatalogRows, listAgentCliModels, listAgentCliModelsWithConfig, clearAgentCliModelCatalogCache } from '../../server/models/agent-cli-catalog.js';
import { readClaudeModelCatalog } from '../../server/models/claude-cli-catalog.js';

const fixture = fileURLToPath(new URL('../fixtures/fake-claude-catalog.mjs', import.meta.url));
const haiku = { value: 'haiku', resolvedModel: 'claude-haiku-5-5', displayName: 'Haiku 5.5',
  supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] };

test('Claude discovery reads the installed catalog without a prompt, caches, and refreshes new models', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-claude-discovery-test-'));
  try {
    const binPath = path.join(root, process.platform === 'win32' ? 'claude.cmd' : 'claude');
    await fs.copyFile(fixture, path.join(root, 'fixture.mjs'));
    await fs.writeFile(binPath, process.platform === 'win32' ? '@node "%~dp0\\fixture.mjs" %*\r\n'
      : `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${path.join(root, 'fixture.mjs').replaceAll("'", "'\\''")}' "$@"\n`);
    await fs.chmod(binPath, 0o700);
    const trace = path.join(root, 'trace.jsonl');
    const modelsFile = path.join(root, 'models.json');
    await fs.writeFile(modelsFile, JSON.stringify([haiku]));
    const options = { binPath, cliVersion: '2.1.296', env: { ...process.env, CLAUDE_CONFIG_DIR: root,
      CLAUDE_CATALOG_TRACE: trace, CLAUDE_CATALOG_MODELS: modelsFile } };
    const [rows, concurrent] = await Promise.all([listAgentCliModelsWithConfig('claude-code-cli', options),
      listAgentCliModelsWithConfig('claude-code-cli', options)]);
    assert.deepEqual(rows, concurrent);
    assert.deepEqual(rows.map(row => row.id), ['haiku', 'claude-haiku-5-5']);
    assert.equal(rows[0].display_name, 'Claude Haiku 5.5 (CLI default)');
    assert.equal(rows[0].max_context_length, 1_000_000);
    assert.deepEqual(rows[0].reasoning, { allowed_options: ['low', 'medium', 'high', 'max'], default: 'medium' });
    assert.ok(!JSON.stringify(rows).includes('private-must-not-appear'));
    await fs.writeFile(modelsFile, JSON.stringify([haiku, { value: 'new-model', resolvedModel: 'claude-new-7',
      displayName: 'New 7', contextWindow: 500000, supportsEffort: true, supportedEffortLevels: ['low', 'high'] }]));
    assert.equal((await listAgentCliModelsWithConfig('claude-code-cli', options)).length, 2, 'ordinary reads use the cache');
    const refreshed = await listAgentCliModelsWithConfig('claude-code-cli', { ...options, refresh: true });
    assert.ok(refreshed.some(row => row.id === 'claude-new-7'), 'new release appears without a Minnow catalog edit');
    assert.equal(refreshed.find(row => row.id === 'new-model').max_context_length, 500000);
    clearAgentCliModelCatalogCache('claude');
    await listAgentCliModelsWithConfig('claude-code-cli', options);
    await fs.writeFile(path.join(root, '.credentials.json'), '{"fixture":"new-account"}');
    await listAgentCliModelsWithConfig('claude-code-cli', options);
    await listAgentCliModelsWithConfig('claude-code-cli', { ...options, cliVersion: '2.1.297' });
    const runs = (await fs.readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(runs.length, 5);
    for (const run of runs) {
      assert.equal(run.request.type, 'control_request');
      assert.equal(run.request.request.subtype, 'initialize');
      assert.ok(run.args.includes('--no-session-persistence'));
      assert.equal(run.args[run.args.indexOf('--tools') + 1], '');
      assert.equal(run.args[run.args.indexOf('--settings') + 1], '{"disableAllHooks":true}');
      await assert.rejects(fs.access(run.cwd), 'scratch catalog directory is removed');
    }
    const fallback = await listAgentCliModelsWithConfig('claude-code-cli', { ...options, refresh: true,
      env: { ...options.env, CLAUDE_CATALOG_SCENARIO: 'error' } });
    assert.ok(fallback.some(row => row.id === 'claude-haiku-5-5'), 'unsupported discovery retains version-aware fallback');
  } finally { clearAgentCliModelCatalogCache('claude'); await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }); }
});

test('Claude discovery times out, rejects invalid responses, and keeps vendor errors private', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-claude-discovery-protocol-'));
  try {
    const modelsFile = path.join(root, 'models.json');
    await fs.writeFile(modelsFile, '[]');
    for (const [scenario, expected] of [['hang', /timed out/], ['malformed', /invalid model catalog/],
      ['error', /invalid model catalog/], ['exit', /exited/]]) {
      await assert.rejects(readClaudeModelCatalog({ command: process.execPath, argsPrefix: [fixture], cwd: root,
        env: { ...process.env, CLAUDE_CATALOG_MODELS: modelsFile, CLAUDE_CATALOG_SCENARIO: scenario } }, 500), error => {
        assert.match(error.message, expected);
        assert.ok(!error.message.includes('secret-must-not-appear'));
        return true;
      });
    }
  } finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }); }
});

test('Claude catalog preserves restrictions, raw IDs, advertised controls and unknown families', () => {
  const rows = claudeCatalogRows([{ value: 'default', displayName: 'Default' }, haiku,
    { value: 'blocked', disabled: true }, { value: 'haiku', displayName: 'Duplicate' }, null,
    { value: 'custom-model', displayName: 'Custom', supportsEffort: true, supportedEffortLevels: ['low', 'off', 'invalid'], defaultEffort: 'low' }]);
  assert.deepEqual(rows.map(row => row.id), ['haiku', 'claude-haiku-5-5', 'custom-model']);
  assert.deepEqual(rows[2].reasoning, { allowed_options: ['low'], default: 'low' });
  assert.equal(rows[2].max_context_length, 200000, 'unadvertised custom context is conservative');
  const fallback = listAgentCliModels('claude-code-cli', { cliVersion: '2.1.296' });
  const overridden = claudeCatalogRows([{ value: 'haiku', resolvedModel: 'claude-haiku-4-5', displayName: 'Haiku 4.5' }], fallback);
  assert.equal(overridden[0].max_context_length, 200000, 'actual account/provider resolution wins over the version fallback');
  assert.equal(overridden[0].reasoning.default, 'off');
  const sonnet = claudeCatalogRows([{ ...haiku, value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5' }], fallback);
  assert.equal(sonnet[0].reasoning.default, 'medium');
  const olderSdk = claudeCatalogRows([{ value: 'sonnet', displayName: 'Sonnet 5.5' }], fallback);
  assert.ok(olderSdk[0].reasoning.allowed_options.includes('high'), 'older SDK rows retain known reasoning when the field is absent');
});
