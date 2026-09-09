/**
 * Run Impeccable CLI (detect) or bundled scripts (live) in the active workspace.
 * Harness commands (teach, audit, shape, …) return guidance — they are not npm CLI sub-commands.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  harnessCommandGuidanceWithReference,
  isCliCommand,
  isHarnessCommand,
  isScriptCommand,
  listAcceptedRunImpeccableCommands,
  SCRIPT_COMMANDS,
} from './command-routing.js';
import { buildImpeccableSpawnEnv } from './spawn-env.js';

/** Wall-clock budget for a spawned detect/live child. */
export const IMPECCABLE_TIMEOUT_MS = 60_000;

/** After SIGTERM, wait this long then force-kill so hung detectors do not linger. */
const KILL_GRACE_MS = 2_000;

const MAX_STDOUT_CHARS = 32_000;

/** Upstream detect exits 2 when it found anti-patterns — not a spawn failure. */
export const DETECT_FINDINGS_EXIT_CODE = 2;

/**
 * Narrow UI roots preferred for omitted detect targets (UI Designer surfaces).
 * Only paths that exist on disk are passed to the CLI.
 */
export const UI_DETECT_ROOTS = ['src/ui', 'src/styles', 'index.html'];

/** Conventional frontend dirs used when the UI-specific roots are absent. */
export const SOURCE_DETECT_DIRS = ['src', 'app', 'components', 'pages', 'public'];

/**
 * @param {string} appRoot Minnow install root (bundled impeccable package)
 * @returns {string}
 */
export function resolveBundledImpeccableCliPath(appRoot) {
  return path.join(appRoot, 'node_modules', 'impeccable', 'cli', 'bin', 'cli.js');
}

/**
 * Split an agent-supplied target string on whitespace (`"src/ index.html"`).
 * @param {string} raw
 * @returns {string[]}
 */
export function splitTargetArgs(raw) {
  if (typeof raw !== 'string') return [];
  return raw.trim().split(/\s+/).filter(Boolean);
}

/**
 * True when any target is an http(s) URL. Detect's URL mode launches Puppeteer
 * and can hang past the tool timeout; Design pass is for local files only.
 * @param {string[]} targets
 * @returns {boolean}
 */
