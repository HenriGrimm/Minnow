/**
 * OS-gated shell profile catalog for interactive PTY tabs and execute_command.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import {
  buildGitBashInteractiveArgs,
  detectGitBashPath,
  GIT_BASH_PROFILE_ID,
  resetGitBashCacheForTests,
} from './git-bash.js';
import {
  buildWslInteractiveArgs,
  listWslDistros,
  resetWslDistroCacheForTests,
  resolveWslDistroFromProfileId,
  warmupWslDistros,
  WSL_PROFILE_PREFIX,
} from './wsl.js';

const execFileAsync = promisify(execFile);

/**
 * @typedef {object} ShellProfile
 * @property {string} id
 * @property {string} label
 * @property {string} shell
 * @property {string[]} args
 * @property {string} platform
 * @property {'native' | 'wsl' | 'git-bash'} [runtime]
 * @property {string} [distro] WSL distribution name when runtime is wsl
 */

let wslDetected = null;
/** @type {{ distros: string[]; defaultDistro: string | null } | null} */
let wslCatalog = null;

/**
 * Whether WSL is available (Windows only, cached).
 * @param {string} [platform]
 */
export function detectWsl(platform = process.platform) {
  if (platform !== 'win32') return false;
  if (wslDetected !== null) return wslDetected;
  void warmupWslShellProfiles();
  return false;
}

/**
 * Probe `wsl.exe --status` and distro list off the event loop (MIN-584).
 */
export async function warmupWslShellProfiles() {
  if (process.platform !== 'win32') {
    wslDetected = false;
    wslCatalog = { distros: [], defaultDistro: null };
    return;
  }
  if (wslDetected === true && wslCatalog !== null) return;
  try {
    await execFileAsync('wsl.exe', ['--status'], {
      timeout: 3000,
      windowsHide: true,
    });
    wslDetected = true;
  } catch {
    wslDetected = false;
  }
  if (wslDetected) {
    wslCatalog = await warmupWslDistros();
  } else {
    wslCatalog = { distros: [], defaultDistro: null };
  }
}

/**
 * Cached WSL distro list (Windows only).
 * @param {{ wsl?: boolean }} [options]
 */
function getWslCatalog(options = {}) {
  if (options.wsl === false) {
    wslCatalog = { distros: [], defaultDistro: null };
    return wslCatalog;
  }
  if (wslCatalog !== null) return wslCatalog;
  if (options.wsl === true) {
    const listed = listWslDistros();
    if (listed.distros.length > 0) wslCatalog = listed;
    return listed;
  }
  if (wslDetected === true) {
    wslCatalog = listWslDistros();
    return wslCatalog;
  }
  void warmupWslShellProfiles();
  return { distros: [], defaultDistro: null };
}

/** Reset cached WSL and Git Bash detection (tests). */
export function resetWslShellProfileCache() {
  wslDetected = null;
  wslCatalog = null;
  resetWslDistroCacheForTests();
  resetGitBashCacheForTests();
}

/**
 * Resolve executable on PATH (first match).
 * @param {string[]} candidates
 */
function resolveOnPath(candidates) {
  const pathEnv = process.env.PATH ?? process.env.Path ?? '';
  const dirs = pathEnv.split(process.platform === 'win32' ? ';' : ':');
  for (const name of candidates) {
    for (const dir of dirs) {
      const full = `${dir}${process.platform === 'win32' ? '\\' : '/'}${name}`;
      try {
        if (fs.existsSync(full)) return full;
      } catch {
        /* skip */
      }
    }
  }
  return candidates[0];
}

/**
 * @param {string} distro
 * @param {boolean} isDefault
 * @returns {ShellProfile}
 */
function wslDistroProfile(distro, isDefault) {
  const suffix = isDefault ? ' (default)' : '';
  return {
    id: `${WSL_PROFILE_PREFIX}${distro}`,
    label: `WSL ${distro}${suffix}`,
    shell: 'wsl.exe',
    args: buildWslInteractiveArgs({ distro }),
    platform: 'win32',
    runtime: 'wsl',
    distro,
  };
}

/**
 * Build profiles for a platform (pure, testable).
 * @param {string} platform - Node `process.platform`
 * @param {{ wsl?: boolean; wslDistros?: string[]; wslDefaultDistro?: string | null; gitBashPath?: string | null; systemShell?: string }} [options]
 * @returns {ShellProfile[]}
 */
