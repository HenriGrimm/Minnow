/** Build shell-free invocations for supported agent CLIs. */

import path from 'node:path';
import fs from 'node:fs/promises';
import { resolveAgentCliBin, applyAgentNodeEnv } from './resolve-bin.js';
import { MAX_TRANSCRIPT_BYTES } from './prompt.js';

function safeString(value, label, max = 512_000) {
  if (typeof value !== 'string') return '';
  if (value.includes('\0')) throw new Error(`${label} contains NUL bytes`);
  if (Buffer.byteLength(value, 'utf8') > max) throw new Error(`${label} exceeds its size limit`);
  return value;
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function normalizeEffort(kind, value) {
  if (!value) return '';
  if (value === 'off') return kind === 'cursor' ? '' : 'low';
  if (kind === 'codex' && value === 'max') return 'xhigh';
  return value;
}

async function writePrivate(file, data) {
  await fs.writeFile(file, data, { encoding: 'utf8', mode: 0o600 });
  try { await fs.chmod(file, 0o600); } catch { /* Windows */ }
  return file;
}

function bridgeParts(bridgeConfig) {
  const command = safeString(bridgeConfig?.command ?? '', 'bridge command', 4096);
  const args = Array.isArray(bridgeConfig?.args)
    ? bridgeConfig.args.map((arg) => safeString(arg, 'bridge argument', 16_384))
    : [];
  if (!command || args.length === 0) throw new Error('Agent CLI MCP bridge command is required');
  return { command, args };
}

async function prepareClaudeFiles(tempDir, bridgeConfig, systemPrompt) {
  const { command, args } = bridgeParts(bridgeConfig);
  const mcpPath = path.join(tempDir, 'claude-mcp.json');
  await writePrivate(mcpPath, `${JSON.stringify({
    mcpServers: {
      minnow: { command, args, ...(bridgeConfig.env ? { env: bridgeConfig.env } : {}) },
    },
  }, null, 2)}\n`);
  const systemPath = path.join(tempDir, 'claude-system-prompt.txt');
  await writePrivate(systemPath, systemPrompt);
  return { mcpPath, systemPath };
}

async function prepareCodexHome(tempDir, bridgeConfig, secrets) {
  const home = path.join(tempDir, 'codex-home');
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  const { command, args } = bridgeParts(bridgeConfig);
  const envLines = Object.entries(bridgeConfig.env ?? {})
    .filter(([key, value]) => /^[A-Z_][A-Z0-9_]*$/i.test(key) && typeof value === 'string')
    .map(([key, value]) => `${tomlString(key)} = ${tomlString(value)}`)
    .join(', ');
  const argLines = args.map(tomlString).join(', ');
  const config = [
    'cli_auth_credentials_store = "file"',
    'approval_policy = "never"',
    'web_search = "disabled"',
    '[tools]',
    'experimental_request_user_input = { enabled = false }',
    '[features]',
    'shell_tool = false',
    'unified_exec = false',
    'hooks = false',
    'memories = false',
    'multi_agent = false',
    'skill_mcp_dependency_install = false',
    '[mcp_servers.minnow]',
    'enabled = true',
    // This bridge only yields a request; Minnow applies execution approvals later.
    'default_tools_approval_mode = "approve"',
    `command = ${tomlString(command)}`,
    `args = [${argLines}]`,
    ...(envLines ? [`env = { ${envLines} }`] : []),
    'required = true',
  ].join('\n') + '\n';
  await writePrivate(path.join(home, 'config.toml'), config);

  const requestedAuth = typeof secrets?.codexAuthPath === 'string' ? secrets.codexAuthPath : '';
  const sourceHome = process.env.CODEX_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '', '.codex');
  const authPath = requestedAuth || path.join(sourceHome, 'auth.json');
  let initialAuth = null;
  let copiedAuth = false;
  if (authPath && path.resolve(authPath) !== path.resolve(path.join(home, 'auth.json'))) {
    try {
      initialAuth = await fs.readFile(authPath);
      await fs.writeFile(path.join(home, 'auth.json'), initialAuth, { mode: 0o600 });
      try { await fs.chmod(path.join(home, 'auth.json'), 0o600); } catch { /* Windows */ }
      copiedAuth = true;
    } catch (err) {
      if (requestedAuth) throw new Error(`Configured Codex auth file is unavailable: ${authPath}`);
      if (err?.code !== 'ENOENT') throw err;
    }
  }
  return {
    home,
    syncAuth: async () => {
      if (!copiedAuth || !initialAuth) return;
      let refreshed;
      try { refreshed = await fs.readFile(path.join(home, 'auth.json')); } catch { return; }
      if (Buffer.compare(refreshed, initialAuth) === 0) return;
      let current;
      try { current = await fs.readFile(authPath); } catch { return; }
      if (Buffer.compare(current, initialAuth) !== 0) return;
      const temp = `${authPath}.minnow-sync-${process.pid}-${Date.now()}`;
      await fs.writeFile(temp, refreshed, { mode: 0o600 });
      try { await fs.chmod(temp, 0o600); } catch { /* Windows */ }
      await fs.rename(temp, authPath).catch(async () => { await fs.rm(temp, { force: true }); });
    },
  };
}

