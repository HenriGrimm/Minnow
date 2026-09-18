import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runProcess } from '../process-runner.js';
import {
  applyAgentCliCaptureEnv,
  findAgentCliOnPath,
  resolveAgentCliBin,
  stripAnsiFromCliText,
} from '../generations/agent-cli/resolve-bin.js';
import { getAgentCliDefinition, getAgentCliInstallCommand } from './agent-cli-catalog.js';

export const AGENT_CLI_DETECTION_TTL_MS = 60_000;
const DETECTION_TIMEOUT_MS = 5_000;
const STATUS_CACHE = new Map();

const TOKEN_ENV_KEYS = Object.freeze({
  claude: ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'],
  codex: ['CODEX_API_KEY', 'OPENAI_API_KEY'],
  cursor: ['CURSOR_API_KEY'],
});

/** @param {string} filePath */
async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** @param {string} text */
function firstSafeLine(text) {
  return stripAnsiFromCliText(text).split(/\r?\n/).map((line) => line.trim()).find(Boolean)?.slice(0, 200);
}

/** @param {'claude'|'codex'|'cursor'} kind */
function adapterKind(kind) {
  return kind === 'cursor' ? 'cursor-agent' : kind;
}

/** @param {'claude'|'codex'|'cursor'} kind @param {string} homeDir @param {NodeJS.ProcessEnv} env */
function credentialFiles(kind, homeDir, env) {
  if (kind === 'claude') {
    const root = env.CLAUDE_CONFIG_DIR?.trim() || path.join(homeDir, '.claude');
    return [path.join(root, '.credentials.json'), path.join(root, 'credentials.json')];
  }
  if (kind === 'codex') {
    const root = env.CODEX_HOME?.trim() || path.join(homeDir, '.codex');
    return [path.join(root, 'auth.json')];
  }
  const root = env.CURSOR_CONFIG_DIR?.trim() || path.join(homeDir, '.cursor');
  return [path.join(root, 'auth.json')];
}

/** @param {string} text */
function jsonObjectsFromMixedOutput(text) {
  const candidates = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const broad = String(text || '').match(/\{[\s\S]*\}/)?.[0];
  if (broad) candidates.push(broad);
  const out = [];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') out.push(parsed);
    } catch {
      // Mixed stderr/stdout often has non-JSON diagnostic lines.
    }
  }
  return out;
}

/** @param {string} text */
export function parseAgentCliAuthStatus(text) {
  const normalized = stripAnsiFromCliText(text).trim();
  if (!normalized) return 'unknown';
  for (const parsed of jsonObjectsFromMixedOutput(normalized)) {
    if (parsed.loggedIn === false || parsed.authenticated === false) {
      return 'signed-out';
    }
    if (parsed.loggedIn === true || parsed.authenticated === true) {
      return 'signed-in';
    }
    if (typeof parsed.status === 'string') {
      if (/^(logged[_ -]?in|signed[_ -]?in|authenticated)$/i.test(parsed.status.trim())) return 'signed-in';
      if (/^(logged[_ -]?out|signed[_ -]?out|unauthenticated)$/i.test(parsed.status.trim())) return 'signed-out';
    }
  }
  if (/not logged in|not authenticated|signed out|login required|unauthenticated/i.test(normalized)) {
    return 'signed-out';
  }
  if (/logged in|authenticated|signed in/i.test(normalized)) return 'signed-in';
  return 'unknown';
}

/**
 * Passive detection checks PATH, environment names, and credential-file existence only.
 * It never reads credential contents and never sends an inference request.
 * @param {'claude'|'codex'|'cursor'} kind
 * @param {{ binPath?: string, cliToken?: string, fresh?: boolean, homeDir?: string, env?: NodeJS.ProcessEnv }} [options]
 */
