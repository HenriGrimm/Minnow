import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runProcess } from '../process-runner.js';
import { fetchCodexModelCatalog, clearCodexModelCatalogCache } from './codex-cli-catalog.js';
import { fetchClaudeModelCatalog, clearClaudeModelCatalogCache } from './claude-cli-catalog.js';
import { applyAgentCliContextWindow } from './agent-cli-context.js';
import {
  applyAgentCliCaptureEnv,
  findAgentCliOnPath,
  resolveAgentCliBin,
  stripAnsiFromCliText,
} from '../generations/agent-cli/resolve-bin.js';
import {
  CLAUDE_CODE_CLI_ID,
  CODEX_CLI_ID,
  CURSOR_AGENT_CLI_ID,
} from '../../src/models/runtime-ids.mjs';
import { cursorReasoningForModels } from '../../src/models/cursor-variants.mjs';

const CURSOR_INSTALL_POSIX = 'curl https://cursor.com/install -fsS | bash';
const CURSOR_INSTALL_POWERSHELL = "irm 'https://cursor.com/install?win32=true' | iex";
const CURSOR_INSTALL_CMD =
  'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm \'https://cursor.com/install?win32=true\' | iex"';

export const AGENT_CLI_DEFINITIONS = Object.freeze({
  claude: Object.freeze({
    kind: 'claude',
    providerId: CLAUDE_CODE_CLI_ID,
    label: 'Claude Code',
    command: 'claude',
    installCommand: 'npm install -g @anthropic-ai/claude-code',
    loginCommand: 'claude auth login',
    updateCommand: 'claude update',
    versionArgs: ['--version'],
    authArgs: ['auth', 'status', '--json'],
  }),
  codex: Object.freeze({
    kind: 'codex',
    providerId: CODEX_CLI_ID,
    label: 'Codex CLI',
    command: 'codex',
    installCommand: 'npm install -g @openai/codex',
    loginCommand: 'codex -c cli_auth_credentials_store=file login',
    updateCommand: 'codex update',
    versionArgs: ['--version'],
    authArgs: ['-c', 'cli_auth_credentials_store=file', 'login', 'status'],
  }),
  cursor: Object.freeze({
    kind: 'cursor',
    providerId: CURSOR_AGENT_CLI_ID,
    label: 'Cursor Agent',
    command: 'cursor-agent',
    installCommand: CURSOR_INSTALL_POSIX,
    loginCommand: 'cursor-agent login',
    updateCommand: 'cursor-agent update',
    versionArgs: ['--version'],
    authArgs: ['status'],
  }),
});

function isPowerShellShell(shell) {
  return /\b(?:pwsh|powershell)(?:\.exe)?$/i.test(shell ?? '');
}

function isCmdShell(shell) {
  return /\bcmd(?:\.exe)?$/i.test(shell ?? '');
}

/**
 * Official vendor install one-liner for the given CLI and shell.
 * Cursor's curl installer is POSIX-only; native Windows needs PowerShell.
 * @param {string} kind
 * @param {{ platform?: NodeJS.Platform, shell?: string }} [options]
 */
export function getAgentCliInstallCommand(kind, options = {}) {
  const definition = getAgentCliDefinition(kind);
  if (definition.kind !== 'cursor') return definition.installCommand;
  const shell = options.shell;
  if (isPowerShellShell(shell)) return CURSOR_INSTALL_POWERSHELL;
  if (isCmdShell(shell)) return CURSOR_INSTALL_CMD;
  const platform = options.platform ?? process.platform;
  if (!shell && platform === 'win32') return CURSOR_INSTALL_POWERSHELL;
  return CURSOR_INSTALL_POSIX;
}

const PROVIDER_TO_KIND = new Map(
  Object.values(AGENT_CLI_DEFINITIONS).map((definition) => [definition.providerId, definition.kind]),
);

/** @param {unknown} kind */
export function getAgentCliDefinition(kind) {
  if (typeof kind !== 'string' || !Object.hasOwn(AGENT_CLI_DEFINITIONS, kind)) {
    throw new Error('Invalid agent CLI kind');
  }
  return AGENT_CLI_DEFINITIONS[kind];
}

/** @param {unknown} providerId */
export function agentCliKindForProviderId(providerId) {
  return typeof providerId === 'string' ? PROVIDER_TO_KIND.get(providerId) ?? null : null;
}

