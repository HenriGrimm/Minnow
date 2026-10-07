import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  AGENT_CLI_DEFINITIONS,
  agentCliCapabilityPatches,
  agentCliCapabilityPatchesWithConfig,
  codexCatalogRows,
  agentCliKindForProviderId,
  getAgentCliInstallCommand,
  listAgentCliModels,
  listAgentCliModelsWithConfig,
  parseCursorListModels,
} from '../../server/models/agent-cli-catalog.js';
import { getDefaultPaths } from '../../server/providers/paths.js';
import { applyAgentCliContextWindow } from '../../server/models/agent-cli-context.js';
import { contextLengthFromModelRow } from '../../src/lib/context-length.mjs';
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

  test('rejects arbitrary argv and bypasses, and migrates legacy replay defaults', () => {
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
      /sessionMode must be auto/,
    );
    assert.throws(
      () => validateAgentCliProfile({ kind: 'claude', maxConcurrent: 17 }),
      /integer from 1 to 16/,
    );
    assert.deepEqual(validateAgentCliProfile({ kind: 'claude' }), {
      kind: 'claude',
      sessionMode: 'auto',
      allowUtilityRoles: false,
      maxConcurrent: 1,
    });
  });

  test('legacy replay and auto both select automatic managed conversations', () => {
    assert.equal(validateAgentCliProfile({ kind: 'claude', sessionMode: 'replay' }).sessionMode, 'auto');
    assert.equal(validateAgentCliProfile({ kind: 'cursor', sessionMode: 'auto' }).sessionMode, 'auto');
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
        assert.equal(row.catalogVision, kind !== 'cursor');
        assert.ok(Array.isArray(row.reasoning.allowed_options));
      }
      const capabilities = agentCliCapabilityPatches(providerId);
      assert.deepEqual(Object.keys(capabilities), rows.map((row) => row.id));
      for (const cap of Object.values(capabilities)) {
        assert.equal(cap.tools, true);
        assert.equal(cap.streaming, true);
        assert.equal(cap.vision, kind !== 'cursor');
        assert.equal(cap.api, 'agent-cli-v1');
      }
    }
  });

  test('adds pinned Claude versions supported by the installed CLI', async () => {
    const older = await listAgentCliModelsWithConfig('claude-code-cli', { cliVersion: '2.1.226 (Claude Code)' });
    assert.deepEqual(older.map((row) => row.id), [
      'sonnet', 'opus', 'haiku', 'claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5',
    ]);
    const current = await listAgentCliModelsWithConfig('claude-code-cli', { cliVersion: '2.1.280 (Claude Code)' });
    assert.ok(current.some((row) => row.id === 'claude-opus-5-5'));
    assert.equal(current.find((row) => row.id === 'claude-opus-5-5').reasoning.default, 'medium');
    assert.equal(current.find((row) => row.id === 'opus').reasoning.default, 'medium');
    assert.equal(current.find((row) => row.id === 'opus').display_name, 'Claude Opus 5.5 (CLI default)');
    assert.equal(current.find((row) => row.id === 'sonnet').display_name, 'Claude Sonnet 5 (CLI default)');
    assert.equal(current.find((row) => row.id === 'haiku').display_name, 'Claude Haiku 4.5 (CLI default)');
    assert.equal(older.find((row) => row.id === 'opus').display_name, 'Claude Opus 5 (CLI default)');
    assert.equal(current.find((row) => row.id === 'claude-sonnet-5').max_context_length, 1_000_000);
    assert.equal(current.find((row) => row.id === 'sonnet').max_context_length, 1_000_000);
    assert.equal(current.find((row) => row.id === 'opus').max_context_length, 1_000_000);
    assert.equal(current.find((row) => row.id === 'haiku').max_context_length, 200_000);
  });

  test('explicit CLI windows reach the live budget and retain model restrictions', async () => {
    const claude = await listAgentCliModelsWithConfig('claude-code-cli', { contextWindowTokens: 1_000_000 });
    assert.equal(claude.find(row => row.id === 'sonnet').max_context_length, 1_000_000);
    assert.equal(claude.find(row => row.id === 'haiku').max_context_length, 200_000);
    const codex = applyAgentCliContextWindow([{ id: 'account-model', state: 'loaded', max_context_length: 272000 }], 'codex', 1_000_000);
    assert.equal(contextLengthFromModelRow({ ...codex[0], capabilities: { contextLength: 272000 } }), 1_000_000);
    const cursor = await listAgentCliModelsWithConfig('cursor-agent-cli', {
      listModelsText: 'auto - Auto\nclaude-opus-5-thinking-high - Claude Opus 5', contextWindowTokens: 1_000_000,
    });
    assert.equal(cursor[0].max_context_length, 200_000);
    assert.equal(cursor[1].max_context_length, 1_000_000);
    const lowered = applyAgentCliContextWindow(cursor, 'cursor', 128000);
    assert.ok(lowered.every(row => row.max_context_length === 128000));
    assert.deepEqual(validateAgentCliProfile({ contextWindowTokens: null }, { partial: true }), { contextWindowTokens: undefined });
    for (const value of [0, 999, 1_000_001, 1.5, '1000000', NaN]) {
      assert.throws(() => validateAgentCliProfile({ contextWindowTokens: value }, { partial: true }), /contextWindowTokens/);
    }
  });

  test('Sonnet and Opus 5.5 follow their separate CLI release gates', async () => {
    for (const [version, sonnet, opus] of [
      ['2.1.279', '5', '5'],
      ['2.1.280', '5', '5.5'],
      ['2.1.283', '5', '5.5'],
      ['2.1.284', '5.5', '5.5'],
      ['2.1.300', '5.5', '5.5'],
    ]) {
      const rows = await listAgentCliModelsWithConfig('claude-code-cli', { cliVersion: `${version} (Claude Code)` });
      for (const [alias, modelVersion] of [['sonnet', sonnet], ['opus', opus]]) {
        const family = alias.charAt(0).toUpperCase() + alias.slice(1);
        assert.equal(rows.find(row => row.id === alias).display_name, `Claude ${family} ${modelVersion} (CLI default)`);
        assert.ok(rows.some(row => row.id === `claude-${alias}-${modelVersion.replace('.', '-')}`));
      }
    }
  });

  test('normalizes the installed Codex catalog metadata and excludes non-picker rows', () => {
    const rows = codexCatalogRows([
      { slug: 'account-model', display_name: 'Account Model', visibility: 'list', priority: 2,
        context_window: 272000, default_reasoning_level: 'low',
        supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }, { effort: 'xhigh' }, { effort: 'ultra' }] },
      { slug: 'internal-model', visibility: 'hide', priority: 1 },
      { slug: 'unknown-visibility' },
    ]);
    assert.deepEqual(rows.map(row => row.id), ['account-model']);
    assert.equal(rows[0].display_name, 'Account Model');
    assert.equal(rows[0].max_context_length, 272000);
    assert.deepEqual(rows[0].reasoning.allowed_options, ['low', 'high', 'max']);
    assert.equal(rows[0].reasoning.default, 'low');
    assert.equal(rows[0].catalogVision, true);
  });

  test('Codex vision follows advertised modalities with the older-catalog default', () => {
    const rows = codexCatalogRows([
      { slug: 'vision', visibility: 'list', input_modalities: ['text', 'image'] },
      { slug: 'text-only', visibility: 'list', input_modalities: ['text'] },
      { slug: 'older', visibility: 'list' },
    ]);
    assert.deepEqual(Object.fromEntries(rows.map(row => [row.id, row.catalogVision])),
      { older: true, 'text-only': false, vision: true });
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

  test('Cursor sibling IDs expose reasoning choices through the normal model capability', async () => {
    const rows = await listAgentCliModelsWithConfig('cursor-agent-cli', {
      listModelsText: [
        'claude-opus-5-5-low - Claude Opus 5.5 Low',
        'claude-opus-5-5-medium - Claude Opus 5.5',
        'claude-opus-5-5-medium-fast - Claude Opus 5.5 Fast',
        'claude-opus-5-5-high - Claude Opus 5.5 High',
      ].join('\n'),
    });
    assert.deepEqual(rows[1].reasoning.allowed_options, ['low', 'medium', 'high']);
    assert.equal(rows[1].reasoning.default, 'medium');
    assert.equal(rows[2].id, 'claude-opus-5-5-medium-fast');
  });
});
