import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareAgentCliInvocation } from '../../server/generations/agent-cli/invocation.js';

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-agent-cli-'));
const common = {
  profile: {},
  tempDir,
  prompt: 'Read the repository and report the result.',
  systemPrompt: 'You are a coding assistant.',
  bridgeConfig: {
    command: process.execPath,
    args: ['shim.mjs'],
    env: {
      MINNOW_CLI_BRIDGE_URL: 'http://127.0.0.1:1',
      MINNOW_CLI_BRIDGE_TOKEN: 'generation-token',
    },
  },
};

for (const kind of ['claude', 'codex', 'cursor']) {
  test(`${kind} uses shell-free invocation and bounded env`, async () => {
    const result = await prepareAgentCliInvocation({ ...common, kind });
    assert.equal(result.shell, false);
    assert.equal(result.cwd, tempDir);
    assert.equal(result.env.MINNOW_CLI_BRIDGE_TOKEN, 'generation-token');
    assert.equal(result.env.SECRET_FROM_MODEL, undefined);
    assert.equal(result.args.some((arg) => arg.includes(common.prompt)), false);
  });
}

test('Claude, Codex, and Cursor send the prompt through stdin', async () => {
  for (const kind of ['claude', 'codex', 'cursor']) {
    const result = await prepareAgentCliInvocation({ ...common, kind });
    assert.match(result.stdin, /repository/);
    assert.equal(result.args.includes(common.prompt), false);
    assert.equal(result.args.some((arg) => arg.includes(common.systemPrompt)), false);
  }
});

