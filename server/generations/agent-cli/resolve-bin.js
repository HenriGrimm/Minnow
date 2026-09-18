/** Resolve an agent CLI executable without invoking a shell. */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { applyNodeRuntimeEnv } from '../../lsp/node-runtime.js';

const execFileAsync = promisify(execFile);

const DEFAULT_BINS = Object.freeze({
  claude: 'claude',
  codex: 'codex',
  'cursor-agent': 'cursor-agent',
});

/** Cursor version folders are YYYY.MM.DD[-HH-MM-SS]-commit. */
const CURSOR_VERSION_DIR = /^\d{4}\.\d{1,2}\.\d{1,2}(?:-\d{2}-\d{2}-\d{2})?-[a-f0-9]+$/i;

function assertKind(kind) {
  if (!Object.prototype.hasOwnProperty.call(DEFAULT_BINS, kind)) {
    throw new Error(`Unsupported agent CLI: ${String(kind)}`);
  }
}

/** @param {string} filePath */
async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Default install locations used when PATH does not include the vendor bin dir.
 * Cursor's Windows installer writes to %LOCALAPPDATA%\cursor-agent and does not
 * always update the PATH inherited by Electron / the tool server.
 * @param {'claude'|'codex'|'cursor-agent'} kind
 * @param {{ env?: NodeJS.ProcessEnv, homeDir?: string }} [options]
 */
export function wellKnownAgentCliPaths(kind, options = {}) {
  assertKind(kind);
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const roaming = env.APPDATA?.trim() || path.join(homeDir, 'AppData', 'Roaming');
  const local = env.LOCALAPPDATA?.trim() || path.join(homeDir, 'AppData', 'Local');
  if (kind === 'cursor-agent') {
    return process.platform === 'win32'
      ? [path.join(local, 'cursor-agent', 'cursor-agent.cmd')]
      : [path.join(homeDir, '.local', 'bin', 'cursor-agent')];
  }
  if (kind === 'codex') {
    return process.platform === 'win32'
      ? [path.join(roaming, 'npm', 'codex.cmd')]
      : [path.join(homeDir, '.local', 'bin', 'codex')];
  }
  return process.platform === 'win32'
    ? [
      path.join(homeDir, '.local', 'bin', 'claude.exe'),
      path.join(roaming, 'npm', 'claude.cmd'),
    ]
    : [path.join(homeDir, '.local', 'bin', 'claude')];
}

/**
 * Resolve a configured CLI to a shell-free command and argv prefix.
 * Windows npm shims are converted to their node script when possible.
 * @param {{ kind: 'claude'|'codex'|'cursor-agent', binPath?: string, env?: NodeJS.ProcessEnv, homeDir?: string }} input
 * @returns {Promise<{ command: string, argsPrefix: string[], display: string }>}
 */
export async function resolveAgentCliBin(input) {
  assertKind(input.kind);
  const configured = typeof input.binPath === 'string' ? input.binPath.trim() : '';
  // Resolve to an absolute path on every platform: a Finder-launched macOS app
  // inherits a bare PATH, so spawning the bare name fails with ENOENT.
  let requested = configured || await findAgentCliOnPath(input.kind, input) || DEFAULT_BINS[input.kind];
  if (configured && !path.isAbsolute(requested) && !/[\\/]/.test(requested)) {
    const fromPath = await findCommandOnPath(requested, input);
    if (!fromPath) throw new Error(`Agent CLI is not on PATH: ${requested}`);
    requested = fromPath;
  }
  if (process.platform !== 'win32' || !requested.toLowerCase().endsWith('.cmd')) {
    return { command: requested, argsPrefix: [], display: requested };
  }

  return resolveWindowsCmdShim(requested);
}

/**
 * Turn a Windows .cmd launcher into a direct executable + argv.
 * npm global shims become `node script.js`; Cursor's installer becomes its
 * bundled node.exe plus that version's index.js. Never spawn cmd.exe.
 */