export function hasHttpUrlTarget(targets) {
  return targets.some((t) => /^https?:\/\//i.test(String(t ?? '').trim()));
}

/**
 * Resolve detect scan paths. Omitted target must not silently become `.` on a
 * large workspace — that walks every .ts/.js/.css/.html file and hits 60s.
 *
 * @param {string} projectRoot Active workspace
 * @param {string} [explicitTarget] Raw `args.target` (already trimmed) or ''
 * @returns {string[]}
 */
export function resolveDetectTargets(projectRoot, explicitTarget) {
  if (typeof explicitTarget === 'string' && explicitTarget.trim() !== '') {
    return splitTargetArgs(explicitTarget);
  }

  const existing = (relPaths) =>
    relPaths.filter((rel) => fs.existsSync(path.join(projectRoot, rel)));

  // Prefer the surfaces UI Designer is allowed to edit.
  const uiRoots = existing(UI_DETECT_ROOTS);
  if (uiRoots.length > 0) return uiRoots;

  const sourceDirs = existing(SOURCE_DETECT_DIRS);
  if (sourceDirs.length > 0) return sourceDirs;

  if (fs.existsSync(path.join(projectRoot, 'index.html'))) {
    return ['index.html'];
  }

  // Tiny / unusual trees: still pass `.` so the CLI does not wait on stdin.
  return ['.'];
}

/**
 * @param {string} projectRoot
 * @returns {string}
 */
function describeCwd(projectRoot) {
  return path.basename(projectRoot) === 'Minnow' ? '.' : projectRoot;
}

/**
 * Timeout copy names the actual scan paths so the agent can retry narrower.
 * @param {{ commandLabel: string, spawnLabel: string, timeoutMs?: number, projectRoot: string, targets?: string[] }} opts
 * @returns {string}
 */
export function formatImpeccableTimeoutMessage(opts) {
  const timeoutMs = opts.timeoutMs ?? IMPECCABLE_TIMEOUT_MS;
  const relRoot = describeCwd(opts.projectRoot);
  const targetList =
    opts.targets && opts.targets.length > 0 ? opts.targets.join(', ') : '(none)';
  return (
    `Error: run_impeccable (${opts.commandLabel} via ${opts.spawnLabel}) ` +
    `timed out after ${timeoutMs / 1000}s (cwd ${relRoot}; targets: ${targetList}). ` +
    `Pass a narrower target (file or folder) to scan less.`
  );
}

/**
 * Prefix JSON detect output with a count so agents see signal without parsing.
 * @param {string} stdout
 * @returns {string}
 */
export function formatFindingsCountPrefix(stdout) {
  try {
    const parsed = JSON.parse(String(stdout ?? '').trim());
    if (!Array.isArray(parsed)) return '';
    const n = parsed.length;
    return `${n} anti-pattern${n === 1 ? '' : 's'} found.\n`;
  } catch {
    return '';
  }
}

/**
 * Map a child exit into the tool result string.
 * Detect exit 2 means findings were found — treat as success.
 *
 * @param {{
 *   code: number | null,
 *   commandLabel: string,
 *   stdout: string,
 *   stderr: string,
 *   projectRoot: string,
 *   timedOut?: boolean,
 *   spawnLabel: string,
 *   targets?: string[],
 *   timeoutMs?: number,
 * }} opts
 * @returns {string}
 */
export function formatImpeccableCliResult(opts) {
  if (opts.timedOut) {
    return formatImpeccableTimeoutMessage(opts);
  }

  const relRoot = describeCwd(opts.projectRoot);
  const combined = [opts.stdout?.trim(), opts.stderr?.trim()].filter(Boolean).join('\n');
  const empty = `(no output; cwd ${relRoot})`;
  const findingsExit =
    opts.commandLabel === 'detect' && opts.code === DETECT_FINDINGS_EXIT_CODE;

  if (opts.code === 0 || findingsExit) {
    const prefix = findingsExit ? formatFindingsCountPrefix(opts.stdout) : '';
    return prefix + (combined || empty);
  }

  const prefix = `Error: impeccable ${opts.commandLabel} exited ${opts.code}\n`;
  return prefix + (combined || empty);
}

/**
 * SIGTERM first; on Windows follow with taskkill /T /F so grandchild node
 * processes cannot outlive the 60s tool budget.
 * @param {import('node:child_process').ChildProcess} child
 */
export function forceKillChild(child) {
  if (!child || child.exitCode != null || child.signalCode != null) return;
  const pid = child.pid;
  if (!pid) return;

  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      }).unref();
    } catch {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }
    return;
  }

  try {
    child.kill('SIGKILL');
  } catch {
    /* already gone */
  }
}

/**
 * @param {object} args
 * @param {string} args.command
 * @param {string} [args.target]
 * @param {string} appRoot Minnow install root (bundled scripts)
 * @param {string} projectRoot Active workspace
 */
