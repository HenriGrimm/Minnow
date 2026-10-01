/**
 * Record which process currently owns the Minnow home.
 *
 * `minnow restore` swaps folders in the home, which is only safe when no host
 * has them open. Both hosts (the dev server and the packaged Electron app) write
 * this file at boot; the CLI reads it to decide between applying a restore now
 * and leaving it for the next start.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getMinnowHome } from '../config/home.js';

const FILE_NAME = 'host.json';

function lockPath(home = getMinnowHome()) {
  return path.join(home, 'run', FILE_NAME);
}

let exitHookInstalled = false;

/** Mark this process as the host of the current home until it exits. */
export function writeHostLock() {
  const filePath = lockPath();
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
      'utf8',
    );
  } catch {
    /* best effort — a missing lock only means the CLI applies eagerly */
    return;
  }
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    try {
      const current = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (current?.pid === process.pid) fs.unlinkSync(filePath);
    } catch {
    }
  });
}

/**
 * The live host of a home, or null when none is running.
 * @param {string} [home]
 * @returns {{ pid: number, startedAt: string } | null}
 */
export function readLiveHost(home = getMinnowHome()) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(lockPath(home), 'utf8'));
  } catch {
    return null;
  }
  const pid = Number(parsed?.pid);
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return null;
  try {
    process.kill(pid, 0);
  } catch (err) {
    // EPERM means the process exists but belongs to someone else.
    if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'EPERM') return null;
  }
  return { pid, startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '' };
}