export async function resolveWindowsCmdShim(requested) {
  const shim = path.resolve(requested);
  const text = await fs.readFile(shim, 'utf8').catch(() => null);
  if (!text) {
    throw new Error(`Agent CLI shim is not readable: ${requested}`);
  }

  const npmScript = extractNpmShimScript(text);
  if (npmScript) {
    const resolvedScript = resolveShimRelativeScript(shim, npmScript);
    await fs.access(resolvedScript);
    return {
      command: process.execPath,
      argsPrefix: [resolvedScript],
      display: requested,
    };
  }

  if (isCursorAgentCmdLauncher(text)) {
    return resolveCursorAgentLauncher(shim, requested);
  }

  throw new Error(`Cannot resolve Windows CLI shim safely: ${requested}`);
}

/**
 * Pull the JS entry from current and legacy npm cmd shims.
 * Current npm quotes `"%_prog%"` and uses `"%dp0%\node_modules\…js"`.
 */
function extractNpmShimScript(text) {
  const match =
    text.match(/"%~dp0%?[\\/]([^"\r\n]+\.[cm]?js)"/i) ??
    text.match(/"%dp0%?[\\/]([^"\r\n]+\.[cm]?js)"/i) ??
    text.match(/"?%_prog%"?\s+"((?:%~?dp0%?[\\/])?[^"\r\n]+\.[cm]?js)"/i) ??
    text.match(/(?:node(?:\.exe)?|%_prog%)\s+"?((?:%~?dp0%?[\\/])?[^"\r\n]+\.[cm]?js)"?/i);
  return match?.[1] ?? null;
}

/** Resolve `%dp0%` / `%~dp0` prefixes to the directory that contains the shim. */
function resolveShimRelativeScript(shimPath, raw) {
  const withoutDp0 = raw.replace(/^%~?dp0%?[\\/]?/i, '');
  const script = withoutDp0.replace(/[\\/]/g, path.sep);
  return path.isAbsolute(script) ? script : path.resolve(path.dirname(shimPath), script);
}

function isCursorAgentCmdLauncher(text) {
  return /-File\s+"[^"\r\n]*(?:cursor-agent|agent)\.ps1"/i.test(text);
}

/** Sort key matching Cursor's dated version directory names. */
export function cursorAgentVersionSortKey(name) {
  const match = String(name).match(
    /^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:-(\d{2})-(\d{2})-(\d{2}))?-([a-f0-9]+)$/i,
  );
  if (!match) return '';
  const [, year, month, day, hour = '00', minute = '00', second = '00'] = match;
  return `${year}${month.padStart(2, '0')}${day.padStart(2, '0')}${hour}${minute}${second}`;
}

/**
 * Follow Cursor's agent.ps1 layout: node.exe + index.js beside the launcher,
 * otherwise the newest versions/<date-commit>/ payload.
 */
async function resolveCursorAgentLauncher(shim, display) {
  const root = path.dirname(shim);
  const beside = await cursorNodeInvocation(root);
  if (beside) return { ...beside, display };

  const versionsRoot = path.join(root, 'versions');
  let entries = [];
  try {
    entries = await fs.readdir(versionsRoot, { withFileTypes: true });
  } catch {
    entries = [];
  }
  const latest = entries
    .filter((entry) => entry.isDirectory() && CURSOR_VERSION_DIR.test(entry.name))
    .sort((a, b) => cursorAgentVersionSortKey(a.name).localeCompare(cursorAgentVersionSortKey(b.name)))
    .at(-1);
  if (!latest) {
    throw new Error(`Cannot resolve Windows CLI shim safely: ${display}`);
  }
  const fromVersion = await cursorNodeInvocation(path.join(versionsRoot, latest.name));
  if (!fromVersion) {
    throw new Error(`Cannot resolve Windows CLI shim safely: ${display}`);
  }
  return { ...fromVersion, display };
}

async function cursorNodeInvocation(dir) {
  const command = path.join(dir, 'node.exe');
  const script = path.join(dir, 'index.js');
  if (!(await fileExists(command)) || !(await fileExists(script))) return null;
  return { command, argsPrefix: [script] };
}

/**
 * Directories where POSIX installers put agent CLIs and the `node` their
 * `#!/usr/bin/env node` launchers need. GUI apps on macOS start with
 * PATH=/usr/bin:/bin:/usr/sbin:/sbin, which contains none of them.
 * @param {{ env?: NodeJS.ProcessEnv, homeDir?: string }} [options]
 */
