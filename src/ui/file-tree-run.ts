import type { ShellProfile } from '../api/terminal-pty';

/**
 * Files sidebar **Run** (MIN-35): map a script's extension to a runner and build the
 * command line for the shell that a new terminal tab opens with.
 *
 * Paths are relative to the file explorer root, which is also the cwd of new PTY
 * tabs, so the command stays valid inside WSL as well as native shells.
 */

export type ScriptRunnerId =
  | 'bash'
  | 'zsh'
  | 'python'
  | 'node'
  | 'tsx'
  | 'ruby'
  | 'perl'
  | 'powershell'
  | 'batch';

export interface ScriptRunner {
  id: ScriptRunnerId;
  /** Short label for tooltips, e.g. `node`. */
  label: string;
  /** Only meaningful on a Windows host (cmd/batch files). */
  windowsOnly?: boolean;
}

type ShellFamily = 'powershell' | 'cmd' | 'posix';

const RUNNERS: Record<string, ScriptRunner> = {
  sh: { id: 'bash', label: 'bash' },
  bash: { id: 'bash', label: 'bash' },
  zsh: { id: 'zsh', label: 'zsh' },
  py: { id: 'python', label: 'python' },
  js: { id: 'node', label: 'node' },
  mjs: { id: 'node', label: 'node' },
  cjs: { id: 'node', label: 'node' },
  ts: { id: 'tsx', label: 'tsx' },
  mts: { id: 'tsx', label: 'tsx' },
  cts: { id: 'tsx', label: 'tsx' },
  rb: { id: 'ruby', label: 'ruby' },
  pl: { id: 'perl', label: 'perl' },
  ps1: { id: 'powershell', label: 'PowerShell' },
  bat: { id: 'batch', label: 'Command Prompt', windowsOnly: true },
  cmd: { id: 'batch', label: 'Command Prompt', windowsOnly: true },
};

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Runner for a workspace file, or null when Run should not be offered.
 * `hostPlatform` hides Windows batch files on other hosts when it is known.
 */
export function scriptRunnerForPath(path: string, hostPlatform?: string): ScriptRunner | null {
  const name = path.split(/[\\/]/).pop() ?? '';
  if (!name || CONTROL_CHARS.test(path)) return null;
  // Type declarations are not runnable.
  if (/\.d\.[cm]?ts$/i.test(name)) return null;
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  const runner = RUNNERS[name.slice(dot + 1).toLowerCase()];
  if (!runner) return null;
  if (runner.windowsOnly && hostPlatform && hostPlatform !== 'win32') return null;
  return runner;
}

function shellFamily(profile?: ShellProfile): ShellFamily {
  const shell = profile?.shell ?? '';
  if (profile?.runtime === 'wsl' || profile?.runtime === 'git-bash') return 'posix';
  if (/(?:^|[\\/])(?:powershell|pwsh)(?:\.exe)?$/i.test(shell)) return 'powershell';
  if (/(?:^|[\\/])cmd(?:\.exe)?$/i.test(shell)) return 'cmd';
  if (!shell && profile?.platform === 'win32') return 'powershell';
  return 'posix';
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || path.startsWith('\\') || /^[a-z]:[\\/]/i.test(path);
}

/** Relative paths get a `./` prefix so a leading `-` is never read as an option. */
function shellPath(path: string, family: ShellFamily): string {
  const rel = isAbsolutePath(path) || /^\.\.?[\\/]/.test(path) ? path : `./${path}`;
  return family === 'posix' ? rel.replace(/\\/g, '/') : rel.replace(/\//g, '\\');
}

/** POSIX single-quote: nothing inside is expanded; `'` becomes `'\''`. */
export function quotePosix(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** PowerShell single-quote; PowerShell also treats typographic single quotes as quotes. */
export function quotePowerShell(value: string): string {
  return `'${value.replace(/['‘’‚‛]/g, '$&$&')}'`;
}

/**
 * cmd.exe double-quote. `%` cannot be escaped inside quotes, so each `%` is placed
 * outside them as `^%` (`"a"^%"b"` → `a%b`).
 */
export function quoteCmd(value: string): string {
  return value
    .split('%')
    .map((part) => `"${part}"`)
    .join('^%');
}

function quoteFor(family: ShellFamily, value: string): string {
  if (family === 'powershell') return quotePowerShell(value);
  if (family === 'cmd') return quoteCmd(value);
  return quotePosix(value);
}

/**
 * Command line that runs `path` with `runner` in `profile`'s shell, or null when the
 * path cannot be passed safely (control characters, `"` for cmd.exe, or a batch file
 * with `%` outside cmd.exe — Windows re-parses batch paths through `cmd /c`, which
 * expands `%VAR%` before the file is found).
 */
export function buildRunScriptCommand(
  path: string,
  runner: ScriptRunner,
  profile?: ShellProfile,
): string | null {
  if (CONTROL_CHARS.test(path)) return null;
  const family = shellFamily(profile);
  if (family === 'cmd' && path.includes('"')) return null;
  const windows = profile?.platform === 'win32' && profile.runtime !== 'wsl';
  const target = quoteFor(family, shellPath(path, family));
  // PowerShell resolves `npx` to npx.ps1, which execution policy may block.
  const npx = family === 'powershell' && windows ? 'npx.cmd' : 'npx';

  switch (runner.id) {
    case 'bash':
    case 'zsh':
    case 'ruby':
    case 'perl':
    case 'node':
      return `${runner.id} ${target}`;
    case 'python':
      return `${windows ? 'python' : 'python3'} ${target}`;
    case 'tsx':
      return `${npx} tsx ${target}`;
    case 'powershell':
      if (family === 'powershell') return `& ${target}`;
      return `${windows ? 'powershell' : 'pwsh'} -NoProfile -File ${target}`;
    case 'batch':
      if (family !== 'cmd' && path.includes('%')) return null;
      if (family === 'powershell') return `& ${target}`;
      if (family === 'cmd') return target;
      // Git Bash and WSL hand batch files to cmd.exe through interop.
      return profile?.runtime === 'wsl'
        ? `cmd.exe /c ${quotePosix(path.replace(/\//g, '\\'))}`
        : target;
    default:
      return null;
  }
}

/** Open a new terminal tab and run the file with its runner. */
export async function runFileInNewTerminal(path: string, runner: ScriptRunner): Promise<void> {
  const { runCommandInNewTerminal } = await import('./terminal-command-launcher');
  await runCommandInNewTerminal((profile) => {
    const command = buildRunScriptCommand(path, runner, profile);
    if (!command) throw new Error("this file path can't be passed safely to the terminal's shell.");
    return command;
  });
}