const CATALOGS = Object.freeze({
  claude: Object.freeze([
    Object.freeze({ id: 'sonnet', max_context_length: 200_000, reasoning: 'adaptive' }),
    Object.freeze({ id: 'opus', max_context_length: 200_000, reasoning: 'adaptive' }),
    Object.freeze({ id: 'haiku', max_context_length: 200_000, reasoning: 'none' }),
  ]),
  codex: Object.freeze([
    Object.freeze({ id: 'gpt-5.3-codex', max_context_length: 400_000, reasoning: 'adaptive' }),
  ]),
  cursor: Object.freeze([
    Object.freeze({ id: 'auto', max_context_length: 200_000, reasoning: 'none' }),
    Object.freeze({ id: 'composer-2.5', max_context_length: 200_000, reasoning: 'none' }),
    Object.freeze({ id: 'composer-2.5-fast', max_context_length: 200_000, reasoning: 'none' }),
    Object.freeze({ id: 'cursor-grok-4.6-high', max_context_length: 200_000, reasoning: 'none' }),
    Object.freeze({ id: 'cursor-grok-4.6-high-fast', max_context_length: 200_000, reasoning: 'none' }),
    Object.freeze({ id: 'gpt-5.3-codex', max_context_length: 200_000, reasoning: 'none' }),
    Object.freeze({ id: 'gpt-5.3-codex-high', max_context_length: 200_000, reasoning: 'none' }),
    Object.freeze({ id: 'gpt-5.2', max_context_length: 200_000, reasoning: 'none' }),
    Object.freeze({ id: 'claude-opus-5-thinking-high', max_context_length: 1_000_000, reasoning: 'none' }),
    Object.freeze({ id: 'claude-sonnet-5-thinking-high', max_context_length: 1_000_000, reasoning: 'none' }),
    Object.freeze({ id: 'gpt-5.6-sol-high', max_context_length: 1_000_000, reasoning: 'none' }),
    Object.freeze({ id: 'gemini-3.7-flash-high', max_context_length: 200_000, reasoning: 'none' }),
  ]),
});

function claudeVersionAtLeast(version, major, minor, patch) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:\D|$)/.exec(version ?? '');
  if (!match) return false;
  const parts = match.slice(1).map(Number);
  const minimum = [major, minor, patch];
  for (let index = 0; index < parts.length; index += 1) {
    if (parts[index] !== minimum[index]) return parts[index] > minimum[index];
  }
  return true;
}

/** Pinned choices only use versions supported by the installed Claude Code CLI. */
function claudeCatalogForVersion(version) {
  // Unknown CLI versions cannot safely be matched to Anthropic release gates.
  if (!/^2\.1\.\d+(?:\D|$)/.test(version ?? '') && !/^\d+\.\d+\.\d+\s+\(Claude Code\)/.test(version ?? '')) {
    return CATALOGS.claude;
  }
  const opus = claudeVersionAtLeast(version, 2, 1, 280)
    ? { id: 'claude-opus-5-5', max_context_length: 1_000_000, reasoning: 'adaptive', reasoningDefault: 'medium' }
    : claudeVersionAtLeast(version, 2, 1, 219)
      ? { id: 'claude-opus-5', max_context_length: 1_000_000, reasoning: 'adaptive' }
      : claudeVersionAtLeast(version, 2, 1, 154)
        ? { id: 'claude-opus-4-8', max_context_length: 1_000_000, reasoning: 'adaptive' }
        : { id: 'claude-opus-4-6', max_context_length: 200_000, reasoning: 'adaptive' };
  const sonnet = claudeVersionAtLeast(version, 2, 1, 284)
    ? { id: 'claude-sonnet-5-5', max_context_length: 1_000_000, reasoning: 'adaptive' }
    : claudeVersionAtLeast(version, 2, 1, 197)
      ? { id: 'claude-sonnet-5', max_context_length: 1_000_000, reasoning: 'adaptive' }
      : { id: 'claude-sonnet-4-6', max_context_length: 200_000, reasoning: 'adaptive' };
  const haiku = claudeVersionAtLeast(version, 2, 1, 293)
    ? { id: 'claude-haiku-5-5', max_context_length: 1_000_000, reasoning: 'adaptive', reasoningDefault: 'medium' }
    : { id: 'claude-haiku-4-5', max_context_length: 200_000, reasoning: 'none' };
  return [
    ...CATALOGS.claude.map((entry) => {
      const resolved = entry.id === 'sonnet' ? sonnet : entry.id === 'opus' ? opus : haiku;
      const version = resolved.id.replace(/^claude-(?:sonnet|opus|haiku)-/, '').replace(/-(\d+)$/, '.$1');
      const family = entry.id.charAt(0).toUpperCase() + entry.id.slice(1);
      return {
        ...entry,
        reasoning: resolved.reasoning,
        max_context_length: resolved.max_context_length,
        display_name: `Claude ${family} ${version} (CLI default)`,
        ...(resolved.reasoningDefault ? { reasoningDefault: resolved.reasoningDefault } : {}),
      };
    }),
    sonnet,
    opus,
    haiku,
  ];
}

