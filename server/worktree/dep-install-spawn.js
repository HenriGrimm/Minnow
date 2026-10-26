import { resolveUnixLoginShell } from '../terminal/one-shot-spawn.js';

/** GUI launches need the login PATH; pass argv separately from shell source. */
export function installSpawnTarget(install) {
  if (process.platform === 'win32') return { ...install, shell: true };
  const login = resolveUnixLoginShell(process.platform);
  return {
    command: login.shell,
    args: [...login.loginArgs, '-c', 'exec "$@"', 'minnow-dep-install', install.command, ...install.args],
    shell: false,
  };
}
