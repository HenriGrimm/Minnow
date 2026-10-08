/**
 * Write a backup archive of a Minnow home.
 *
 * Safe to run while Minnow is running: SQLite stores are copied through the
 * online backup API (WAL-consistent, never the raw file), small files are read
 * whole, and large files are read from one open handle so an atomic rewrite
 * underneath cannot interleave.
 */

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import { CREDENTIALS_CATEGORY, normalizeCategoryIds } from './catalog.js';
import {
  BACKUP_FILE_EXTENSION,
  MIN_PASSPHRASE_LENGTH,
  normalizePassphrase,
  writeArchive,
} from './format.js';
import { planBackup } from './plan.js';

/** Files at or under this size are read whole so their length is exact. */
const WHOLE_READ_MAX_BYTES = 4 * 1024 * 1024;
const STREAM_CHUNK_BYTES = 1024 * 1024;

export class BackupError extends Error {
  /**
   * @param {string} message
   * @param {string} [code]
   */
  constructor(message, code = 'backup_failed') {
    super(message);
    this.name = 'BackupError';
    this.code = code;
  }
}

/** @param {Date} [now] */
export function backupTimestamp(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`
  );
}

/**
 * @param {'backup' | 'snapshot'} kind
 * @param {Date} [now]
 */
export function backupFileName(kind, now = new Date()) {
  return `minnow-${kind}-${backupTimestamp(now)}${BACKUP_FILE_EXTENSION}`;
}

/**
 * Throw unless `passphrase` is acceptable for a new encrypted archive.
 * @param {string} passphrase
 */
export function assertUsablePassphrase(passphrase) {
  if (normalizePassphrase(passphrase).length < MIN_PASSPHRASE_LENGTH) {
    throw new BackupError(
      `Passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.`,
      'weak_passphrase',
    );
  }
}

/**
 * True when `target` is `parent` or sits inside it.
 * @param {string} parent
 * @param {string} target
 */
export function isPathInside(parent, target) {
  const rel = path.relative(path.resolve(parent), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Stream exactly the bytes a file held when it was opened.
 * @param {string} abs
 * @returns {Promise<{ size: number, chunks: AsyncGenerator<Buffer> }>}
 */
async function openStable(abs) {
  const handle = await fsp.open(abs, 'r');
  let size;
  try {
    size = (await handle.stat()).size;
  } catch (err) {
    await handle.close();
    throw err;
  }
  async function* chunks() {
    try {
      let offset = 0;
      while (offset < size) {
        const want = Math.min(STREAM_CHUNK_BYTES, size - offset);
        const buffer = Buffer.allocUnsafe(want);
        const { bytesRead } = await handle.read(buffer, 0, want, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
        yield bytesRead === want ? buffer : buffer.subarray(0, bytesRead);
      }
    } finally {
      await handle.close();
    }
  }
  return { size, chunks: chunks() };
}

/**
 * Copy a live SQLite store to `dest` and confirm the copy is sound. Returns
 * false when the file is not a SQLite database, so the caller copies it raw.
 * @param {string} abs
 * @param {string} dest
 */
async function snapshotSqlite(abs, dest) {
  /** @type {import('better-sqlite3').Database | null} */
  let db = null;
  try {
    db = new Database(abs, { readonly: true, fileMustExist: true });
    db.pragma('busy_timeout = 5000');
    await db.backup(dest);
  } catch (err) {
    const code = /** @type {{ code?: unknown }} */ (err)?.code;
    if (code === 'SQLITE_NOTADB') return false;
    throw err;
  } finally {
    try {
      db?.close();
    } catch {
    }
  }

  /** @type {import('better-sqlite3').Database | null} */
  let copy = null;
  try {
    copy = new Database(dest, { readonly: true, fileMustExist: true });
    if (copy.pragma('quick_check', { simple: true }) !== 'ok') {
      throw new BackupError(
        `${path.basename(abs)} failed its integrity check, so it was not backed up. ` +
          'Leave its category out to back up everything else.',
        'corrupt_source',
      );
    }
  } finally {
    try {
      copy?.close();
    } catch {
    }
  }
  return true;
}

/** @param {string} appRoot */
async function readAppVersion(appRoot) {
  try {
    const pkg = JSON.parse(await fsp.readFile(path.join(appRoot, 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : '';
  } catch {
    return '';
  }
}

/**
 * @param {{
 *   home: string,
 *   outPath: string,
 *   categories?: string[],
 *   passphrase?: string,
 *   appRoot?: string,
 *   label?: string,
 *   plan?: import('./plan.js').BackupPlan,
 *   onProgress?: (progress: { bytes: number, totalBytes: number, files: number, totalFiles: number }) => void,
 *   kdf?: { N: number, r: number, p: number },
 * }} options
 * @returns {Promise<{
 *   file: string,
 *   archiveBytes: number,
 *   files: number,
 *   bytes: number,
 *   encrypted: boolean,
 *   categories: Array<{ id: string, files: number, bytes: number }>,
 *   credentialsOmitted: number,
 *   includesCredentials: boolean,
 * }>}
 */
export async function createBackup({
  home,
  outPath,
  categories,
  passphrase,
  appRoot,
  label,
  plan: givenPlan,
  onProgress,
  kdf,
}) {
  const resolvedHome = path.resolve(home);
  const resolvedOut = path.resolve(outPath);
  if (isPathInside(resolvedHome, resolvedOut)) {
    throw new BackupError(
      'Choose a folder outside the Minnow data folder. A backup stored beside the data it protects is lost with it.',
      'dest_inside_home',
    );
  }

  const encrypted = typeof passphrase === 'string' && passphrase.length > 0;
  if (encrypted) assertUsablePassphrase(/** @type {string} */ (passphrase));

  const wanted = normalizeCategoryIds(categories);
  const includeCredentials = encrypted && wanted.includes(CREDENTIALS_CATEGORY);
  const plan =
    givenPlan ?? (await planBackup({ home: resolvedHome, categories: wanted, includeCredentials, encrypted }));
  if (!encrypted && plan.files.some(file => file.category === 'reef')) {
    throw new Error('Reef apps require a passphrase-protected backup.');
  }
  if (plan.includesCredentials && !encrypted) {
    throw new BackupError(
      'Credentials and the encryption key are only saved in passphrase-protected backups.',
      'credentials_need_passphrase',
    );
  }
  if (plan.files.length === 0) {
    throw new BackupError('Nothing to back up: the selected categories are empty.', 'empty');
  }

  await fsp.mkdir(path.dirname(resolvedOut), { recursive: true });
  const partialPath = `${resolvedOut}.partial`;
  await fsp.rm(partialPath, { force: true });

  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'minnow-backup-'));
  let doneBytes = 0;
  let doneFiles = 0;
  const report = () =>
    onProgress?.({
      bytes: doneBytes,
      totalBytes: plan.totals.bytes,
      files: doneFiles,
      totalFiles: plan.totals.files,
    });

  /**
   * @param {AsyncIterable<Buffer>} chunks
   */
  async function* counted(chunks) {
    for await (const chunk of chunks) {
      doneBytes += chunk.length;
      yield chunk;
      report();
    }
  }

  async function* entries() {
    for (const file of plan.files) {
      /** @type {{ p: string, s: number, m: number, c: string, k?: 1, q?: 1 }} */
      const meta = { p: file.rel, s: 0, m: Math.trunc(file.mtimeMs), c: file.category };
      if (file.credential) meta.k = 1;

      if (file.kind === 'json') {
        const body = Buffer.from(`${JSON.stringify(file.json, null, 2)}\n`, 'utf8');
        meta.s = body.length;
        yield { meta, chunks: counted([body]) };
      } else if (file.kind === 'sqlite') {
        const copyPath = path.join(workDir, `db-${doneFiles}.sqlite`);
        let source = file.abs;
        try {
          if (await snapshotSqlite(file.abs, copyPath)) {
            source = copyPath;
            meta.q = 1;
          }
          const opened = await openStable(source);
          meta.s = opened.size;
          yield { meta, chunks: counted(opened.chunks) };
        } finally {
          await fsp.rm(copyPath, { force: true });
        }
      } else {
        let stat;
        try {
          stat = await fsp.stat(file.abs);
        } catch (err) {
          // Deleted between planning and writing — a backup of a live home tolerates that.
          if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') continue;
          throw err;
        }
        if (stat.size <= WHOLE_READ_MAX_BYTES) {
          let body;
          try {
            body = await fsp.readFile(file.abs);
          } catch (err) {
            if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') continue;
            throw err;
          }
          meta.s = body.length;
          yield { meta, chunks: counted([body]) };
        } else {
          const opened = await openStable(file.abs);
          meta.s = opened.size;
          yield { meta, chunks: counted(opened.chunks) };
        }
      }
      doneFiles += 1;
      report();
    }
  }

  const header = {
    app: 'minnow',
    appVersion: appRoot ? await readAppVersion(appRoot) : '',
    createdAt: new Date().toISOString(),
    platform: process.platform,
    label: label ?? '',
    categories: plan.categories,
    roots: plan.roots,
    totals: plan.totals,
    includesCredentials: plan.includesCredentials,
    credentialsOmitted: plan.credentialsOmitted,
    redacted: plan.redacted,
  };

  try {
    const written = await writeArchive({
      outPath: partialPath,
      header,
      passphrase: encrypted ? passphrase : undefined,
      entries: entries(),
      kdf,
    });
    await fsp.rename(partialPath, resolvedOut);
    return {
      file: resolvedOut,
      archiveBytes: written.archiveBytes,
      files: written.files,
      bytes: written.bytes,
      encrypted,
      categories: plan.categories,
      credentialsOmitted: plan.credentialsOmitted,
      includesCredentials: plan.includesCredentials,
    };
  } catch (err) {
    await fsp.rm(partialPath, { force: true });
    throw err;
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true });
  }
}