/** `cursor-agent --list-models` is catalog discovery, not a billed inference call. */
const CURSOR_LIST_MODELS_TIMEOUT_MS = 15_000;
const CURSOR_LIST_MODELS_TTL_MS = 5 * 60 * 1000;
const CURSOR_LIST_LINE = /^([a-z0-9][a-z0-9._-]*)\s+-\s+(\S.*)$/i;
const cursorListCache = new Map();
const cursorListInflight = new Map();

/**
 * Parse `cursor-agent --list-models` text into catalog entries.
 * Lines look like `auto - Auto (default)` or `claude-opus-5-thinking-high - Claude Opus 5 1M Thinking`.
 * @param {unknown} text
 * @returns {Array<{ id: string, max_context_length: number, reasoning: 'none' }>}
 */
export function parseCursorListModels(text) {
  const rows = [];
  const seen = new Set();
  for (const raw of stripAnsiFromCliText(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^available models$/i.test(line)) continue;
    const match = CURSOR_LIST_LINE.exec(line);
    if (!match) continue;
    const id = match[1];
    if (seen.has(id)) continue;
    seen.add(id);
    const label = match[2].replace(/\s+\(default\)\s*$/i, '').trim();
    rows.push({
      id,
      max_context_length: /1m\b/i.test(`${id} ${label}`) ? 1_000_000
        : CATALOGS.cursor.find((entry) => entry.id === id)?.max_context_length ?? 200_000,
      reasoning: 'none',
    });
  }
  return rows;
}

export function resetAgentCliCatalogCacheForTests() {
  clearAgentCliModelCatalogCache();
  cursorListInflight.clear();
}

/** Verification/update scans must not keep a catalog from before the scan. */
export function clearAgentCliModelCatalogCache(kind) {
  if (!kind || kind === 'claude') clearClaudeModelCatalogCache();
  if (!kind || kind === 'codex') clearCodexModelCatalogCache();
  if (!kind || kind === 'cursor') cursorListCache.clear();
}

/**
 * Ask the installed Cursor CLI for the account catalog. Never starts a chat.
 * @param {{ binPath?: string, cliToken?: string, env?: NodeJS.ProcessEnv, homeDir?: string }} [options]
 */
async function fetchCursorListModelsText(options = {}) {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const requested = typeof options.binPath === 'string' ? options.binPath.trim() : '';
  const binPath = requested || await findAgentCliOnPath('cursor-agent', { env, homeDir });
  if (!binPath) return '';
  const cacheKey = createHash('sha256').update(JSON.stringify([
    binPath, homeDir, options.cliVersion, options.cliToken, env.CURSOR_CONFIG_DIR, env.CURSOR_API_KEY,
  ])).digest('hex');
  const cached = cursorListCache.get(cacheKey);
  if (!options.refresh && cached && Date.now() - cached.at < CURSOR_LIST_MODELS_TTL_MS) return cached.text;
  const pending = cursorListInflight.get(cacheKey);
  if (pending) return pending;

  const work = (async () => {
    let resolved;
    try {
      resolved = await resolveAgentCliBin({ kind: 'cursor-agent', binPath, env, homeDir });
    } catch {
      return '';
    }
    const runEnv = applyAgentCliCaptureEnv(env, resolved.command);
    const cliToken = typeof options.cliToken === 'string' ? options.cliToken.trim() : '';
    if (cliToken) runEnv.CURSOR_API_KEY = cliToken;
    try {
      const result = await runProcess(
        resolved.command,
        [...resolved.argsPrefix, '--list-models'],
        { timeout: CURSOR_LIST_MODELS_TIMEOUT_MS, env: runEnv },
      );
      const stdout = stripAnsiFromCliText(result.stdout);
      const stderr = stripAnsiFromCliText(result.stderr);
      const text = result.code === 0
        ? (stdout || stderr)
        : (parseCursorListModels(stdout).length > 0 ? stdout : '');
      if (text) cursorListCache.set(cacheKey, { at: Date.now(), text });
      return text;
    } catch {
      return '';
    }
  })();

  cursorListInflight.set(cacheKey, work);
  try {
    return await work;
  } finally {
    cursorListInflight.delete(cacheKey);
  }
}

