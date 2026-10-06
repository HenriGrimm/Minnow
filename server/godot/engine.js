/** Locate and probe an installed Godot editor binary. */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { readManagedGodotInstall } from './installer.js';

const execFileAsync = promisify(execFile);

/** @param {string} candidate */
async function isFile(candidate) {
  try {
    return (await fs.stat(candidate)).isFile();
  } catch {
    return false;
  }
}

async function findPortableGodot(root, maxDepth = 3) {
  const matches = [];
  let visited = 0;
  async function walk(dir, depth) {
    if (depth > maxDepth || visited >= 5_000) return;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (++visited >= 5_000) break;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(absolute, depth + 1);
      else if (/^Godot_v4[^/\\]*\.exe$/i.test(entry.name)) matches.push(absolute);
    }
  }
  await walk(root, 0);
  matches.sort((a, b) => {
    const consoleDelta = (/console\.exe$/i.test(b) ? 1 : 0) - (/console\.exe$/i.test(a) ? 1 : 0);
    return consoleDelta || b.localeCompare(a, undefined, { numeric: true });
  });
  return matches[0] ?? null;
}

/**
 * @param {{ explicitPath?: string, env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, homeDir?: string }} [options]
 */
export async function findGodotExecutable(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? os.homedir();
  const explicit = options.explicitPath || env.MINNOW_GODOT_PATH || env.GODOT_PATH;
  if (explicit) {
    const resolved = path.resolve(explicit);
    return {
      path: (await isFile(resolved)) ? resolved : null,
      source: 'configured',
      configuredPath: resolved,
    };
  }

  const managed = await readManagedGodotInstall();
  if (managed?.executable) {
    return { path: managed.executable, source: 'managed', version: managed.version };
  }

  const names = platform === 'win32'
    ? ['godot4.exe', 'godot.exe', 'godot-mono.exe']
    : ['godot4', 'godot', 'godot-mono'];
  const pathValue = env.PATH || env.Path || '';
  for (const rawDir of pathValue.split(path.delimiter).filter(Boolean)) {
    const dir = rawDir.replace(/^"|"$/g, '');
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (await isFile(candidate)) return { path: candidate, source: 'path' };
    }
    if (platform === 'win32') {
      // Official Windows zip releases retain a versioned executable name.
      const entries = await fs.readdir(dir).catch(() => []);
      const portable = entries
        .filter((name) => /^Godot_v4[^/\\]*\.exe$/i.test(name))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      for (const name of portable) {
        const candidate = path.join(dir, name);
        if (await isFile(candidate)) return { path: candidate, source: 'path' };
      }
    }
  }

  const platformCandidates = platform === 'darwin'
    ? [
        '/Applications/Godot.app/Contents/MacOS/Godot',
        path.join(homeDir, 'Applications/Godot.app/Contents/MacOS/Godot'),
      ]
    : platform === 'win32'
      ? [
          path.join(homeDir, 'scoop/apps/godot/current/godot.exe'),
          ...(env.ProgramFiles ? [path.join(env.ProgramFiles, 'Godot/Godot.exe')] : []),
          ...(env.LOCALAPPDATA ? [path.join(env.LOCALAPPDATA, 'Programs/Godot/Godot.exe')] : []),
          ...(env['ProgramFiles(x86)'] ? [path.join(env['ProgramFiles(x86)'], 'Steam/steamapps/common/Godot Engine/godot.windows.opt.tools.64.exe')] : []),
        ]
      : [];
  for (const candidate of platformCandidates) {
    if (await isFile(candidate)) return { path: candidate, source: 'installed' };
  }
  if (platform === 'win32') {
    for (const dir of [path.join(homeDir, 'Downloads'), path.join(homeDir, 'Desktop')]) {
      const portable = await findPortableGodot(dir);
      if (portable) return { path: portable, source: 'discovered' };
    }
  }
  return { path: null, source: 'missing' };
}

/** @param {string} output */
export function parseGodotVersion(output) {
  const raw = String(output ?? '').trim().split(/\r?\n/, 1)[0] ?? '';
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?\b/.exec(raw);
  if (!match) return null;
  return {
    raw,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: match[3] == null ? null : Number(match[3]),
    dotNet: /(?:^|[.\s-])(?:mono|dotnet)(?:[.\s-]|$)/i.test(raw),
  };
}

/** @param {string} executablePath */
export async function probeGodotExecutable(executablePath) {
  try {
    const { stdout, stderr } = await execFileAsync(executablePath, ['--version'], {
      timeout: 4000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
      shell: false,
    });
    const version = parseGodotVersion(stdout || stderr);
    if (!version) return { ok: false, error: 'Executable did not report a Godot version' };
    if (version.major !== 4) {
      return { ok: false, version, error: 'Godot 4 is required for this integration' };
    }
    return { ok: true, version };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
