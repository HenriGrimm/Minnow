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

/** @type {Map<string, import('better-sqlite3').Database>} */
const dbByCacheKey = new Map();

export {
  ensureColumn,
  readSessionMeta,
  writeSessionMeta,
  SESSIONS_DB_SCHEMA_VERSION,
};

function sessionsDbCacheKey() {
  return `${getMinnowHome()}\0sessions`;
}

function openSessionsDatabase() {
  fs.mkdirSync(sessionsRootDir(), { recursive: true });
  const db = new Database(sessionsDbPath());
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    initSessionsSchema(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
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

  let db;
  let quickCheck;
  try {
    db = openSessionsDatabase();
    quickCheck = db.pragma('quick_check', { simple: true });
  } catch (error) {
    db?.close();
    db = null;
    if (error.code !== 'SQLITE_NOTADB' && !/^SQLITE_CORRUPT(?:_|$)/.test(error.code)) throw error;
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