test('interactive Claude uses a real terminal contract with no print flags or background suggestions', async () => {
  const result = await prepareAgentCliInvocation({ ...common, kind: 'claude', interactive: true, sessionId: '00000000-0000-4000-8000-000000000000' });
  assert.equal(result.transport, 'claude-interactive');
  assert.equal(result.keepStdinOpen, true);
  for (const flag of ['--print', '--input-format', '--output-format', '--include-partial-messages']) assert.equal(result.args.includes(flag), false);
  assert.equal(result.args[result.args.indexOf('--thinking-display') + 1], 'summarized');
  assert.equal(result.args[result.args.indexOf('--tools') + 1], '');
  assert.equal(result.args[result.args.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.equal(result.env.CLAUDE_CODE_ENTRYPOINT, undefined);
  assert.equal(result.env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION, 'false');
  assert.equal(result.env.ENABLE_TOOL_SEARCH, 'false');
  assert.equal(result.env.DISABLE_AUTOUPDATER, '1');
  await assert.rejects(prepareAgentCliInvocation({ ...common, kind: 'claude', interactive: true, profile: { maxBudgetUsd: 1 } }), /do not support.*budget/);
});

test('Codex global controls precede exec subcommand', async () => {
  const result = await prepareAgentCliInvocation({ ...common, kind: 'codex' });
  const execIndex = result.args.indexOf('exec');
  assert.ok(execIndex > 0);
  for (const flag of ['--ask-for-approval', '--sandbox', '--disable', '--model']) {
    if (flag === '--model') continue;
    assert.ok(result.args.indexOf(flag) < execIndex, `${flag} must be global`);
  }
  assert.equal(result.args.at(-1), '-');
});

test('explicit context windows use provider-supported controls', async () => {
  const profile = { contextWindowTokens: 1_000_000 };
  const codex = await prepareAgentCliInvocation({ ...common, kind: 'codex', profile });
  assert.ok(codex.args.indexOf('model_context_window=1000000') < codex.args.indexOf('exec'));
  const automatic = await prepareAgentCliInvocation({ ...common, kind: 'codex' });
  assert.equal(automatic.args.some(arg => arg.startsWith('model_context_window=')), false);
  for (const [model, requested] of [['sonnet', 'sonnet[1m]'], ['claude-opus-4-6', 'claude-opus-4-6[1m]'],
    ['claude-sonnet-5-5', 'claude-sonnet-5-5'], ['haiku', 'haiku']]) {
    const claude = await prepareAgentCliInvocation({ ...common, kind: 'claude', profile, body: { model } });
    assert.equal(claude.args[claude.args.indexOf('--model') + 1], requested);
    assert.equal(claude.env.CLAUDE_CODE_DISABLE_1M_CONTEXT, '0');
  }
  const capped = await prepareAgentCliInvocation({ ...common, kind: 'claude', profile: { contextWindowTokens: 200_000 }, body: { model: 'sonnet' } });
  assert.equal(capped.env.CLAUDE_CODE_DISABLE_1M_CONTEXT, '1');
  const cursor = await prepareAgentCliInvocation({ ...common, kind: 'cursor', profile });
  assert.equal(cursor.args.some(arg => /context/i.test(arg)), false);
});

test.after(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

test('Claude carries bounded base64 images in its user content', async () => {
  const result = await prepareAgentCliInvocation({
    ...common,
    kind: 'claude',
    body: { agentCliImages: [{ type: 'image', source: { media_type: 'image/png', data: 'aGVsbG8=' } }] },
  });
  const event = JSON.parse(result.stdin);
  assert.equal(event.message.content[1].type, 'image');
  assert.equal(event.message.content[1].source.data, 'aGVsbG8=');
});

test('generated configs contain only Minnow MCP and disable native tools', async () => {
  const claude = await prepareAgentCliInvocation({ ...common, kind: 'claude' });
  const claudeConfig = JSON.parse(await fs.readFile(path.join(tempDir, 'claude-mcp.json'), 'utf8'));
  assert.deepEqual(Object.keys(claudeConfig.mcpServers), ['minnow']);
  assert.equal(claude.env.CLAUDE_CONFIG_DIR, process.env.CLAUDE_CONFIG_DIR);
  assert.equal(claude.env.CLAUDE_CODE_DISABLE_TERMINAL_TITLE, '1');
  assert.ok(claude.args.includes('--strict-mcp-config'));
  assert.equal(claude.args[claude.args.indexOf('--thinking-display') + 1], 'summarized');
  assert.ok(claude.args.includes('mcp__minnow__*'));

  const codex = await prepareAgentCliInvocation({ ...common, kind: 'codex' });
  const codexConfig = await fs.readFile(path.join(tempDir, 'codex-home', 'config.toml'), 'utf8');
  assert.match(codexConfig, /^cli_auth_credentials_store = "file"$/m);
  assert.match(codexConfig, /^model_reasoning_summary = "auto"$/m);
  assert.match(codexConfig, /^hide_agent_reasoning = false$/m);
  assert.match(codexConfig, /shell_tool = false/);
  assert.match(codexConfig, /\[mcp_servers\.minnow\]/);
  assert.match(codexConfig, /default_tools_approval_mode = "approve"/);
  assert.doesNotMatch(codexConfig, /enabled_tools/);
  assert.equal(codex.env.CODEX_HOME, path.join(tempDir, 'codex-home'));

  const cursor = await prepareAgentCliInvocation({ ...common, kind: 'cursor' });
  const cursorConfig = JSON.parse(await fs.readFile(path.join(tempDir, 'cursor-config', 'cli-config.json'), 'utf8'));
  assert.deepEqual(cursorConfig.permissions.allow, ['Mcp(minnow:*)']);
  assert.ok(cursorConfig.permissions.deny.includes('Shell(*)'));
  assert.equal(cursor.env.CURSOR_CONFIG_DIR, path.join(tempDir, 'cursor-config'));
});

test('maps CLI effort, budget, and scoped credentials', async () => {
  const claude = await prepareAgentCliInvocation({
    ...common, kind: 'claude', profile: { maxBudgetUsd: 2.5 },
    body: { reasoning_effort: 'max' }, secrets: { cliToken: 'test-claude-token' },
  });
  assert.equal(claude.env.ANTHROPIC_API_KEY, 'test-claude-token');
  assert.ok(claude.args.includes('--max-budget-usd'));
  assert.ok(claude.args.includes('max'));
  const codex = await prepareAgentCliInvocation({
    ...common, kind: 'codex', body: { reasoning_effort: 'off' }, secrets: { cliToken: 'test-codex-token' },
  });
  assert.equal(codex.env.OPENAI_API_KEY, 'test-codex-token');
  assert.ok(codex.args.includes('model_reasoning_effort="low"'));
});

test('Codex maps highest effort and leaves unspecified effort to the model default', async () => {
  const max = await prepareAgentCliInvocation({ ...common, kind: 'codex', body: { reasoning_effort: 'max' } });
  assert.ok(max.args.includes('model_reasoning_effort="xhigh"'));
  const defaults = await prepareAgentCliInvocation({ ...common, kind: 'codex' });
  assert.ok(!defaults.args.some(arg => arg.startsWith('model_reasoning_effort=')));
});

test('Claude preserves a configured credential directory and enforces the saved budget cap', async () => {
  const original = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = path.join(tempDir, 'custom-claude');
  try {
    const result = await prepareAgentCliInvocation({ ...common, kind: 'claude', profile: { maxBudgetUsd: 2 }, body: { max_budget_usd: 20 } });
    assert.equal(result.env.CLAUDE_CONFIG_DIR, process.env.CLAUDE_CONFIG_DIR);
    assert.equal(result.args[result.args.indexOf('--max-budget-usd') + 1], '2');
  } finally {
    if (original == null) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = original;
  }
});

test('Codex preserves refreshed login credentials without overwriting a concurrent sign-in', async () => {
  const source = path.join(tempDir, 'test-auth.json');
  const original = JSON.stringify({ tokens: { access_token: 'fake-original' } });
  const refreshed = JSON.stringify({ tokens: { access_token: 'fake-refreshed' } });
  await fs.writeFile(source, original);
  const first = await prepareAgentCliInvocation({ ...common, kind: 'codex', secrets: { codexAuthPath: source } });
  await fs.writeFile(path.join(first.env.CODEX_HOME, 'auth.json'), refreshed);
  await first.cleanup();
  assert.equal(await fs.readFile(source, 'utf8'), refreshed);
  const second = await prepareAgentCliInvocation({ ...common, kind: 'codex', secrets: { codexAuthPath: source } });
  await fs.writeFile(path.join(second.env.CODEX_HOME, 'auth.json'), original);
  await fs.writeFile(source, 'concurrent-sign-in');
  await second.cleanup();
  assert.equal(await fs.readFile(source, 'utf8'), 'concurrent-sign-in');
});

test('keeps only kind-specific ambient auth variables', async () => {
  const original = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-smoke-token';
  try {
    const result = await prepareAgentCliInvocation({ ...common, kind: 'claude' });
    assert.equal(result.env.CLAUDE_CODE_OAUTH_TOKEN, 'oauth-smoke-token');
    assert.equal(result.env.OPENAI_API_KEY, undefined);
  } finally {
    if (original === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = original;
  }
});

test('Cursor keeps a large prompt off argv and on stdin', async () => {
  const prompt = 'x'.repeat(40 * 1024);
  const result = await prepareAgentCliInvocation({ ...common, kind: 'cursor-agent', prompt });
  assert.equal(result.stdin.includes(prompt), true);
  assert.equal(result.args.some((arg) => arg.includes(prompt.slice(0, 32))), false);
  assert.ok(result.stdin.includes(common.systemPrompt));
});

test('Cursor includes system prompt and partial output controls', async () => {
  const result = await prepareAgentCliInvocation({ ...common, kind: 'cursor' });
  assert.ok(result.stdin.includes(common.systemPrompt));
  assert.ok(result.args.includes('--stream-partial-output'));
  assert.ok(result.args.includes('--approve-mcps'));
  assert.ok(result.args.includes('--trust'));
});

test('rejects NUL bytes in prompt', async () => {
  await assert.rejects(
    prepareAgentCliInvocation({ ...common, kind: 'claude', prompt: 'bad\0prompt' }),
    /NUL/,
  );
});

test('the account name reaches the CLI so macOS Keychain logins resolve', async () => {
  const original = process.env.USER;
  process.env.USER = 'keychain-account';
  try {
    for (const kind of ['claude', 'codex', 'cursor']) {
      const result = await prepareAgentCliInvocation({ ...common, kind });
      assert.equal(result.env.USER, 'keychain-account');
    }
  } finally {
    if (original == null) delete process.env.USER;
    else process.env.USER = original;
  }
});
