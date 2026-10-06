/** Build shell-free invocations for supported agent CLIs. */

import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { resolveAgentCliBin, applyAgentNodeEnv } from './resolve-bin.js';
import { MAX_TRANSCRIPT_BYTES } from './prompt.js';
import { prepareCodexAuth } from './codex-auth.js';
import { agentCliContextWindowTokens, supportsClaudeExtendedContext } from '../../models/agent-cli-context.js';

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
    // A scratch CODEX_HOME does not inherit the user's display preferences.
    // Request shareable summaries so reasoning is visible in Minnow's stream.
    'model_reasoning_summary = "auto"',
    'hide_agent_reasoning = false',
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

  const syncAuth = await prepareCodexAuth(home, secrets);
  return { home, syncAuth };
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
  let redactionSecrets = [];
  const model = safeString(input.body?.model ?? profile.modelId ?? '', 'model', 256);
  const contextWindow = agentCliContextWindowTokens(profile.contextWindowTokens);
  const effort = normalizeEffort(kind, safeString(input.body?.reasoning_effort ?? profile.effort ?? '', 'effort', 32).toLowerCase());

  if (kind === 'claude') {
    args.push('--print', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--input-format', 'stream-json', '--tools', '', '--allowedTools', 'mcp__minnow__*', '--setting-sources', '',
      ...(input.sessionId ? ['--session-id', input.sessionId] : ['--no-session-persistence']), '--strict-mcp-config', '--no-chrome',
      // Headless stream-json defaults to omitted thinking: blocks arrive with
      // empty text. Request summaries so Minnow can show live reasoning.
      '--thinking-display', 'summarized');
    const files = await prepareClaudeFiles(cwd, input.bridgeConfig ?? {}, systemPrompt);
    if (input.resumeId) {
      const sessionFlag = args.indexOf('--session-id');
      if (sessionFlag !== -1) args.splice(sessionFlag, 2);
      args.push('--resume', input.resumeId);
    }
    args.push('--mcp-config', files.mcpPath, '--system-prompt-file', files.systemPath);
    const extended = contextWindow > 200_000 && supportsClaudeExtendedContext(model);
    // Native 1M models need no suffix; older models and moving aliases do.
    const native1m = /^claude-(?:sonnet-5|opus-(?:4-[789]|5))/i.test(model);
    const claudeModel = extended && !native1m && !model.endsWith('[1m]') ? `${model}[1m]` : model;
    if (claudeModel) args.push('--model', claudeModel);
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
    if (input.interactive) {
      if (Number.isFinite(maxBudgetUsd) && maxBudgetUsd > 0) throw new Error('Claude interactive sessions do not support the CLI dollar budget. Clear the budget in Models → CLIs to use interactive chat.');
      const printFlags = new Map([['--print', 0], ['--output-format', 1], ['--include-partial-messages', 0], ['--input-format', 1], ['--no-session-persistence', 0]]);
      for (let i = args.length - 1; i >= 0; i--) if (printFlags.has(args[i])) args.splice(i, 1 + printFlags.get(args[i]));
      args.push('--permission-mode', 'dontAsk');
    }
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
    if (contextWindow) args.push('--config', `model_context_window=${contextWindow}`);
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
    if (input.acp) {
      const source = path.join(process.env.CURSOR_CONFIG_DIR || path.join(os.homedir(), '.cursor'), 'auth.json');
      const auth = await fs.readFile(source).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (auth) {
        cleanup = await prepareCodexAuth(configDir, { codexAuthPath: source });
        try {
          const collect = value => { for (const [name, entry] of Object.entries(value ?? {})) {
            if (entry && typeof entry === 'object') collect(entry);
            else if (/token|password|api.?key/i.test(name) && typeof entry === 'string') redactionSecrets.push(entry);
          } };
          collect(JSON.parse(auth.toString('utf8')));
        } catch { /* The native CLI validates its credential file. */ }
      }
      args.push('--trust', '--approve-mcps');
      if (model) args.push('--model', model);
      args.push('acp');
    } else args.push(
      '--print',
      '--output-format', 'stream-json',
      '--stream-partial-output',
      '--approve-mcps',
      // Headless scratch dirs are not a TTY; without --trust the CLI can block
      // on the workspace-trust prompt instead of running the turn.
      '--trust',
    );
    if (!input.acp && model) args.push('--model', model);
    // Cursor's documented CLI has no effort flag; its isolated config is
    // selected through CURSOR_CONFIG_DIR in the returned environment.
    stdin = cursorPrompt;
  }

  const env = applyAgentNodeEnv(scopedEnv(input.bridgeConfig, kind, input.secrets), bin.command);
  if (kind === 'cursor' && input.acp) {
    env.HOME = cwd; env.USERPROFILE = cwd;
    env.CURSOR_DATA_DIR = path.join(path.dirname(cwd), 'cursor-data');
    if (process.env.CURSOR_AUTH_TOKEN) env.CURSOR_AUTH_TOKEN = process.env.CURSOR_AUTH_TOKEN;
  }
  if (kind === 'claude') {
    // Minnow owns chat titles. Claude's automatic title request otherwise
    // sends the entire replay transcript to a second, uncached inference.
    env.CLAUDE_CODE_DISABLE_TERMINAL_TITLE = '1';
    env.DISABLE_AUTO_COMPACT = '1';
    if (input.interactive) {
      env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION = 'false';
      env.MCP_CONNECTION_NONBLOCKING = '0';
      env.ENABLE_TOOL_SEARCH = 'false';
      env.DISABLE_AUTOUPDATER = '1';
      env.TERM = 'xterm-256color';
      delete env.CLAUDE_CODE_ENTRYPOINT;
    }
  }
  if (kind === 'claude' && contextWindow) {
    env.CLAUDE_CODE_DISABLE_1M_CONTEXT = contextWindow <= 200_000 ? '1' : '0';
  }
  if (input.bridgeConfig?.mcpConfigPath) env.MINNOW_AGENT_MCP_CONFIG = String(input.bridgeConfig.mcpConfigPath);
  return {
    kind, command: bin.command, args, env, cwd, stdin, redactionSecrets,
    transport: input.interactive ? 'claude-interactive' : input.acp ? 'acp' : 'stream-json',
    ...(input.acp ? { selectedModel: model } : {}),
    keepStdinOpen: Boolean(input.acp) || kind === 'claude' && Boolean(input.sessionId || input.resumeId),
    shell: false, windowsHide: true, signal: input.signal,
    display: bin.display,
    cleanup,
  };
}
