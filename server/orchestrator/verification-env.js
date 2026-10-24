/** Shared executable search environment for board readiness and verification. */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { resolveUnixLoginShell } from '../terminal/one-shot-spawn.js';

const execFileAsync = promisify(execFile);

/** Put checkout tooling first, including bare checklist commands such as tsc. */
export function ladderEnv(cwd, base = process.env) {
  const env = { ...base, CI: '1', npm_config_progress: 'false' };
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const bin = path.join(path.resolve(cwd), 'node_modules', '.bin');
  env[key] = env[key] ? `${bin}${path.delimiter}${env[key]}` : bin;
  return env;
}

/**
 * Desktop launches can omit Homebrew and version-manager bins from PATH.
 * Read only the login shell's PATH, never a prerequisite's executable or command.
 * No cache: recovery must see changes to the user's toolchain while running.
 * @param {string} cwd
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<NodeJS.ProcessEnv>}
 */
export async function resolveVerificationEnv(cwd, { signal } = {}) {
  const env = { ...process.env };
  if (process.platform !== 'win32') {
    const login = resolveUnixLoginShell(process.platform);
    try {
      const { stdout } = await execFileAsync(login.shell, [
        ...login.loginArgs, '-c', String.raw`printf '\0MINNOW_BOARD_PATH\0%s\0' "$PATH"`,
      ], { cwd, env, signal, timeout: 3000, maxBuffer: 64 * 1024, windowsHide: true });
      // Shell profiles may print banners. NUL framing keeps those out of PATH.
      const marker = '\0MINNOW_BOARD_PATH\0';
      const start = stdout.lastIndexOf(marker);
      const end = start < 0 ? -1 : stdout.indexOf('\0', start + marker.length);
      if (end >= 0) env.PATH = stdout.slice(start + marker.length, end);
    } catch {
      signal?.throwIfAborted();
      // A broken/unavailable profile must not hide inherited or checkout tools.
    }
  }
  return ladderEnv(cwd, env);
}