export function resolveProfiles(platform, options = {}) {
  const profiles = [];
  const systemShell = options.systemShell ?? process.env.SHELL;
  if (platform !== 'win32' && systemShell?.startsWith('/')) {
    const name = systemShell.split('/').pop();
    if (systemShell !== '/bin/bash' && !(platform === 'darwin' && systemShell === '/bin/zsh')) {
      profiles.push({
        id: 'system',
        label: `${name} (system default)`,
        shell: systemShell,
        args: ['-il'],
        platform,
        runtime: 'native',
      });
    }
  }

  if (platform === 'win32') {
    const pwsh = resolveOnPath(['pwsh.exe', 'powershell.exe']);
    profiles.push({
      id: 'powershell',
      label: pwsh.toLowerCase().includes('pwsh') ? 'PowerShell 7' : 'PowerShell',
      shell: pwsh,
      args: ['-NoLogo'],
      platform: 'win32',
      runtime: 'native',
    });
    profiles.push({
      id: 'cmd',
      label: 'Command Prompt',
      shell: 'cmd.exe',
      args: [],
      platform: 'win32',
      runtime: 'native',
    });

    const gitBashPath = detectGitBashPath(options);
    if (gitBashPath) {
      profiles.push({
        id: GIT_BASH_PROFILE_ID,
        label: 'Git Bash',
        shell: gitBashPath,
        args: buildGitBashInteractiveArgs(),
        platform: 'win32',
        runtime: 'git-bash',
      });
    }

    const catalog =
      options.wslDistros != null
        ? {
            distros: options.wslDistros,
            defaultDistro: options.wslDefaultDistro ?? options.wslDistros[0] ?? null,
          }
        : getWslCatalog(options);

    if (catalog.distros.length > 0) {
      for (const distro of catalog.distros) {
        profiles.push(
          wslDistroProfile(distro, distro === catalog.defaultDistro),
        );
      }

      const defaultDistro = catalog.defaultDistro ?? catalog.distros[0];
      profiles.push({
        id: 'bash',
        label: defaultDistro ? `WSL Bash (${defaultDistro})` : 'WSL Bash',
        shell: 'wsl.exe',
        args: buildWslInteractiveArgs({ distro: defaultDistro }),
        platform: 'win32',
        runtime: 'wsl',
        distro: defaultDistro ?? undefined,
      });
    }

    return profiles;
  }

  if (platform === 'darwin') {
    profiles.push({
      id: 'zsh',
      label: 'zsh',
      shell: '/bin/zsh',
      args: ['-il'],
      platform: 'darwin',
      runtime: 'native',
    });
    profiles.push({
      id: 'bash',
      label: 'bash',
      shell: '/bin/bash',
      args: ['-il'],
      platform: 'darwin',
      runtime: 'native',
    });
    return profiles;
  }

  profiles.push({
    id: 'bash',
    label: 'bash',
    shell: '/bin/bash',
    args: ['-il'],
    platform: 'linux',
    runtime: 'native',
  });
  return profiles;
}

/** Profiles available on this machine. */
export function getAvailableShellProfiles() {
  return resolveProfiles(process.platform);
}

/**
 * @param {string} id
 * @returns {ShellProfile | null}
 */
export function getShellProfileById(id) {
  const direct = getAvailableShellProfiles().find((p) => p.id === id);
  if (direct) return direct;

  if (id.startsWith(WSL_PROFILE_PREFIX)) {
    const distro = id.slice(WSL_PROFILE_PREFIX.length);
    if (distro) {
      return wslDistroProfile(distro, false);
    }
  }

  return null;
}

/**
 * Resolve distro + runtime flags for a profile record.
 * Git Bash must pass through as `git-bash` (not collapse to native), or
 * one-shots still run through cmd.exe.
 * @param {ShellProfile | null | undefined} profile
 * @returns {{ runtime: 'native' | 'wsl' | 'git-bash'; distro: string | null }}
 */
export function describeShellProfileRuntime(profile) {
  if (!profile) return { runtime: 'native', distro: null };
  if (profile.runtime === 'wsl') {
    const catalog = getWslCatalog();
    return {
      runtime: 'wsl',
      distro:
        profile.distro ??
        resolveWslDistroFromProfileId(profile.id, catalog.defaultDistro),
    };
  }
  if (profile.runtime === 'git-bash') {
    return { runtime: 'git-bash', distro: null };
  }
  return { runtime: 'native', distro: null };
}

/**
 * Build PTY spawn options for a shell profile and cwd.
 * @param {ShellProfile} profile
 * @param {string} cwd Windows or POSIX cwd
 * @returns {{ shell: string; args: string[]; cwd: string }}
 */
export function resolvePtySpawnForProfile(profile, cwd) {
  const { runtime, distro } = describeShellProfileRuntime(profile);
  if (runtime === 'wsl') {
    return {
      shell: 'wsl.exe',
      args: buildWslInteractiveArgs({ distro, cwd }),
      cwd: process.env.USERPROFILE ?? process.env.SystemRoot ?? cwd,
    };
  }
  return { shell: profile.shell, args: profile.args, cwd };
}

/**
 * Default shell profile id for the current OS (PowerShell on Windows, login shell elsewhere).
 */
export function getDefaultShellProfileId() {
  const available = getAvailableShellProfiles();
  if (available.length === 0) return 'powershell';
  const preferred =
    process.platform === 'win32'
      ? available.find((p) => p.id === 'powershell')
      : available.find((p) => p.shell === process.env.SHELL) ??
        available.find((p) => p.id === 'bash' || p.id === 'zsh');
  return preferred?.id ?? available[0].id;
}