async function prepareCursorFiles(tempDir, bridgeConfig) {
  const { command, args } = bridgeParts(bridgeConfig);
  const configDir = path.join(tempDir, 'cursor-config');
  const projectDir = path.join(tempDir, '.cursor');
  await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(projectDir, { recursive: true, mode: 0o700 });
  const mcp = { mcpServers: { minnow: { command, args, ...(bridgeConfig.env ? { env: bridgeConfig.env } : {}) } } };
  await writePrivate(path.join(projectDir, 'mcp.json'), `${JSON.stringify(mcp, null, 2)}\n`);
  await writePrivate(path.join(configDir, 'cli-config.json'), `${JSON.stringify({
    version: 1,
    editor: { vimMode: false },
    permissions: {
      allow: ['Mcp(minnow:*)'],
      deny: ['Shell(*)', 'Read(**)', 'Write(**)', 'WebFetch(*)'],
    },
  }, null, 2)}\n`);
  return configDir;
}

function scopedEnv(bridgeConfig = {}, kind, secrets = {}) {
  const allowed = [
    'PATH', 'Path', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP',
    'SystemRoot', 'COMSPEC', 'ComSpec', 'LANG', 'LC_ALL', 'TERM', 'TERM_PROGRAM',
    // Claude Code reads its macOS Keychain login under the account named by USER;
    // without it the CLI reports "not logged in" despite a valid session.
    'USER', 'LOGNAME',
  ];
  const env = {};
  for (const key of allowed) if (typeof process.env[key] === 'string') env[key] = process.env[key];
  if (kind === 'claude' && process.env.CLAUDE_CONFIG_DIR) env.CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;
  for (const [key, value] of Object.entries(bridgeConfig.env ?? {})) {
    if (/^[A-Z_][A-Z0-9_]*$/i.test(key) && typeof value === 'string' && value.length <= 4096) env[key] = value;
  }
  if (typeof bridgeConfig.codexHome === 'string' && bridgeConfig.codexHome) env.CODEX_HOME = bridgeConfig.codexHome;
  if (typeof bridgeConfig.cursorConfigDir === 'string' && bridgeConfig.cursorConfigDir) env.CURSOR_CONFIG_DIR = bridgeConfig.cursorConfigDir;
  if (typeof bridgeConfig.claudeConfigDir === 'string' && bridgeConfig.claudeConfigDir) env.CLAUDE_CONFIG_DIR = bridgeConfig.claudeConfigDir;
  const cliToken = typeof secrets.cliToken === 'string' ? secrets.cliToken.trim() : '';
  const authKeys = kind === 'claude'
    ? ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']
    : kind === 'codex' ? ['OPENAI_API_KEY', 'CODEX_API_KEY'] : ['CURSOR_API_KEY'];
  for (const key of authKeys) if (typeof process.env[key] === 'string' && process.env[key]) env[key] = process.env[key];
  if (cliToken) env[authKeys[0]] = cliToken;
  return env;
}

/**
 * @param {{ kind: 'claude'|'codex'|'cursor-agent', profile?: object, body?: object, tempDir: string, prompt: string, systemPrompt?: string, bridgeConfig?: object, secrets?: object, signal?: AbortSignal }} input
 */
