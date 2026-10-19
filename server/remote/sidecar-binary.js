/**
 * Locate the bundled `minnow-tailnet` helper (a Go program built with Tailscale's
 * tsnet). Packaged apps carry it in resources/bin; a source checkout builds it
 * into resources/bin/<os>-<arch>/ with `npm run tailnet:build`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** electron-builder's `${os}` macro: mac | win | linux. */
export function builderOsName(platform = process.platform) {
  if (platform === 'darwin') return 'mac';
  if (platform === 'win32') return 'win';
  return 'linux';
}

export function sidecarFileName(platform = process.platform) {
  return platform === 'win32' ? 'minnow-tailnet.exe' : 'minnow-tailnet';
}

function isExecutable(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return false;
    if (process.platform === 'win32') return true;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * @returns {{ command: string, args: string[] } | null} How to launch the helper,
 *   or null when this build does not include it.
 */
export function resolveSidecarBinary() {
  const override = process.env.MINNOW_TAILNET_BIN?.trim();
  if (override) {
    // Tests point this at a Node script that speaks the same protocol.
    if (/\.(mjs|js)$/.test(override)) {
      return fs.existsSync(override) ? { command: process.execPath, args: [override] } : null;
    }
    return isExecutable(override) ? { command: override, args: [] } : null;
  }
  const name = sidecarFileName();
  const resourcesPath = /** @type {{ resourcesPath?: string }} */ (process).resourcesPath;
  const candidates = [
    resourcesPath ? path.join(resourcesPath, 'bin', name) : '',
    path.join(REPO_ROOT, 'resources', 'bin', `${builderOsName()}-${process.arch}`, name),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (isExecutable(candidate)) return { command: candidate, args: [] };
  }
  return null;
}
