/**
 * Rotating SQLite snapshots of the sessions store.
 *
 * Replaces the old whole-store JSON mirror: `db.backup()` is SQLite's online
 * backup API — async, chunked, WAL-consistent — so cost is proportional to the
 * bytes copied rather than to the shape of the store, and nothing the size of
 * the store is ever held as a string. That removes the reason the mirror needed
 * a size cap, and with it the cap that silently disabled it.
 *
 * Snapshots are the first recovery source for a corrupt `sessions.db`; the
 * legacy `state.json.migrated` blob stays as the fallback for very old profiles.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';

import { sessionsDbPath, sessionsSnapshotsDir } from './sessions-paths.js';
import { runSessionsMaintenance } from './sessions-maintenance.js';

/** How many snapshots survive rotation. */
const KEEP_SNAPSHOTS = 3;

/** Skip when the newest snapshot is younger than this (restart loops must not thrash the disk). */
const SNAPSHOT_MIN_AGE_MS = 12 * 60 * 60 * 1000;

/** Refuse to snapshot unless free space is at least this multiple of the live DB. */
const FREE_SPACE_FACTOR = 2;

const SNAPSHOT_RE = /^sessions-.+\.db$/;
const PARTIAL_SUFFIX = '.partial';
const snapshotsInProgress = new Map();

/** @param {string} filePath */
function unlinkQuiet(filePath) {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
  }
}

/**
 * Remove a snapshot plus any WAL/SHM siblings a verify pass may have created.
 * @param {string} filePath
 */
function unlinkSnapshot(filePath) {
  for (const suffix of ['', '-wal', '-shm']) unlinkQuiet(`${filePath}${suffix}`);
}

async function removeSnapshot(filePath) {
  await Promise.all([filePath, `${filePath}-wal`, `${filePath}-shm`].map(file =>
    fsp.rm(file, { force: true }).catch(() => {})));
}

/**
 * Snapshot files, newest first. Names sort lexicographically by timestamp.
 * @returns {string[]} absolute paths
 */
export function listSessionsSnapshots() {
  const dir = sessionsSnapshotsDir();
  /** @type {string[]} */
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => SNAPSHOT_RE.test(name))
    .sort()
    .reverse()
    .map((name) => path.join(dir, name));
}

/**
 * `pragma quick_check` on a finished snapshot. A snapshot of an already-corrupt
 * DB is worse than no snapshot — it looks like a valid restore source.
 *
 * Runtime snapshot creation and recovery run this check in a maintenance worker.
 * @param {string} filePath
 * @returns {boolean}
 */
export function verifySessionsSnapshot(filePath) {
  /** @type {import('better-sqlite3').Database | null} */
  let db = null;
  try {
    db = new Database(filePath);
    return db.pragma('quick_check', { simple: true }) === 'ok';
  } catch {
    return false;
  } finally {
    try {
      db?.close();
    } catch {
    }
    // Verifying opens the copy read-write; drop the sidecars that leaves behind.
    unlinkQuiet(`${filePath}-wal`);
    unlinkQuiet(`${filePath}-shm`);
  }
}

/**
 * Keep the newest `keep` snapshots, unlink the rest.
 * @param {number} [keep]
 * @returns {string[]} removed paths
 */
export function rotateSessionsSnapshots(keep = KEEP_SNAPSHOTS) {
  const removed = [];
  for (const filePath of listSessionsSnapshots().slice(Math.max(0, keep))) {
    unlinkSnapshot(filePath);
    removed.push(filePath);
  }
  return removed;
}

/** Drop leftovers from a snapshot that never finished. */
async function sweepPartialSnapshots(dir) {
  let names;
  try {
    names = await fsp.readdir(dir);
  } catch {
    return;
  }
  await Promise.all(names.filter(name => name.endsWith(PARTIAL_SUFFIX)).map(name => removeSnapshot(path.join(dir, name))));
}

/**
 * @param {string} dir
 * @param {number} needBytes
 * @returns {Promise<boolean>} false only when free space is known to be short
 */
async function hasFreeSpace(dir, needBytes) {
  try {
    const { statfs } = await import('node:fs/promises');
    const stats = await statfs(dir);
    const free = Number(stats.bfree) * Number(stats.bsize);
    if (!Number.isFinite(free) || free <= 0) return true;
    return free >= needBytes;
  } catch {
    /* statfs unavailable — do not block the snapshot on it */
    return true;
  }
}

/**
 * File-name-safe ISO stamp (Windows rejects `:` in paths).
 * @param {Date} [now]
 */
function snapshotStamp(now = new Date()) {
  return now.toISOString().replace(/[:.]/g, '-');
}