const REASONING = Object.freeze({
  claude: Object.freeze({ allowed_options: ['off', 'low', 'medium', 'high', 'max'], default: 'high' }),
  codex: Object.freeze({ allowed_options: ['low', 'medium', 'high', 'max'], default: 'medium' }),
  cursor: Object.freeze({ allowed_options: [], default: 'off' }),
});

/**
 * Static, subscription-free model rows. This function never starts a CLI process.
 * @param {string} providerId
 * @param {{ cliVersion?: string }} [options]
 */
export function listAgentCliModels(providerId, options = {}) {
  const kind = agentCliKindForProviderId(providerId);
  if (!kind) throw new Error('Not an agent CLI provider');
  const catalog = kind === 'claude' ? claudeCatalogForVersion(options.cliVersion) : CATALOGS[kind];
  const rows = catalog.map(({ reasoningDefault, ...entry }) => ({
    ...entry,
    type: 'llm',
    state: 'loaded',
    owned_by: kind === 'claude' ? 'anthropic' : kind === 'codex' ? 'openai' : 'cursor',
    api: 'agent-cli-v1',
    catalogVision: kind !== 'cursor',
    reasoning: entry.reasoning === 'adaptive'
      ? { ...REASONING[kind], ...(reasoningDefault ? { default: reasoningDefault,
        allowed_options: REASONING[kind].allowed_options.filter(value => value !== 'off') } : {}) }
      : REASONING.cursor,
  }));
  return kind === 'cursor' ? cursorReasoningForModels(rows) : rows;
}

const MINNOW_REASONING_OPTIONS = new Set(['off', 'low', 'medium', 'high', 'max']);

/** @param {unknown} raw */
function normalizeCodexReasoning(raw, advertisedDefault) {
  if (!Array.isArray(raw)) return REASONING.codex;
  const options = raw
    .map((entry) => typeof entry === 'string' ? entry : entry?.effort)
    .map((value) => value === 'xhigh' ? 'max' : value)
    .filter((value) => typeof value === 'string' && MINNOW_REASONING_OPTIONS.has(value));
  const allowed_options = [...new Set(options)];
  return {
    allowed_options: allowed_options.length > 0 ? allowed_options : REASONING.codex.allowed_options,
    default: allowed_options.includes(advertisedDefault === 'xhigh' ? 'max' : advertisedDefault)
      ? (advertisedDefault === 'xhigh' ? 'max' : advertisedDefault)
      : allowed_options.includes('medium') ? 'medium' : allowed_options[0] ?? REASONING.codex.default,
  };
}

/**
 * Discover installed CLI catalogs without submitting a prompt or spending inference.
 * Claude and Cursor retain version-aware/static fallbacks for older CLIs.
 * @param {string} providerId
 * @param {{ env?: NodeJS.ProcessEnv, homeDir?: string, binPath?: string, cliToken?: string, cliVersion?: string, codexAuthPath?: string, listModelsText?: string, refresh?: boolean }} [options]
 */
export async function listAgentCliModelsWithConfig(providerId, options = {}) {
  const kind = agentCliKindForProviderId(providerId);
  const applyContext = (rows) => applyAgentCliContextWindow(rows, kind, options.contextWindowTokens);
  const staticRows = listAgentCliModels(providerId, options);
  if (providerId === CLAUDE_CODE_CLI_ID && options.binPath) {
    try {
      const rows = claudeCatalogRows(await fetchClaudeModelCatalog(options), staticRows);
      if (rows.length) return applyContext(rows);
    } catch {
      // Older CLIs may not expose SDK model metadata.
    }
    return applyContext(staticRows);
  }
  if (providerId === CURSOR_AGENT_CLI_ID) {
    const text = typeof options.listModelsText === 'string'
      ? options.listModelsText
      : await fetchCursorListModelsText(options);
    const parsed = parseCursorListModels(text);
    if (parsed.length === 0) return applyContext(staticRows);
    return applyContext(cursorReasoningForModels(parsed.map((entry) => ({
      ...entry,
      type: 'llm',
      state: 'loaded',
      owned_by: 'cursor',
      api: 'agent-cli-v1',
      catalogVision: false,
      reasoning: REASONING.cursor,
    }))));
  }
  if (providerId !== CODEX_CLI_ID) return applyContext(staticRows);
  return applyContext(codexCatalogRows(await fetchCodexModelCatalog(options)));
}

