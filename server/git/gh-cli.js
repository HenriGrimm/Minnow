/**
 * Locate and spawn the GitHub CLI.
 *
 * Apps launched from Finder/Dock on macOS inherit launchd's PATH
 * (/usr/bin:/bin:/usr/sbin:/sbin), which never includes Homebrew. A bare
 * spawn('gh') then fails with ENOENT even though `gh` works in Terminal — git
 * keeps working only because /usr/bin/git ships with the OS. So on Unix we
 * also probe the well-known package-manager bin dirs and put them on the
 * child's PATH, so gh's own subprocesses (git, credential helpers) resolve too.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runProcess } from '../process-runner.js';

/** @returns {string[]} */
export function extraUnixBinDirs(home = os.homedir()) {
  return [
    '/opt/homebrew/bin', // Homebrew, Apple silicon
    '/usr/local/bin', // Homebrew, Intel; official .pkg installer
    '/opt/local/bin', // MacPorts
    '/home/linuxbrew/.linuxbrew/bin',
    path.join(home, '.linuxbrew', 'bin'),
    path.join(home, '.nix-profile', 'bin'),
    '/run/current-system/sw/bin', // nix-darwin / NixOS
    '/nix/var/nix/profiles/default/bin',
    path.join(home, '.local', 'bin'),
    path.join(home, 'bin'),
    '/snap/bin',
  ];
}

function isExecutable(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * PATH with the extra bin dirs appended (existing entries keep precedence).
 * @param {string} [current]
 * @param {string[]} [extra]
 */
export function augmentUnixPath(current = process.env.PATH ?? '', extra = extraUnixBinDirs()) {
  const parts = current.split(path.delimiter).filter(Boolean);
  for (const dir of extra) {
    if (!parts.includes(dir)) parts.push(dir);
  }
  return parts.join(path.delimiter);
}

/**
 * Absolute path to `gh`, or bare 'gh' when it can't be located (spawn then
 * fails the usual way). Not cached, so installing gh while Minnow runs works.
 * @param {{ platform?: string, pathEnv?: string, extraDirs?: string[] }} [opts]
 */
export function resolveGhCommand({
  platform = process.platform,
  pathEnv = process.env.PATH ?? '',
  extraDirs = extraUnixBinDirs(),
} = {}) {
  if (platform === 'win32') return 'gh';
  for (const dir of augmentUnixPath(pathEnv, extraDirs).split(path.delimiter)) {
    const candidate = path.join(dir, 'gh');
    if (isExecutable(candidate)) return candidate;
  }
  return 'gh';
}

/**
 * runProcess for the GitHub CLI, resolved against the augmented PATH.
 * @param {string[]} args
 * @param {Parameters<typeof runProcess>[2]} [options]
 */
export function runGh(args, options = {}) {
  if (process.platform === 'win32') return runProcess('gh', args, options);
  return runProcess(resolveGhCommand(), args, {
    ...options,
    env: { PATH: augmentUnixPath(), ...options.env },
  });
}