/**
 * Copy the live sessions DB into `snapshots/sessions-<ISO>.db`, verify it, rotate.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ force?: boolean, keep?: number, minAgeMs?: number }} [options]
 * @returns {Promise<{ ok: boolean, reason?: string, file?: string, removed?: string[] }>}
 */
export function snapshotSessionsDb(db, options = {}) {
  const dir = sessionsSnapshotsDir();
  const pending = snapshotsInProgress.get(dir);
  if (pending) return pending;
  const snapshot = writeSessionsSnapshot(db, dir, options).finally(() => snapshotsInProgress.delete(dir));
  snapshotsInProgress.set(dir, snapshot);
  return snapshot;
}

async function writeSessionsSnapshot(db, dir, options) {
  const { force = false, keep = KEEP_SNAPSHOTS, minAgeMs = SNAPSHOT_MIN_AGE_MS } = options;

  try {
    if (!force) {
      const [newest] = listSessionsSnapshots();
      if (newest) {
        let mtimeMs = 0;
        try {
          mtimeMs = fs.statSync(newest).mtimeMs;
        } catch {
        }
        // A future mtime (clock skew, a restored profile) must not suppress
        // snapshots forever — an extra copy beats never backing up again.
        const ageMs = Date.now() - mtimeMs;
        if (ageMs >= 0 && ageMs < minAgeMs) {
          return { ok: false, reason: 'recent_snapshot' };
        }
      }
    }

    let dbBytes = 0;
    try {
      dbBytes = fs.statSync(sessionsDbPath()).size;
    } catch {
      return { ok: false, reason: 'no_db' };
    }

    fs.mkdirSync(dir, { recursive: true });
    await sweepPartialSnapshots(dir);

    if (!(await hasFreeSpace(dir, dbBytes * FREE_SPACE_FACTOR))) {
      console.warn(
        `[sessions] snapshot skipped: less than ${FREE_SPACE_FACTOR}× the store ` +
          `(${Math.round(dbBytes / 1048576)} MB) free on disk.`,
      );
      return { ok: false, reason: 'low_disk' };
    }

    const finalPath = path.join(dir, `sessions-${snapshotStamp()}.db`);
    const partialPath = `${finalPath}${PARTIAL_SUFFIX}`;

    let verified;
    try {
      const sourcePath = sessionsDbPath();
      if (db.name === sourcePath) {
        verified = await runSessionsMaintenance('snapshot', { filePath: partialPath, sourcePath });
      } else {
        await db.backup(partialPath);
        verified = await runSessionsMaintenance('verify-snapshot', { filePath: partialPath });
      }
    } catch (error) {
      await removeSnapshot(partialPath);
      throw error;
    }
    if (!verified) {
      await removeSnapshot(partialPath);
      console.warn('[sessions] snapshot discarded: quick_check failed on the copy.');
      return { ok: false, reason: 'quick_check_failed' };
    }

    await fsp.rename(partialPath, finalPath);
    const removed = listSessionsSnapshots().slice(Math.max(0, keep));
    await Promise.all(removed.map(removeSnapshot));
    return { ok: true, file: finalPath, removed };
  } catch (err) {
    console.warn('[sessions] snapshot failed:', err);
    return { ok: false, reason: 'error' };
  }
}

/**
 * Post-boot entry point. Opens the sessions DB lazily so this module stays out
 * of `sessions-db.js`'s import cycle (recovery there restores *from* snapshots).
 * @param {{ force?: boolean, keep?: number, minAgeMs?: number }} [options]
 */
export async function snapshotSessionsDbIfDue(options = {}) {
  try {
    if (process.env.MINNOW_SESSIONS_STORE === 'json') {
      return { ok: false, reason: 'json_store' };
    }
    if (!fs.existsSync(sessionsDbPath())) {
      return { ok: false, reason: 'no_db' };
    }
    const { initializeSessionsDb } = await import('./sessions-db.js');
    return await snapshotSessionsDb(await initializeSessionsDb(), options);
  } catch (err) {
    console.warn('[sessions] snapshot failed:', err);
    return { ok: false, reason: 'error' };
  }
}

/**
 * Copy the newest snapshot that passes `quick_check` over `sessions.db`.
 * Callers must have quarantined the corrupt DB first — this does not move it.
 * @returns {{ file: string } | null}
 */
export function restoreSessionsDbFromNewestSnapshot() {
  for (const filePath of listSessionsSnapshots()) {
    if (!verifySessionsSnapshot(filePath)) {
      console.warn(`[sessions] snapshot ${path.basename(filePath)} failed quick_check; skipping.`);
      continue;
    }
    try {
      fs.mkdirSync(path.dirname(sessionsDbPath()), { recursive: true });
      fs.copyFileSync(filePath, sessionsDbPath());
      return { file: filePath };
    } catch (err) {
      console.warn(`[sessions] restore from ${path.basename(filePath)} failed:`, err);
    }
  }
  return null;
}