export async function prepareAgentCliInvocation(input) {
  const kind = input.kind === 'cursor-agent' ? 'cursor' : input.kind;
  const profile = input.profile && typeof input.profile === 'object' ? input.profile : {};
  const bin = await resolveAgentCliBin({ kind: kind === 'cursor' ? 'cursor-agent' : kind, binPath: profile.binPath });
  const cwd = path.resolve(safeString(input.tempDir, 'tempDir', 4096));
  const prompt = safeString(input.prompt, 'prompt', MAX_TRANSCRIPT_BYTES);
  const systemPrompt = safeString(input.systemPrompt ?? '', 'systemPrompt', MAX_TRANSCRIPT_BYTES);
  if (Buffer.byteLength(prompt) + Buffer.byteLength(systemPrompt) > MAX_TRANSCRIPT_BYTES) throw new Error('Agent CLI transcript exceeds 8 MB.');
  const args = [...bin.argsPrefix];
  let cleanup;
  let stdin = '';
  const model = safeString(input.body?.model ?? profile.modelId ?? '', 'model', 256);
  const effort = normalizeEffort(kind, safeString(input.body?.reasoning_effort ?? profile.effort ?? '', 'effort', 32).toLowerCase());

  if (kind === 'claude') {
    args.push('--print', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--input-format', 'stream-json', '--tools', '', '--allowedTools', 'mcp__minnow__*', '--setting-sources', '',
      '--no-session-persistence', '--strict-mcp-config', '--no-chrome',
      // Headless stream-json defaults to omitted thinking: blocks arrive with
      // empty text. Request summaries so Minnow can show live reasoning.
      '--thinking-display', 'summarized');
    const files = await prepareClaudeFiles(cwd, input.bridgeConfig ?? {}, systemPrompt);
    args.push('--mcp-config', files.mcpPath, '--system-prompt-file', files.systemPath);
    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);
    const configuredBudgetUsd = Number(profile.maxBudgetUsd);
    const requestedBudgetUsd = Number(input.body?.max_budget_usd);
    const maxBudgetUsd = Number.isFinite(configuredBudgetUsd) && configuredBudgetUsd > 0
      ? (Number.isFinite(requestedBudgetUsd) && requestedBudgetUsd > 0
        ? Math.min(configuredBudgetUsd, requestedBudgetUsd)
        : configuredBudgetUsd)
      : requestedBudgetUsd;
    if (Number.isFinite(maxBudgetUsd) && maxBudgetUsd > 0) args.push('--max-budget-usd', String(maxBudgetUsd));
    const imageRows = Array.isArray(input.body?.agentCliImages)
      ? input.body.agentCliImages
          .filter((row) => row && typeof row === 'object')
          .slice(0, 16)
          .map((row) => ({
            type: 'image',
            source: {
              type: 'base64',
              media_type: typeof row.source?.media_type === 'string'
                ? row.source.media_type
                : (typeof row.media_type === 'string' ? row.media_type : 'image/png'),
              data: safeString(row.source?.data ?? row.data ?? '', 'image data', 16 * 1024 * 1024),
            },
          }))
          .filter((row) => row.source.data)
      : [];
    const content = imageRows.length > 0 ? [{ type: 'text', text: prompt }, ...imageRows] : prompt;
    stdin = `${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`;
  } else if (kind === 'codex') {
    const codexState = await prepareCodexHome(cwd, input.bridgeConfig ?? {}, input.secrets ?? {});
    const codexHome = codexState.home;
    cleanup = codexState.syncAuth;
    // Codex treats model, config, disable, approval, and sandbox as global
    // options; placing them after `exec` makes the installed CLI reject them.
    args.push('--ask-for-approval', 'never', '--sandbox', 'read-only');
    for (const feature of [
      'shell_tool', 'unified_exec',
      'hooks', 'memories', 'multi_agent', 'skill_mcp_dependency_install', 'apps',
      'browser_use', 'browser_use_external', 'browser_use_full_cdp_access', 'computer_use',
      'image_generation', 'in_app_browser', 'in_app_local_automation', 'request_permissions_tool',
      'default_mode_request_user_input', 'sleep_tool', 'view_image', 'workspace_dependencies',
      'plugins', 'plugin_sharing', 'tool_suggest', 'skill_search',
    ]) {
      args.push('--disable', feature);
    }
    if (model) args.push('--model', model);
    if (effort) args.push('--config', `model_reasoning_effort=${tomlString(effort)}`);
    args.push('exec', '--json', '--ephemeral', '--skip-git-repo-check', '--ignore-rules', '-');
    stdin = systemPrompt ? `${systemPrompt}\n\n${prompt}\n` : `${prompt}\n`;
    input.bridgeConfig = { ...(input.bridgeConfig ?? {}), codexHome };
  } else {
    // Cursor's --print mode treats --print as a boolean and the prompt as an
    // optional positional. When that positional is omitted and stdin is not a
    // TTY, build-prompt.ts reads stdin to EOF. Putting the transcript on argv
    // hit Windows CreateProcess limits (~32 KiB) and rejected ordinary Minnow
    // turns at 24 KiB. Keep the prompt off argv on every platform.
    const cursorPrompt = systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
    const configDir = await prepareCursorFiles(cwd, input.bridgeConfig ?? {});
    input.bridgeConfig = { ...(input.bridgeConfig ?? {}), cursorConfigDir: configDir };
    args.push(
      '--print',
      '--output-format', 'stream-json',
      '--stream-partial-output',
      '--approve-mcps',
      // Headless scratch dirs are not a TTY; without --trust the CLI can block
      // on the workspace-trust prompt instead of running the turn.
      '--trust',
    );
    if (model) args.push('--model', model);
    // Cursor's documented CLI has no effort flag; its isolated config is
    // selected through CURSOR_CONFIG_DIR in the returned environment.
    stdin = cursorPrompt;
  }

  const env = applyAgentNodeEnv(scopedEnv(input.bridgeConfig, kind, input.secrets), bin.command);
  if (input.bridgeConfig?.mcpConfigPath) env.MINNOW_AGENT_MCP_CONFIG = String(input.bridgeConfig.mcpConfigPath);
  return {
    kind, command: bin.command, args, env, cwd, stdin,
    shell: false, windowsHide: true, signal: input.signal,
    display: bin.display,
    cleanup,
  };
}