/** Keep CLI model values for requests, adding pinned IDs only when the CLI resolves them. */
export function claudeCatalogRows(models, fallback = []) {
  const rows = new Map();
  for (const model of models) {
    if (!model || typeof model !== 'object' || model.disabled === true) continue;
    const id = typeof model.value === 'string' ? model.value.trim() : '';
    if (!id || id === 'default' || rows.has(id)) continue;
    const resolved = typeof model.resolvedModel === 'string' ? model.resolvedModel.trim() : id;
    const known = fallback.find(row => row.id === resolved)
      ?? (!model.resolvedModel ? fallback.find(row => row.id === id) : undefined);
    const native1m = /^claude-(?:sonnet-5|opus-(?:4-[789]|5)|haiku-5-5|fable-5)/i.test(resolved);
    const advertisedContext = Number(model.contextWindow ?? model.context_window);
    const allowed_options = model.supportsEffort === true
      ? [...new Set((Array.isArray(model.supportedEffortLevels) ? model.supportedEffortLevels : REASONING.claude.allowed_options)
        .map(value => value === 'xhigh' ? 'max' : value).filter(value => MINNOW_REASONING_OPTIONS.has(value) && value !== 'off'))]
      : model.supportsEffort === false ? [] : known?.reasoning?.allowed_options ?? [];
    const preferred = model.defaultEffort
      ?? (/^claude-(?:opus|sonnet|haiku)-5-5/.test(resolved) ? 'medium' : known?.reasoning?.default ?? 'high');
    const label = typeof model.displayName === 'string' ? model.displayName.trim() : '';
    const name = label ? (/^Claude\b/i.test(label) ? label : `Claude ${label}`) : undefined;
    const row = { id, type: 'llm', state: 'loaded', owned_by: 'anthropic', api: 'agent-cli-v1',
      catalogVision: true,
      max_context_length: Number.isFinite(advertisedContext) && advertisedContext > 0
        ? advertisedContext : known?.max_context_length ?? (native1m ? 1_000_000 : 200_000),
      ...(name ? { display_name: `${name}${id !== resolved || /^(?:sonnet|opus|haiku|fable)$/.test(id) ? ' (CLI default)' : ''}` } : {}),
      reasoning: { allowed_options, default: allowed_options.includes(preferred) ? preferred : allowed_options[0] ?? 'off' },
    };
    rows.set(id, row);
    if (resolved && resolved !== id && !rows.has(resolved)) {
      rows.set(resolved, { ...row, id: resolved, ...(name ? { display_name: name } : {}) });
    }
  }
  return [...rows.values()];
}

export function codexCatalogRows(models) {
  const rows = models
    .filter((model) => model && typeof model === 'object' && model.visibility === 'list')
    .map((model) => {
      const id = typeof model.slug === 'string' ? model.slug.trim() : '';
      if (!id) return null;
      const context = Number(model.context_window);
      return {
        id,
        ...(typeof model.display_name === 'string' ? { display_name: model.display_name } : {}),
        type: 'llm',
        state: 'loaded',
        owned_by: 'openai',
        api: 'agent-cli-v1',
        catalogVision: !Array.isArray(model.input_modalities) || model.input_modalities.includes('image'),
        ...(Number.isFinite(context) && context > 0 ? { max_context_length: context } : {}),
        reasoning: normalizeCodexReasoning(model.supported_reasoning_levels, model.default_reasoning_level),
        ...(Number.isFinite(model.priority) ? { priority: model.priority } : {}),
      };
    })
    .filter(Boolean)
    .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999) || a.id.localeCompare(b.id))
    .map(({ priority: _priority, ...row }) => row);
  return rows;
}

/** @param {Array<Record<string, any>>} rows */
function capabilityPatchesForRows(rows) {
  return Object.fromEntries(
    rows.map((row) => [
      row.id,
      {
        vision: row.catalogVision,
        tools: true,
        streaming: true,
        grammar: false,
        reasoning: row.reasoning.allowed_options.length > 0,
        contextLength: row.max_context_length,
        loadState: 'loaded',
        api: 'agent-cli-v1',
        sources: {
          vision: 'catalog',
          tools: 'assumed',
          streaming: 'assumed',
          grammar: 'assumed',
          reasoning: 'catalog',
          contextLength: 'catalog',
          loadState: 'catalog',
        },
        probeErrors: {},
      },
    ]),
  );
}

/** Static fallback patches for callers that cannot read the Codex model cache. */
export function agentCliCapabilityPatches(providerId) {
  return capabilityPatchesForRows(listAgentCliModels(providerId));
}

/** Model-specific patches, including cheap Codex cache metadata when available. */
export async function agentCliCapabilityPatchesWithConfig(providerId, options = {}) {
  return capabilityPatchesForRows(await listAgentCliModelsWithConfig(providerId, options));
}