export function agentCliExtraPathDirs(options = {}) {
  if (process.platform === 'win32') return [];
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const npmPrefix = env.npm_config_prefix?.trim() || env.NPM_CONFIG_PREFIX?.trim();
  return [
    path.join(homeDir, '.local', 'bin'),
    path.join(homeDir, '.claude', 'local'),
    ...(npmPrefix ? [path.join(npmPrefix, 'bin')] : []),
    path.join(homeDir, '.npm-global', 'bin'),
    path.join(homeDir, '.volta', 'bin'),
    path.join(homeDir, '.bun', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
}

/**
 * PATH for finding and running agent CLIs: the inherited PATH first, then the
 * CLI's own directory (nvm/npm keep `node` beside global bins), then install dirs.
 * @param {NodeJS.ProcessEnv} env
 * @param {{ command?: string, homeDir?: string }} [options]
 */
export function agentCliSearchPath(env, options = {}) {
  const key = process.platform === 'win32' && typeof env.Path === 'string' && typeof env.PATH !== 'string' ? 'Path' : 'PATH';
  const inherited = typeof env[key] === 'string' ? env[key].split(path.delimiter).filter(Boolean) : [];
  if (process.platform === 'win32') return inherited.join(path.delimiter);
  const commandDir = options.command && path.isAbsolute(options.command) ? [path.dirname(options.command)] : [];
  const dirs = [...inherited, ...commandDir, ...agentCliExtraPathDirs({ env, homeDir: options.homeDir })];
  return [...new Set(dirs)].join(path.delimiter);
}

/** Resolve a command on PATH for diagnostics without executing it. */
async function findCommandOnPath(command, options = {}) {
  if (typeof command !== 'string' || !command.trim() || /[\0\r\n]/.test(command)) return null;
  const env = options.env ?? process.env;
  try {
    const { stdout } = await execFileAsync(process.platform === 'win32' ? 'where.exe' : 'which', [command.trim()], {
      ...(process.platform === 'win32' ? {} : { env: { ...env, PATH: agentCliSearchPath(env, options) } }),
      windowsHide: true,
      timeout: 3_000,
      maxBuffer: 64 * 1024,
    });
    const matches = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    // npm places an extensionless POSIX launcher beside its Windows .cmd shim.
    return (process.platform === 'win32' ? matches.find(file => /\.(?:exe|com|cmd)$/i.test(file)) : matches[0]) ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve a known agent command on PATH, then vendor default install locations.
 * @param {'claude'|'codex'|'cursor-agent'} kind
 * @param {{ env?: NodeJS.ProcessEnv, homeDir?: string }} [options]
 */
export async function findAgentCliOnPath(kind, options = {}) {
  assertKind(kind);
  const fromPath = await findCommandOnPath(DEFAULT_BINS[kind], options);
  if (fromPath) return fromPath;
  for (const candidate of wellKnownAgentCliPaths(kind, options)) {
    if (await fileExists(candidate)) return candidate;
  }
  return null;
}

export function applyAgentNodeEnv(env, command) {
  const next = applyNodeRuntimeEnv(env, command);
  if (process.platform === 'win32') return next;
  return { ...next, PATH: agentCliSearchPath(next, { command }) };
}

/**
 * Vite's dev server sets FORCE_COLOR. Agent CLIs inherit that and colorize
 * piped stdout, which breaks parsers that expect plain `id - label` or JSON.
 */
export function applyAgentCliCaptureEnv(env, command) {
  const next = { ...applyAgentNodeEnv(env, command) };
  // FORCE_COLOR=0 wins over Vite's FORCE_COLOR=1. Do not also set NO_COLOR:
  // Node treats any FORCE_COLOR value as "set" and warns that NO_COLOR is ignored.
  next.FORCE_COLOR = '0';
  delete next.NO_COLOR;
  next.TERM = 'dumb';
  return next;
}

/** CSI / OSC sequences that CLIs emit when FORCE_COLOR is set. */
const ANSI_ESCAPE = /\u001B(?:\[[0-9;?]*[ -/]*[@-~]|].*?(?:\u0007|\u001B\\))/g;

/** @param {unknown} text */
export function stripAnsiFromCliText(text) {
  return String(text || '').replace(ANSI_ESCAPE, '');
}
