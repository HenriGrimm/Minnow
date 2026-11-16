import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { getMinnowHome } from './home.js';
import {
  sessionsDbPath,
  sessionsRootDir,
} from './sessions-paths.js';
import {
  ensureColumn,
  initSessionsSchema,
  readSessionMeta,
  writeSessionMeta,
  SESSIONS_DB_SCHEMA_VERSION,
} from './sessions-schema.js';
import { importJsonSessionsIfNeeded } from './sessions-import.js';
import { restoreSessionsDbFromNewestSnapshot } from './sessions-snapshot.js';
import { runSessionsMaintenance } from './sessions-maintenance.js';
import { checkMappedSessionsIntegrity } from './sessions-integrity.js';

/** @type {Map<string, import('better-sqlite3').Database>} */
const dbByCacheKey = new Map();
const initializationByCacheKey = new Map();
const MAPPED_CHECK_MIN_BYTES = 256 * 1024 * 1024;

export {
  ensureColumn,
  readSessionMeta,
  writeSessionMeta,
  SESSIONS_DB_SCHEMA_VERSION,
};

function sessionsDbCacheKey() {
  return `${getMinnowHome()}\0sessions`;
}

function openSessionsDatabase({ prepared = false } = {}) {
  fs.mkdirSync(sessionsRootDir(), { recursive: true });
  const db = new Database(sessionsDbPath());
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    if (!prepared) initSessionsSchema(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/** Prepare and recover the store before synchronous repository consumers start. */
export function initializeSessionsDb() {
  const cacheKey = sessionsDbCacheKey();
  const existing = dbByCacheKey.get(cacheKey);
  if (existing) return Promise.resolve(existing);
  const pending = initializationByCacheKey.get(cacheKey);
  if (pending) return pending;

  const initialization = runSessionsMaintenance('initialize').then(() => {
    const db = openSessionsDatabase({ prepared: true });
    dbByCacheKey.set(cacheKey, db);
    return db;
  }).finally(() => initializationByCacheKey.delete(cacheKey));
  initializationByCacheKey.set(cacheKey, initialization);
  return initialization;
}

/** Attach a maintenance worker to an already initialized store for a consistent read. */
export function openSessionsDbForRead() {
  const db = new Database(sessionsDbPath(), { readonly: true, fileMustExist: true });
  db.pragma('busy_timeout = 5000');
  dbByCacheKey.set(sessionsDbCacheKey(), db);
  return db;
}

/** Materialize the store in the maintenance worker before the host can use it. */
export async function prepareSessionsDb() {
  const filePath = sessionsDbPath();
  if ((process.arch === 'x64' || process.arch === 'arm64')
    && (fs.statSync(filePath, { throwIfNoEntry: false })?.size ?? 0) >= MAPPED_CHECK_MIN_BYTES
    && await prepareWithMappedCheck(filePath)) return;

  getSessionsDb();
  closeSessionsDb();
}

async function prepareWithMappedCheck(filePath) {
  let db;
  try {
    db = openSessionsDatabase();
    // The child reads a committed WAL snapshot. Fence other SQLite writers until it reports.
    db.exec('BEGIN IMMEDIATE');
    try {
      const before = fs.statSync(filePath, { bigint: true, throwIfNoEntry: false });
      if (!before || !await checkMappedSessionsIntegrity(filePath)) return false;
      const after = fs.statSync(filePath, { bigint: true, throwIfNoEntry: false });
      if (!after || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) return false;
    } finally {
      db.exec('ROLLBACK');
    }
    importJsonSessionsIfNeeded(db);
    return true;
  } catch (error) {
    if (!isSessionsCorruption(error)) throw error;
    return false;
  } finally {
    db?.close();
  }
}

function isSessionsCorruption(error) {
  return error.code === 'SQLITE_NOTADB' || /^SQLITE_CORRUPT(?:_|$)/.test(error.code);
}

/**
 * @returns {string}
 */
function quarantineCorruptSessionsDb() {
  const ts = Date.now();
  const base = sessionsDbPath();
  const moved = [];
  try {
    for (const suffix of ['-shm', '-wal', '']) {
      const filePath = base + suffix;
      if (!fs.existsSync(filePath)) continue;
      fs.renameSync(filePath, filePath + '.corrupt-' + ts);
      moved.push(filePath);
    }
  } catch (error) {
    for (const filePath of moved.reverse()) fs.renameSync(filePath + '.corrupt-' + ts, filePath);
    throw error;
  }
  return String(ts);
}

/**
 * @returns {import('better-sqlite3').Database}
 */
export function getSessionsDb() {
  const cacheKey = sessionsDbCacheKey();
  const existing = dbByCacheKey.get(cacheKey);
  if (existing) {
    return existing;
  }
  if (initializationByCacheKey.has(cacheKey)) {
    throw new Error('The sessions database is still being initialized');
  }

  let db;
  let quickCheck;
  try {
    db = openSessionsDatabase();
    quickCheck = db.pragma('quick_check', { simple: true });
  } catch (error) {
    db?.close();
    db = null;
    if (!isSessionsCorruption(error)) throw error;
    quickCheck = error.code;
  }
  if (quickCheck !== 'ok') {
    db?.close();
    const ts = quarantineCorruptSessionsDb();
    // A verified snapshot is a whole DB (FTS index, runs, meta, revision), so it
    // beats the legacy JSON blob; fall back to that only when none is usable.
    const restored = restoreSessionsDbFromNewestSnapshot();
    db = openSessionsDatabase();
    writeSessionMeta(db, 'dbCorruptRecoveredAt', new Date().toISOString());
    writeSessionMeta(db, 'dbCorruptQuickCheck', String(quickCheck));
    writeSessionMeta(db, 'dbCorruptQuarantineTs', ts);
    if (restored) {
      writeSessionMeta(db, 'dbRestoredFromSnapshotAt', new Date().toISOString());
      writeSessionMeta(db, 'dbRestoredFromSnapshotFile', path.basename(restored.file));
    } else {
      importJsonSessionsIfNeeded(db, { recovery: true });
    }
  } else {
    importJsonSessionsIfNeeded(db);
  }

  dbByCacheKey.set(cacheKey, db);
  return db;
}

export function closeSessionsDb() {
  const cacheKey = sessionsDbCacheKey();
  const db = dbByCacheKey.get(cacheKey);
  if (!db) return false;
  db.close();
  dbByCacheKey.delete(cacheKey);
  return true;
}

export function deleteSessionsDb() {
  if (initializationByCacheKey.has(sessionsDbCacheKey())) {
    throw new Error('Cannot delete the sessions database during initialization');
  }
  closeSessionsDb();
  const base = sessionsDbPath();
  let removed = false;
  for (const suffix of ['', '-wal', '-shm']) {
    const filePath = `${base}${suffix}`;
    if (fs.existsSync(filePath)) {
      fs.rmSync(filePath, { force: true });
      if (!suffix) removed = true;
    }
  }
  return removed;
}

export function openSessionsDbCountForTests() {
  return dbByCacheKey.size;
}
