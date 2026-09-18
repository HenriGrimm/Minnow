import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import {
  AGENT_CLI_DEFINITIONS,
  agentCliCapabilityPatches,
  agentCliCapabilityPatchesWithConfig,
  agentCliKindForProviderId,
  getAgentCliInstallCommand,
  listAgentCliModels,
  listAgentCliModelsWithConfig,
  parseCursorListModels,
} from '../../server/models/agent-cli-catalog.js';
import { getDefaultPaths } from '../../server/providers/paths.js';
import {
  validateAgentCliProfile,
  validateApiKind,
} from '../../server/providers/validate.js';
import {
  AGENT_CLI_PROVIDER_IDS,
  isAgentCliProviderId,
} from '../../src/models/runtime-ids.mjs';

describe('agent CLI provider seam and static catalog', () => {
  test('uses reserved ids and inert HTTP paths', () => {
    assert.deepEqual([...AGENT_CLI_PROVIDER_IDS], [
      'claude-code-cli',
      'codex-cli',
      'cursor-agent-cli',
    ]);
    assert.equal(isAgentCliProviderId('codex-cli'), true);
    assert.equal(isAgentCliProviderId('custom-codex-cli'), false);
    assert.equal(validateApiKind('agent-cli-v1'), 'agent-cli-v1');
    assert.equal(
      AGENT_CLI_DEFINITIONS.codex.loginCommand,
      'codex -c cli_auth_credentials_store=file login',
    );
    assert.equal(
      getAgentCliInstallCommand('cursor', { platform: 'linux', shell: '/bin/bash' }),
      'curl https://cursor.com/install -fsS | bash',
    );
    assert.equal(
      getAgentCliInstallCommand('cursor', { platform: 'win32' }),
      "irm 'https://cursor.com/install?win32=true' | iex",
    );
    assert.deepEqual(
      AGENT_CLI_DEFINITIONS.codex.authArgs,
      ['-c', 'cli_auth_credentials_store=file', 'login', 'status'],
    );
    assert.deepEqual(getDefaultPaths('agent-cli-v1'), {
      modelsPath: '',
      chatCompletionsPath: '',
      embeddingsPath: '',
    });
  });

  test('rejects arbitrary argv, permission bypasses, and non-replay sessions', () => {
    assert.throws(
      () => validateAgentCliProfile({ kind: 'claude', extraArgs: ['--dangerously-skip-permissions'] }),
      /Unsupported agentCli setting: extraArgs/,
    );
    assert.throws(
      () => validateAgentCliProfile({ kind: 'codex', permissionMode: 'bypassPermissions' }),
      /Unsupported agentCli setting: permissionMode/,
    );
    assert.throws(
      () => validateAgentCliProfile({ kind: 'cursor', sessionMode: 'resume' }),
      /sessionMode must be replay/,
    );
    assert.throws(
      () => validateAgentCliProfile({ kind: 'claude', maxConcurrent: 17 }),
      /integer from 1 to 16/,
    );
    assert.deepEqual(validateAgentCliProfile({ kind: 'claude' }), {
      kind: 'claude',
      sessionMode: 'replay',
      allowUtilityRoles: false,
      maxConcurrent: 1,
    });
  });

  test('returns selectable rows with known context, reasoning, and vision', () => {
    for (const providerId of AGENT_CLI_PROVIDER_IDS) {
      const kind = agentCliKindForProviderId(providerId);
      const rows = listAgentCliModels(providerId);
      assert.ok(kind);
      assert.ok(rows.length > 0);
      for (const row of rows) {
        assert.equal(row.type, 'llm');
        assert.equal(row.state, 'loaded');
        assert.equal(row.api, 'agent-cli-v1');
        assert.ok(row.max_context_length > 0);
        assert.equal(row.catalogVision, kind === 'claude');
        assert.ok(Array.isArray(row.reasoning.allowed_options));
      }
      const capabilities = agentCliCapabilityPatches(providerId);
      assert.deepEqual(Object.keys(capabilities), rows.map((row) => row.id));
      for (const cap of Object.values(capabilities)) {
        assert.equal(cap.tools, true);
        assert.equal(cap.streaming, true);
        assert.equal(cap.vision, kind === 'claude');
        assert.equal(cap.api, 'agent-cli-v1');
      }
    }
  });

  test('enriches Codex from models_cache metadata without an inference probe', async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-codex-catalog-'));
    try {
      await fs.writeFile(
        path.join(homeDir, 'models_cache.json'),
        JSON.stringify({
          models: [
            {
              slug: 'account-model',
              visibility: 'list',
              priority: 2,
              context_window: 272000,
              supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }, { effort: 'xhigh' }, { effort: 'ultra' }],
            },
            { slug: 'internal-model', visibility: 'hide', priority: 1 },
          ],
        }),
      );
      const rows = await listAgentCliModelsWithConfig('codex-cli', {
        env: { CODEX_HOME: homeDir },
        homeDir,
      });
      assert.deepEqual(rows.map((row) => row.id), ['account-model']);
      assert.equal(rows[0].max_context_length, 272000);
      assert.deepEqual(rows[0].reasoning.allowed_options, ['off', 'low', 'high', 'max']);
      assert.equal(rows[0].catalogVision, false);
      const capabilities = await agentCliCapabilityPatchesWithConfig('codex-cli', {
        env: { CODEX_HOME: homeDir },
        homeDir,
      });
      assert.deepEqual(Object.keys(capabilities), ['account-model']);
      assert.equal(capabilities['account-model'].tools, true);
      assert.equal(capabilities['account-model'].vision, false);
      assert.equal(capabilities['account-model'].grammar, false);
      assert.equal(capabilities['account-model'].reasoning, true);
      assert.equal(capabilities['account-model'].contextLength, 272000);
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });

  test('Cursor static catalog is more than Auto', () => {
    const ids = listAgentCliModels('cursor-agent-cli').map((row) => row.id);
    assert.ok(ids.includes('auto'));
    assert.ok(ids.includes('composer-2.5'));
    assert.ok(ids.length > 1);
  });

  test('parses cursor-agent --list-models text into selectable ids', () => {
    const rows = parseCursorListModels([
      'Available models',
      '',
      'auto - Auto (default)',
      'composer-2.5 - Composer 2.5',
      'claude-opus-5-thinking-high - Claude Opus 5 1M Thinking',
      'not a model line',
      'auto - Auto (default)',
    ].join('\n'));
    assert.deepEqual(rows.map((row) => row.id), ['auto', 'composer-2.5', 'claude-opus-5-thinking-high']);
    assert.equal(rows[0].max_context_length, 200_000);
    assert.equal(rows[2].max_context_length, 1_000_000);
  });

  test('parses FORCE_COLOR ANSI-wrapped --list-models lines', () => {
    const rows = parseCursorListModels([
      '\u001B[1mAvailable models\u001B[0m',
      '\u001B[32mauto\u001B[0m - Auto (default)',
      '\u001B[36mcomposer-2.5\u001B[0m - Composer 2.5',
    ].join('\n'));
    assert.deepEqual(rows.map((row) => row.id), ['auto', 'composer-2.5']);
  });

  test('falls back to the static Cursor catalog when --list-models is empty', async () => {
    const rows = await listAgentCliModelsWithConfig('cursor-agent-cli', { listModelsText: '' });
    const ids = rows.map((row) => row.id);
    assert.ok(ids.includes('auto'));
    assert.ok(ids.includes('composer-2.5'));
    assert.ok(ids.length > 1);
  });

  test('enriches Cursor from --list-models text without an inference probe', async () => {
    const rows = await listAgentCliModelsWithConfig('cursor-agent-cli', {
      listModelsText: 'Available models\n\nauto - Auto (default)\ncomposer-2.5 - Composer 2.5\n',
    });
    assert.deepEqual(rows.map((row) => row.id), ['auto', 'composer-2.5']);
    assert.equal(rows[0].api, 'agent-cli-v1');
    assert.equal(rows[0].catalogVision, false);
    assert.deepEqual(rows[0].reasoning.allowed_options, []);
    const capabilities = await agentCliCapabilityPatchesWithConfig('cursor-agent-cli', {
      listModelsText: 'Available models\n\nauto - Auto (default)\ncomposer-2.5 - Composer 2.5\n',
    });
    assert.deepEqual(Object.keys(capabilities), ['auto', 'composer-2.5']);
    assert.equal(capabilities['composer-2.5'].tools, true);
    assert.equal(capabilities['composer-2.5'].vision, false);
  });
});