export async function detectAgentCli(kind, options = {}) {
  const definition = getAgentCliDefinition(kind);
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const hasToken = Boolean(
    (typeof options.cliToken === 'string' && options.cliToken.trim()) ||
    TOKEN_ENV_KEYS[kind].some((key) => typeof env[key] === 'string' && env[key]?.trim()),
  );
  const files = credentialFiles(kind, homeDir, env);
  const cacheKey = `${kind}:${options.binPath || ''}:${homeDir}:${files.join('|')}:${hasToken}`;
  const now = Date.now();
  const cached = STATUS_CACHE.get(cacheKey);
  if (!options.fresh && cached && now - cached.at < AGENT_CLI_DETECTION_TTL_MS) return cached.value;

  const configuredPath = typeof options.binPath === 'string' && options.binPath.trim()
    ? options.binPath.trim()
    : '';
  let requestedBin = configuredPath;
  // PATH often omits vendor install dirs for Electron; well-known locations still count.
  if (!requestedBin) requestedBin = await findAgentCliOnPath(adapterKind(kind), { env, homeDir }) || '';
  if (requestedBin && configuredPath && (path.isAbsolute(requestedBin) || /[\\/]/.test(requestedBin))) {
    if (!(await fileExists(requestedBin))) requestedBin = '';
  }
  let resolved = null;
  if (requestedBin) {
    try {
      resolved = await resolveAgentCliBin({ kind: adapterKind(kind), binPath: requestedBin });
    } catch {
      resolved = null;
    }
  }
  const installed = Boolean(resolved);
  const hasCredentialFile = (
    await Promise.all(files.map(fileExists))
  ).some(Boolean);

  let version;
  if (installed) {
    try {
      const result = await runProcess(resolved.command, [...resolved.argsPrefix, ...definition.versionArgs], {
        timeout: DETECTION_TIMEOUT_MS,
        env: applyAgentCliCaptureEnv(env, resolved.command),
      });
      if (result.code === 0) version = firstSafeLine(result.stdout);
    } catch {
      // Installation stays true even when a wrapper cannot report its version.
    }
  }

  const value = {
    kind,
    providerId: definition.providerId,
    label: definition.label,
    installed,
    authStatus: hasToken ? 'token' : hasCredentialFile || installed ? 'unknown' : 'signed-out',
    ...(hasCredentialFile ? { hasCredentialFile: true } : {}),
    ...(version ? { version } : {}),
    ...(resolved ? {
      resolvedBinPath: resolved.display,
      resolvedCommand: resolved.command,
      resolvedArgsPrefix: resolved.argsPrefix,
    } : {}),
    installCommand: getAgentCliInstallCommand(kind),
    loginCommand: definition.loginCommand,
    checkedAt: new Date(now).toISOString(),
  };
  STATUS_CACHE.set(cacheKey, { at: now, value });
  return value;
}

/**
 * Run the CLI's documented account-status command. These commands do not invoke a model.
 * @param {'claude'|'codex'|'cursor'} kind
 * @param {{ binPath?: string, cliToken?: string, homeDir?: string, env?: NodeJS.ProcessEnv }} [options]
 */
export async function verifyAgentCliAuth(kind, options = {}) {
  const passive = await detectAgentCli(kind, { ...options, fresh: true });
  const verifiedAt = new Date().toISOString();
  if (!passive.installed || !passive.resolvedCommand || passive.authStatus === 'token') {
    const value = { ...passive, verifiedAt };
    for (const [cacheKey, cached] of STATUS_CACHE) {
      if (cached.value === passive) STATUS_CACHE.set(cacheKey, { at: Date.now(), value });
    }
    return value;
  }
  const definition = getAgentCliDefinition(kind);
  let authStatus = 'unknown';
  try {
    const result = await runProcess(
      passive.resolvedCommand,
      [...passive.resolvedArgsPrefix, ...definition.authArgs],
      {
      timeout: DETECTION_TIMEOUT_MS,
        env: applyAgentCliCaptureEnv(options.env ?? process.env, passive.resolvedCommand),
      },
    );
    authStatus = parseAgentCliAuthStatus(`${result.stdout}\n${result.stderr}`);
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') authStatus = 'signed-out';
  }
  const value = { ...passive, authStatus, verifiedAt };
  for (const [cacheKey, cached] of STATUS_CACHE) {
    if (cached.value === passive) STATUS_CACHE.set(cacheKey, { at: Date.now(), value });
  }
  return value;
}

export function resetAgentCliDetectionCacheForTests() {
  STATUS_CACHE.clear();
}