export function toolRunImpeccable(args, appRoot, projectRoot) {
  const command = typeof args?.command === 'string' ? args.command.trim().toLowerCase() : '';
  const accepted = listAcceptedRunImpeccableCommands();

  if (!command) {
    return Promise.resolve({
      result: `Error: run_impeccable command must be one of: ${accepted.join(', ')}`,
    });
  }

  if (isHarnessCommand(command) && !isScriptCommand(command)) {
    return Promise.resolve({
      result: harnessCommandGuidanceWithReference(appRoot, command),
    });
  }

  if (!accepted.includes(command)) {
    return Promise.resolve({
      result: `Error: run_impeccable command must be one of: ${accepted.join(', ')}. Harness commands (teach, audit, shape, craft, …) use /impeccable <cmd> in the composer.`,
    });
  }

  const targetExplicit = typeof args?.target === 'string' && args.target.trim() !== '';
  const rawTarget = targetExplicit ? args.target.trim() : '';

  if (isCliCommand(command)) {
    const targets = resolveDetectTargets(projectRoot, rawTarget);
    if (hasHttpUrlTarget(targets)) {
      return Promise.resolve({
        result:
          'Error: run_impeccable detect does not support URL targets (Puppeteer). Pass a local file or folder such as src/ui, src/styles, or index.html.',
      });
    }
    return runBundledImpeccableCli(command, targets, appRoot, projectRoot);
  }

  if (isScriptCommand(command)) {
    return runBundledScript(command, rawTarget, appRoot, projectRoot);
  }

  return Promise.resolve({
    result: `Error: unsupported run_impeccable command: ${command}`,
  });
}

/**
 * @param {string} command
 * @param {string[]} targets
 * @param {string} appRoot
 * @param {string} projectRoot
 */
function runBundledImpeccableCli(command, targets, appRoot, projectRoot) {
  const cliPath = resolveBundledImpeccableCliPath(appRoot);
  if (!fs.existsSync(cliPath)) {
    return Promise.resolve({
      result: `Error: missing Impeccable CLI at ${cliPath}. Re-run npm install in the Minnow app directory.`,
    });
  }

  // --json skips the TTY confirm + Vite port probe and returns structured findings.
  const cliArgs = [cliPath, command, '--json', ...targets];

  return spawnWithCapture(
    process.execPath,
    cliArgs,
    {
      cwd: projectRoot,
      env: buildImpeccableSpawnEnv(projectRoot),
    },
    command,
    projectRoot,
    'impeccable cli',
    targets,
  );
}

/**
 * @param {string} command
 * @param {string} target
 * @param {string} appRoot
 * @param {string} projectRoot
 */
function runBundledScript(command, target, appRoot, projectRoot) {
  const relScript = SCRIPT_COMMANDS.get(command);
  if (!relScript) {
    return Promise.resolve({
      result: `Error: no bundled script for command: ${command}`,
    });
  }

  const scriptPath = path.join(appRoot, 'src', 'skills', 'impeccable', relScript);
  if (!fs.existsSync(scriptPath)) {
    return Promise.resolve({
      result: `Error: missing Impeccable script at ${scriptPath}. Re-run npm install in the Minnow app directory.`,
    });
  }

  const nodeArgs = [scriptPath];
  if (target) nodeArgs.push(target);

  return spawnWithCapture(
    process.execPath,
    nodeArgs,
    {
      cwd: projectRoot,
      env: buildImpeccableSpawnEnv(projectRoot),
    },
    command,
    projectRoot,
    path.basename(scriptPath),
    target ? [target] : [],
  );
}

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {import('node:child_process').SpawnOptions} options
 * @param {string} commandLabel
 * @param {string} projectRoot
 * @param {string} spawnLabel
 * @param {string[]} [targets]
 */
function spawnWithCapture(cmd, args, options, commandLabel, projectRoot, spawnLabel, targets = []) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      ...options,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let killTimer = null;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      // Force-kill if SIGTERM did not reap the process (common on Windows trees).
      killTimer = setTimeout(() => forceKillChild(child), KILL_GRACE_MS);
    }, IMPECCABLE_TIMEOUT_MS);

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > MAX_STDOUT_CHARS) {
        stdout = `${stdout.slice(0, MAX_STDOUT_CHARS)}\n…[truncated]`;
      }
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    const settle = (result) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve(result);
    };

    child.on('close', (code) => {
      settle({
        result: formatImpeccableCliResult({
          code,
          commandLabel,
          stdout,
          stderr,
          projectRoot,
          timedOut,
          spawnLabel,
          targets,
        }),
      });
    });

    child.on('error', (err) => {
      settle({
        result: `Error: failed to spawn ${spawnLabel}: ${err.message}`,
      });
    });
  });
}
