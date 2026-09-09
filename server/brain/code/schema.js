/**
 * SQLite schema for the per-workspace Brain code index (~/.minnow/brain/code/<key>.db).
 * WAL + singleton handle, same pattern as other SQLite stores under ~/.minnow.
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { getBrainCodeDir, brainWorkspaceKeyFromPath } from '../paths.js';
import { getEffectiveWorkspaceRoot } from '../../runtime/path-access.js';
import { getMinnowHome } from '../../config/home.js';

/** @type {Map<string, import('better-sqlite3').Database>} */
const dbByWorkspaceKey = new Map();

/** LRU order for open handles — oldest at index 0. */
const dbCacheLru = [];

/** Cap in-memory SQLite handles so many MRU workspaces do not leak file descriptors. */
export const MAX_OPEN_CODE_DBS = 8;

/** Bump when schema migrations require FTS rebuild or similar (stored in PRAGMA user_version). */
export const CODE_SCHEMA_VERSION = 2;

/** Absolute path for a workspace code-index database file. */
export function codeDbPath(workspaceKey) {
  const slug = String(workspaceKey ?? '').trim() || 'workspace';
  return path.join(getBrainCodeDir(), `${slug}.db`);
}

/**
 * Initialize tables on a fresh database connection.
 * @param {import('better-sqlite3').Database} database
 */
function initSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS symbols (
      id TEXT PRIMARY KEY,
      repo TEXT NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      file TEXT NOT NULL,
      line_start INTEGER NOT NULL,
      line_end INTEGER NOT NULL,
      signature TEXT NOT NULL DEFAULT '',
      doc TEXT NOT NULL DEFAULT '',
      content_hash TEXT NOT NULL DEFAULT '',
      pagerank REAL NOT NULL DEFAULT 0,
      usage_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS edges (
      src_symbol TEXT NOT NULL,
      dst_symbol TEXT NOT NULL,
      kind TEXT NOT NULL,
      PRIMARY KEY (src_symbol, dst_symbol, kind)
    );

    CREATE TABLE IF NOT EXISTS file_hashes (
      repo TEXT NOT NULL,
      file TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      mtime_ms INTEGER NOT NULL,
      index_error TEXT,
      PRIMARY KEY (repo, file)
    );

    CREATE TABLE IF NOT EXISTS anchors (
      page_id TEXT NOT NULL,
      symbol_id TEXT NOT NULL,
      repo TEXT NOT NULL,
      symbol_hash_at_synth TEXT NOT NULL,
      PRIMARY KEY (page_id, symbol_id)
    );

    CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file);
    CREATE INDEX IF NOT EXISTS idx_symbols_repo ON symbols(repo);
    CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
    CREATE INDEX IF NOT EXISTS idx_edges_src ON edges(src_symbol);
    CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst_symbol);
  `);

  migrateCodeSchema(database);
}

/** FTS5 external-content table — triggers on symbols keep the index in sync. */
function createSymbolsFtsTable(database) {
  database.exec(`
    CREATE VIRTUAL TABLE symbols_fts USING fts5(
      name,
      file,
      signature,
      doc,
      content='symbols',
      content_rowid='rowid',
      tokenize='porter unicode61'
    );
  `);
}

/** Sync triggers for external-content FTS5 (delete row carries old values on update). */
function createSymbolsFtsTriggers(database) {
  database.exec(`
    CREATE TRIGGER IF NOT EXISTS symbols_fts_ai AFTER INSERT ON symbols BEGIN
      INSERT INTO symbols_fts(rowid, name, file, signature, doc)
      VALUES (new.rowid, new.name, new.file, new.signature, new.doc);
    END;
    CREATE TRIGGER IF NOT EXISTS symbols_fts_ad AFTER DELETE ON symbols BEGIN
      INSERT INTO symbols_fts(symbols_fts, rowid, name, file, signature, doc)
      VALUES('delete', old.rowid, old.name, old.file, old.signature, old.doc);
    END;
    CREATE TRIGGER IF NOT EXISTS symbols_fts_au AFTER UPDATE ON symbols BEGIN
      INSERT INTO symbols_fts(symbols_fts, rowid, name, file, signature, doc)
      VALUES('delete', old.rowid, old.name, old.file, old.signature, old.doc);
      INSERT INTO symbols_fts(rowid, name, file, signature, doc)
      VALUES (new.rowid, new.name, new.file, new.signature, new.doc);
    END;
  `);
}

/** Drop legacy FTS triggers before replacing the virtual table. */
function dropSymbolsFtsTriggers(database) {
  for (const name of ['symbols_fts_ai', 'symbols_fts_ad', 'symbols_fts_au']) {
    database.exec(`DROP TRIGGER IF EXISTS ${name}`);
  }
}

/**
 * Rebuild external-content FTS from symbols (in-place migration, no reindex).
 * @param {import('better-sqlite3').Database} database
 */
function rebuildSymbolsFtsExternal(database) {
  dropSymbolsFtsTriggers(database);
  database.exec('DROP TABLE IF EXISTS symbols_fts');
  createSymbolsFtsTable(database);
  createSymbolsFtsTriggers(database);
  database.exec(`INSERT INTO symbols_fts(symbols_fts) VALUES('rebuild')`);
}

/** Add file_hashes.index_error when upgrading from v1. */
function migrateFileHashesColumns(database) {
  const cols = database.prepare('PRAGMA table_info(file_hashes)').all();
  const hasError = cols.some((c) => c.name === 'index_error');
  if (!hasError) {
    database.exec('ALTER TABLE file_hashes ADD COLUMN index_error TEXT');
  }
}

/**
 * Schema migrations via PRAGMA user_version (FTS layout, file_hashes columns).
 * @param {import('better-sqlite3').Database} database
 */
function migrateCodeSchema(database) {
  const ftsExists = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='symbols_fts'")
    .get();
  const version = Number(database.pragma('user_version', { simple: true }) ?? 0);

  if (version >= CODE_SCHEMA_VERSION) {
    if (!ftsExists) {
      rebuildSymbolsFtsExternal(database);
    } else {
      createSymbolsFtsTriggers(database);
    }
    migrateFileHashesColumns(database);
    return;
  }

  const tx = database.transaction(() => {
    migrateFileHashesColumns(database);
    rebuildSymbolsFtsExternal(database);
    database.pragma(`user_version = ${CODE_SCHEMA_VERSION}`);
  });
  tx();
}

/** Cache key combines MINNOW_HOME + workspace slug so parallel tests do not share handles. */
function codeDbCacheKey(workspaceKey) {
  const slug = String(workspaceKey ?? '').trim() || 'workspace';
  return `${getMinnowHome()}\0${slug}`;
}

/** Move a cache key to the MRU end of the LRU list. */
function touchCodeDbCache(cacheKey) {
  const idx = dbCacheLru.indexOf(cacheKey);
  if (idx >= 0) dbCacheLru.splice(idx, 1);
  dbCacheLru.push(cacheKey);
}

/** Close the least-recently-used handle when the cache is full. */
function evictOldestCodeDbIfNeeded() {
  while (dbCacheLru.length >= MAX_OPEN_CODE_DBS) {
    const oldest = dbCacheLru.shift();
    if (!oldest) break;
    const db = dbByWorkspaceKey.get(oldest);
    if (db) {
      db.close();
      dbByWorkspaceKey.delete(oldest);
    }
  }
}

/**
 * Open (or reuse) the code index DB for a workspace key.
 * @param {string} [workspaceKey]
 * @returns {import('better-sqlite3').Database}
 */
export function getCodeDb(workspaceKey) {
  const key =
    workspaceKey?.trim() ||
    brainWorkspaceKeyFromPath(getEffectiveWorkspaceRoot()) ||
    'workspace';
  const cacheKey = codeDbCacheKey(key);
  const existing = dbByWorkspaceKey.get(cacheKey);
  if (existing) {
    touchCodeDbCache(cacheKey);
    return existing;
  }

  evictOldestCodeDbIfNeeded();

  const dir = getBrainCodeDir();
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(codeDbPath(key));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  initSchema(db);
  dbByWorkspaceKey.set(cacheKey, db);
  touchCodeDbCache(cacheKey);
  return db;
}

/** Close all open code-index DB handles (tests). */
export function closeCodeDbForTests() {
  for (const db of dbByWorkspaceKey.values()) {
    db.close();
  }
  dbByWorkspaceKey.clear();
  dbCacheLru.length = 0;
}

/** Close the SQLite handle for one workspace key if it is cached. */
function closeCodeDbForKey(workspaceKey) {
  const key = String(workspaceKey ?? '').trim() || 'workspace';
  const cacheKey = codeDbCacheKey(key);
  const db = dbByWorkspaceKey.get(cacheKey);
  if (db) {
    db.close();
    dbByWorkspaceKey.delete(cacheKey);
    const idx = dbCacheLru.indexOf(cacheKey);
    if (idx >= 0) dbCacheLru.splice(idx, 1);
  }
}

/** Delete .db / -wal / -shm files for one workspace key. */
function removeCodeDbFiles(workspaceKey) {
  const base = codeDbPath(workspaceKey);
  let removed = false;
  for (const suffix of ['', '-wal', '-shm']) {
    const fp = `${base}${suffix}`;
    if (fs.existsSync(fp)) {
      fs.unlinkSync(fp);
      if (!suffix) removed = true;
    }
  }
  return removed;
}

/**
 * Remove code-index SQLite database(s) for one workspace or all workspaces.
 * @param {{ workspaceKey?: string, all?: boolean }} [opts]
 * @returns {{ removed: number, workspaceKeys: string[] }}
 */
export function clearCodeIndex(opts = {}) {
  if (opts.all === true) {
    closeCodeDbForTests();
    const dir = getBrainCodeDir();
    const keys = [];
    if (fs.existsSync(dir)) {
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.db')) continue;
        const key = name.slice(0, -3);
        if (removeCodeDbFiles(key)) keys.push(key);
      }
    }
    return { removed: keys.length, workspaceKeys: keys };
  }

  const key =
    opts.workspaceKey?.trim() ||
    brainWorkspaceKeyFromPath(getEffectiveWorkspaceRoot()) ||
    'workspace';
  closeCodeDbForKey(key);
  const removed = removeCodeDbFiles(key);
  return { removed: removed ? 1 : 0, workspaceKeys: removed ? [key] : [] };
}

/** Test helper — count of open in-memory code-index handles. */
export function openCodeDbCountForTests() {
  return dbByWorkspaceKey.size;
}

/**
 * Remove all index rows for a file that no longer exists on disk (symbols, FTS, edges, file_hashes).
 * @param {import('better-sqlite3').Database} db
 * @param {string} repo
 * @param {string} file — workspace-relative posix path
 */
export function purgeFileFromIndex(db, repo, file) {
  const relFile = String(file ?? '').trim().replace(/\\/g, '/');
  if (!relFile) return;
  deleteSymbolsForFile(db, repo, relFile);
  db.prepare('DELETE FROM file_hashes WHERE repo = ? AND file = ?').run(repo, relFile);
}

/** Cached prepared statements per open DB handle (avoid recompile in hot loops). */
/** @type {WeakMap<import('better-sqlite3').Database, Record<string, import('better-sqlite3').Statement>>} */
const writeStmtsByDb = new WeakMap();

/**
 * @param {import('better-sqlite3').Database} db
 */
function getWriteStmts(db) {
  let stmts = writeStmtsByDb.get(db);
  if (!stmts) {
    stmts = {
      selectSymbolIdsForFile: db.prepare(
        'SELECT id FROM symbols WHERE repo = ? AND file = ?',
      ),
      delEdge: db.prepare(
        'DELETE FROM edges WHERE src_symbol = ? OR dst_symbol = ?',
      ),
      delSym: db.prepare('DELETE FROM symbols WHERE id = ?'),
      upsertSymbol: db.prepare(
        `INSERT INTO symbols (
          id, repo, kind, name, file, line_start, line_end,
          signature, doc, content_hash, pagerank, usage_count
        ) VALUES (
          @id, @repo, @kind, @name, @file, @line_start, @line_end,
          @signature, @doc, @content_hash, @pagerank, @usage_count
        )
        ON CONFLICT(id) DO UPDATE SET
          repo = excluded.repo,
          kind = excluded.kind,
          name = excluded.name,
          file = excluded.file,
          line_start = excluded.line_start,
          line_end = excluded.line_end,
          signature = excluded.signature,
          doc = excluded.doc,
          content_hash = excluded.content_hash,
          usage_count = excluded.usage_count`,
      ),
      upsertEdge: db.prepare(
        `INSERT INTO edges (src_symbol, dst_symbol, kind)
         VALUES (?, ?, ?)
         ON CONFLICT(src_symbol, dst_symbol, kind) DO NOTHING`,
      ),
      upsertFileHash: db.prepare(
        `INSERT INTO file_hashes (repo, file, sha256, mtime_ms, index_error)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(repo, file) DO UPDATE SET
           sha256 = excluded.sha256,
           mtime_ms = excluded.mtime_ms,
           index_error = excluded.index_error`,
      ),
      updateUsageCount: db.prepare('UPDATE symbols SET usage_count = ? WHERE id = ?'),
    };
    writeStmtsByDb.set(db, stmts);
  }
  return stmts;
}

/** Remove symbols (and edges) for one file before re-indexing it. FTS syncs via triggers. */
export function deleteSymbolsForFile(db, repo, file) {
  const stmts = getWriteStmts(db);
  const ids = stmts.selectSymbolIdsForFile
    .all(repo, file)
    .map((row) => row.id);
  if (ids.length === 0) return;
  const tx = db.transaction((symbolIds) => {
    for (const id of symbolIds) {
      stmts.delEdge.run(id, id);
      stmts.delSym.run(id);
    }
  });
  tx(ids);
}

/**
 * Replace all symbols for one file in a single transaction (cached statements).
 * @param {import('better-sqlite3').Database} db
 * @param {string} repo
 * @param {string} relFile
 * @param {Array<Record<string, unknown>>} rows
 */
export function writeFileSymbols(db, repo, relFile, rows) {
  const stmts = getWriteStmts(db);
  const tx = db.transaction((symbolRows) => {
    const ids = stmts.selectSymbolIdsForFile
      .all(repo, relFile)
      .map((row) => row.id);
    for (const id of ids) {
      stmts.delEdge.run(id, id);
      stmts.delSym.run(id);
    }
    for (const row of symbolRows) {
      stmts.upsertSymbol.run(row);
    }
  });
  tx(rows);
}

/** Upsert one symbol row (FTS maintained by triggers). */
export function upsertSymbol(db, row) {
  getWriteStmts(db).upsertSymbol.run(row);
}

/** Upsert a directed graph edge (calls, imports, extends, uses). */
export function upsertEdge(db, srcSymbol, dstSymbol, kind) {
  if (!srcSymbol || !dstSymbol || srcSymbol === dstSymbol) return;
  getWriteStmts(db).upsertEdge.run(srcSymbol, dstSymbol, kind);
}

/**
 * Record file content hash after an index pass (success or recorded failure).
 * @param {string | null | undefined} indexError — set when LSP/index failed for this file
 */
export function upsertFileHash(db, repo, file, sha256, mtimeMs, indexError = null) {
  getWriteStmts(db).upsertFileHash.run(
    repo,
    file,
    sha256,
    mtimeMs,
    indexError ?? null,
  );
}

/**
 * Refresh only `mtime_ms` for files whose content hash is unchanged.
 *
 * A fresh `git worktree add` (every board attempt) rewrites the mtime of every file while
 * the bytes stay identical. Without this the mtime fast-path in `detectStaleFiles` misses
 * forever and each query re-hashes the whole tree. Content hash and `index_error` are left
 * alone — nothing was re-indexed, so nothing else may be claimed.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} repo
 * @param {Array<{ file: string, mtimeMs: number }>} entries
 * @returns {number} rows touched
 */
export function refreshFileMtimes(db, repo, entries) {
  const rows = Array.isArray(entries) ? entries : [];
  if (rows.length === 0) return 0;
  const stmt = db.prepare('UPDATE file_hashes SET mtime_ms = ? WHERE repo = ? AND file = ?');
  const tx = db.transaction((batch) => {
    let touched = 0;
    for (const row of batch) {
      touched += stmt.run(Number(row.mtimeMs) || 0, repo, String(row.file)).changes;
    }
    return touched;
  });
  return tx(rows);
}

/**
 * Persist computed PageRank scores.
 *
 * `personalizedPageRank` returns a Map. `Object.entries(map)` is always `[]`, so the
 * previous version silently wrote nothing and every symbol kept pagerank 0.
 * @param {import('better-sqlite3').Database} db
 * @param {Map<string, number> | Record<string, number>} scores
 * @returns {number} rows updated
 */
export function writePageRanks(db, scores) {
  const entries =
    scores instanceof Map ? [...scores.entries()] : Object.entries(scores ?? {});
  if (entries.length === 0) return 0;

  const stmt = db.prepare('UPDATE symbols SET pagerank = ? WHERE id = ?');
  const tx = db.transaction((rows) => {
    let updated = 0;
    for (const [id, score] of rows) {
      updated += stmt.run(Number(score) || 0, id).changes;
    }
    return updated;
  });
  return tx(entries);
}

/** Aggregate index stats for status endpoints (scoped to one repo key when provided). */
export function getIndexStats(db, repo) {
  const repoKey = typeof repo === 'string' ? repo.trim() : '';
  if (repoKey) {
    const symbols =
      db.prepare('SELECT COUNT(*) AS n FROM symbols WHERE repo = ?').get(repoKey)?.n ?? 0;
    const files =
      db.prepare('SELECT COUNT(*) AS n FROM file_hashes WHERE repo = ?').get(repoKey)?.n ?? 0;
    const lastMtime = db
      .prepare('SELECT MAX(mtime_ms) AS m FROM file_hashes WHERE repo = ?')
      .get(repoKey)?.m;
    const edges =
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM edges e
           WHERE EXISTS (SELECT 1 FROM symbols s WHERE s.id = e.src_symbol AND s.repo = ?)
              OR EXISTS (SELECT 1 FROM symbols s WHERE s.id = e.dst_symbol AND s.repo = ?)`,
        )
        .get(repoKey, repoKey)?.n ?? 0;
    return {
      symbolCount: symbols,
      edgeCount: edges,
      fileCount: files,
      lastIndexedAt: lastMtime ? new Date(lastMtime).toISOString() : null,
    };
  }

  const symbols = db.prepare('SELECT COUNT(*) AS n FROM symbols').get()?.n ?? 0;
  const edges = db.prepare('SELECT COUNT(*) AS n FROM edges').get()?.n ?? 0;
  const files = db.prepare('SELECT COUNT(*) AS n FROM file_hashes').get()?.n ?? 0;
  const lastMtime = db
    .prepare('SELECT MAX(mtime_ms) AS m FROM file_hashes')
    .get()?.m;
  return {
    symbolCount: symbols,
    edgeCount: edges,
    fileCount: files,
    lastIndexedAt: lastMtime ? new Date(lastMtime).toISOString() : null,
  };
}
