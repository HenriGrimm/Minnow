/**
 * Preview a backup and stage it for restore.
 *
 * Staging extracts and verifies the whole archive into the home's
 * `restore-staging/` folder and leaves a marker; the swap itself happens at the
 * next start (`restore-apply.js`), when nothing has the home open.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';

import {
  CREDENTIALS_CATEGORY,
  PRE_RESTORE_DIRNAME,
  RESTORE_STAGING_DIRNAME,
  findRoot,
  findRootForPath,
  getCategory,
} from './catalog.js';
import { BackupError } from './export.js';
import {
  BACKUP_FILE_EXTENSION,
  BackupFormatError,
  looksLikeBackup,
  readArchive,
  readArchiveHeader,
  verifyArchivePassphrase,
} from './format.js';
import {
  findStrandedCredentialFiles,
  readLastRestore,
  readPendingRestore,
  preRestoreDir,
  restorePendingPath,
  restoreStagingDir,
} from './restore-apply.js';

/** Extra room demanded beyond the archive's unpacked size before staging. */
const FREE_SPACE_MARGIN = 1.1;

/**
 * Compare dotted versions numerically; non-numeric tails are ignored.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compareVersions(a, b) {
  const parse = (value) =>
    String(value ?? '')
      .split('-')[0]
      .split('.')
      .map((part) => Number.parseInt(part, 10) || 0);
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * A home-relative archive path that cannot escape the staging tree.
 * @param {unknown} rel
 */
function isSafeEntryPath(rel) {
  if (typeof rel !== 'string' || !rel || rel.length > 1024) return false;
  if (rel.includes('\0') || rel.includes('\\') || rel.startsWith('/')) return false;
  if (/^[a-zA-Z]:/.test(rel)) return false;
  return rel.split('/').every((part) => part && part !== '.' && part !== '..');
}

/** Characters NTFS refuses in a file name; `:` would address an alternate data stream. */
const WINDOWS_ILLEGAL_NAME = /[<>:"|?*\u0000-\u001f]|[ .]$/;

/**
 * False for a path that is legal where the backup was made but cannot be
 * created on this platform.
 * @param {string} rel
 */
function isStorableHere(rel) {
  if (process.platform !== 'win32') return true;
  return rel.split('/').every((part) => !WINDOWS_ILLEGAL_NAME.test(part));
}

/**
 * @param {Record<string, any>} header
 * @param {string} currentVersion
 * @returns {string[]}
 */
function versionWarnings(header, currentVersion) {
  const warnings = [];
  const made = typeof header.appVersion === 'string' ? header.appVersion : '';
  if (made && currentVersion) {
    const order = compareVersions(made, currentVersion);
    if (order > 0) {
      warnings.push(
        `This backup was made by Minnow ${made}, which is newer than the ${currentVersion} you are running. ` +
          'Some of it may not load until you update.',
      );
    } else if (order < 0) {
      warnings.push(
        `This backup was made by Minnow ${made}. Its data is upgraded to ${currentVersion} the first time Minnow starts after the restore.`,
      );
    }
  }
  return warnings;
}

/**
 * Read a backup's header into a preview. Asks for nothing but the file — and,
 * for an encrypted backup, optionally checks a passphrase.
 *
 * @param {{ archivePath: string, passphrase?: string, appVersion?: string }} options
 */
export async function inspectBackup({ archivePath, passphrase, appVersion = '' }) {
  const resolved = path.resolve(archivePath);
  const { header, archiveBytes } = await readArchiveHeader(resolved);
  /** @type {string[]} */
  const warnings = versionWarnings(header, appVersion);

  const categories = (Array.isArray(header.categories) ? header.categories : [])
    .filter((row) => row && typeof row.id === 'string')
    .map((row) => {
      const known = getCategory(row.id);
      return {
        id: row.id,
        label: known?.label ?? row.id,
        description: known?.description ?? '',
        files: Number(row.files) || 0,
        bytes: Number(row.bytes) || 0,
        known: Boolean(known),
      };
    });
  if (categories.some((row) => !row.known)) {
    warnings.push('Part of this backup is from a newer Minnow and will be skipped.');
  }
  if (!header.includesCredentials) {
    warnings.push(
      'This backup has no credentials or encryption key. API keys, sign-in tokens and scheduled jobs already on this computer are kept; on a new computer you enter them again.',
    );
  }

  /** @type {boolean | null} */
  let passphraseOk = null;
  if (header.encrypted && passphrase) {
    passphraseOk = await verifyArchivePassphrase(resolved, passphrase);
  }

  return {
    file: resolved,
    archiveBytes,
    createdAt: typeof header.createdAt === 'string' ? header.createdAt : '',
    appVersion: typeof header.appVersion === 'string' ? header.appVersion : '',
    platform: typeof header.platform === 'string' ? header.platform : '',
    label: typeof header.label === 'string' ? header.label : '',
    encrypted: header.encrypted === true,
    includesCredentials: header.includesCredentials === true,
    totals: {
      files: Number(header.totals?.files) || 0,
      bytes: Number(header.totals?.bytes) || 0,
    },
    categories,
    warnings,
    passphraseOk,
  };
}

/**
 * Backups in a folder, newest first. Unreadable or foreign files are skipped.
 * @param {string} dir
 */
export async function listBackupsInFolder(dir) {
  const resolved = path.resolve(dir);
  let names;
  try {
    names = await fsp.readdir(resolved);
  } catch (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw err;
  }
  const rows = [];
  for (const name of names) {
    if (!name.toLowerCase().endsWith(BACKUP_FILE_EXTENSION)) continue;
    const file = path.join(resolved, name);
    if (!(await looksLikeBackup(file))) continue;
    try {
      const { header, archiveBytes } = await readArchiveHeader(file);
      rows.push({
        file,
        name,
        archiveBytes,
        createdAt: typeof header.createdAt === 'string' ? header.createdAt : '',
        appVersion: typeof header.appVersion === 'string' ? header.appVersion : '',
        encrypted: header.encrypted === true,
        includesCredentials: header.includesCredentials === true,
        label: typeof header.label === 'string' ? header.label : '',
      });
    } catch {
      /* damaged header — not offered */
    }
  }
  rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return rows;
}

/**
 * @param {string} dir
 * @returns {Promise<number | null>} free bytes, or null when it cannot be read
 */
async function freeBytes(dir) {
  try {
    const stats = await fsp.statfs(dir);
    const free = Number(stats.bavail) * Number(stats.bsize);
    return Number.isFinite(free) && free > 0 ? free : null;
  } catch {
    return null;
  }
}

/** @param {string} filePath */
function sqliteIsSound(filePath) {
  /** @type {import('better-sqlite3').Database | null} */
  let db = null;
  try {
    db = new Database(filePath, { readonly: true, fileMustExist: true });
    return db.pragma('quick_check', { simple: true }) === 'ok';
  } catch {
    return false;
  } finally {
    try {
      db?.close();
    } catch {
    }
  }
}

/**
 * Extract and verify a backup into the home's staging folder and mark it
 * pending. The live home is not modified beyond those two additions.
 *
 * @param {{
 *   home: string,
 *   archivePath: string,
 *   passphrase?: string,
 *   categories?: string[],
 *   appVersion?: string,
 *   onProgress?: (progress: { bytes: number, totalBytes: number, files: number, totalFiles: number }) => void,
 * }} options
 */
export async function stageRestore({ home, archivePath, passphrase, categories, appVersion = '', onProgress }) {
  const resolvedHome = path.resolve(home);
  const resolvedArchive = path.resolve(archivePath);

  const existing = readPendingRestore(resolvedHome);
  if (existing) {
    throw new BackupError(
      'A restore is already waiting for a restart. Cancel it before starting another.',
      'restore_pending',
    );
  }

  const { header } = await readArchiveHeader(resolvedArchive);
  if (header.encrypted && !passphrase) {
    throw new BackupFormatError('This backup is encrypted. Enter its passphrase.', 'passphrase_required');
  }

  const archiveCategories = (Array.isArray(header.categories) ? header.categories : [])
    .map((row) => String(row?.id ?? ''))
    .filter((id) => getCategory(id));
  const wanted = Array.isArray(categories)
    ? archiveCategories.filter((id) => categories.includes(id))
    : archiveCategories;
  if (wanted.length === 0) {
    throw new BackupError('Choose at least one part of the backup to restore.', 'empty');
  }
  const selected = new Set(wanted);
  const includeCredentials = header.includesCredentials === true && selected.has(CREDENTIALS_CATEGORY);

  // Only roots this version knows are swapped; the header alone cannot name new ones.
  const roots = (Array.isArray(header.roots) ? header.roots : [])
    .filter((root) => root && typeof root.path === 'string' && selected.has(root.category))
    .filter((root) => findRoot(root.path)?.category === root.category)
    .map((root) => ({
      path: root.path,
      category: root.category,
      kind: root.kind === 'file' ? 'file' : 'dir',
      exclude: findRoot(root.path)?.spec.exclude ?? [],
    }));
  const rootPaths = new Set(roots.map((root) => root.path));

  const needed = Math.ceil((Number(header.totals?.bytes) || 0) * FREE_SPACE_MARGIN);
  const free = await freeBytes(resolvedHome);
  if (free !== null && needed > free) {
    throw new BackupError(
      `Not enough free disk space to unpack this backup: it needs about ${Math.ceil(needed / 1048576)} MB.`,
      'low_disk',
    );
  }

  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
  const stagingDir = restoreStagingDir(resolvedHome, id);
  const tree = path.join(stagingDir, 'tree');
  await fsp.mkdir(tree, { recursive: true });

  /** @type {string[]} */
  const looseFiles = [];
  /** @type {string[]} */
  const sqliteFiles = [];
  let skippedUnknown = 0;
  let skippedUnstorable = 0;
  let doneBytes = 0;
  let doneFiles = 0;
  const totalBytes = Number(header.totals?.bytes) || 0;
  const totalFiles = Number(header.totals?.files) || 0;

  try {
    await readArchive({
      archivePath: resolvedArchive,
      passphrase,
      onEntry: async ({ meta, chunks, skip }) => {
        const rel = meta.p;
        const category = typeof meta.c === 'string' ? meta.c : '';
        if (!isSafeEntryPath(rel)) {
          throw new BackupFormatError('Backup is damaged: it contains an unsafe file path.');
        }
        const owner = findRootForPath(rel);
        if (!owner) {
          skippedUnknown += 1;
          await skip();
          return;
        }
        const isCredential = meta.k === 1 || category === CREDENTIALS_CATEGORY;
        const take = isCredential
          ? includeCredentials
          : selected.has(category) && rootPaths.has(owner.rootPath);
        if (!take) {
          await skip();
          return;
        }
        if (!isStorableHere(rel)) {
          skippedUnstorable += 1;
          await skip();
          return;
        }

        const dest = path.join(tree, ...rel.split('/'));
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        // `wx`: an archive naming the same path twice is damaged, not a merge.
        const out = await fsp.open(dest, 'wx', isCredential ? 0o600 : 0o644);
        try {
          for await (const chunk of chunks) {
            await out.write(chunk);
            doneBytes += chunk.length;
            onProgress?.({ bytes: doneBytes, totalBytes, files: doneFiles, totalFiles });
          }
        } finally {
          await out.close();
        }
        if (Number.isFinite(meta.m)) {
          const when = new Date(/** @type {number} */ (meta.m));
          await fsp.utimes(dest, when, when).catch(() => {});
        }
        doneFiles += 1;
        if (isCredential && !rootPaths.has(owner.rootPath)) looseFiles.push(rel);
        // Only stores the backup copied through SQLite are held to its integrity check;
        // a `.db` file that was archived raw is not ours to judge.
        if (meta.q === 1) sqliteFiles.push(dest);
      },
    });

    for (const file of sqliteFiles) {
      if (!sqliteIsSound(file)) {
        throw new BackupFormatError(
          `Backup is damaged: ${path.basename(file)} failed its integrity check after unpacking.`,
        );
      }
    }
  } catch (err) {
    await fsp.rm(stagingDir, { recursive: true, force: true });
    await fsp.rmdir(path.join(resolvedHome, RESTORE_STAGING_DIRNAME)).catch(() => {});
    throw err;
  }

  const warnings = versionWarnings(header, appVersion);
  if (skippedUnknown > 0) {
    warnings.push(`${skippedUnknown} files from a newer Minnow were skipped.`);
  }
  if (skippedUnstorable > 0) {
    warnings.push(
      `${skippedUnstorable} ${skippedUnstorable === 1 ? 'file has a name' : 'files have names'} this system cannot store and ${skippedUnstorable === 1 ? 'was' : 'were'} skipped.`,
    );
  }
  const earlier = readLastRestore(resolvedHome);
  if (earlier?.preRestoreDir && !earlier.rolledBackAt && fs.existsSync(preRestoreDir(resolvedHome, earlier.id))) {
    warnings.push(
      'The data kept from your previous restore is deleted when this one is applied. Only the latest restore can be undone.',
    );
  }
  const stagedKey = path.join(tree, '.key');
  const liveKey = path.join(resolvedHome, '.key');
  if (includeCredentials && fs.existsSync(stagedKey) && fs.existsSync(liveKey)) {
    const same = (await fsp.readFile(stagedKey)).equals(await fsp.readFile(liveKey));
    // Only worth a warning when something here would actually be stranded: a
    // fresh install has its own key too, but nothing sealed with it.
    const stranded = same ? [] : findStrandedCredentialFiles(resolvedHome, rootPaths, looseFiles);
    if (stranded.length > 0) {
      warnings.push(
        `This backup carries a different encryption key. ${stranded.length} encrypted ${stranded.length === 1 ? 'file' : 'files'} on this computer that the backup does not replace cannot be opened with it, so ${stranded.length === 1 ? 'it is' : 'they are'} set aside with the rest of the previous data.`,
      );
    }
  }

  const marker = {
    version: 1,
    id,
    kind: 'restore',
    createdAt: new Date().toISOString(),
    attempts: 0,
    archive: {
      file: resolvedArchive,
      createdAt: typeof header.createdAt === 'string' ? header.createdAt : '',
      appVersion: typeof header.appVersion === 'string' ? header.appVersion : '',
      encrypted: header.encrypted === true,
    },
    categories: wanted,
    roots,
    looseFiles,
    includeCredentials,
    redacted: includeCredentials ? {} : (header.redacted ?? {}),
    files: doneFiles,
    bytes: doneBytes,
    warnings,
  };
  const markerPath = restorePendingPath(resolvedHome);
  const tmp = `${markerPath}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tmp, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
  await fsp.rename(tmp, markerPath);

  return { id, files: doneFiles, bytes: doneBytes, categories: wanted, warnings, restartRequired: true };
}

/**
 * Drop a restore that has not been applied yet.
 * @param {string} home
 */
export async function cancelPendingRestore(home) {
  const resolvedHome = path.resolve(home);
  const marker = readPendingRestore(resolvedHome);
  if (!marker) return { cancelled: false };
  await fsp.rm(restorePendingPath(resolvedHome), { force: true });
  if (marker.kind !== 'rollback') {
    await fsp.rm(restoreStagingDir(resolvedHome, marker.id), { recursive: true, force: true });
    await fsp.rmdir(path.join(resolvedHome, RESTORE_STAGING_DIRNAME)).catch(() => {});
  }
  return { cancelled: true, kind: marker.kind === 'rollback' ? 'rollback' : 'restore' };
}

/**
 * Let a restore that gave up after repeated failures try again at the next start.
 * @param {string} home
 */
export async function retryPendingRestore(home) {
  const resolvedHome = path.resolve(home);
  const marker = readPendingRestore(resolvedHome);
  if (!marker) return { retried: false };
  const next = { ...marker, attempts: 0, failed: false };
  await fsp.writeFile(restorePendingPath(resolvedHome), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return { retried: true };
}

/**
 * Queue the last restore to be undone at the next start.
 * @param {string} home
 */
export async function scheduleRollback(home) {
  const resolvedHome = path.resolve(home);
  if (readPendingRestore(resolvedHome)) {
    throw new BackupError('A restore is already waiting for a restart.', 'restore_pending');
  }
  const last = readLastRestore(resolvedHome);
  if (!last || last.rolledBackAt || !last.preRestoreDir || !fs.existsSync(preRestoreDir(resolvedHome, last.id))) {
    throw new BackupError('There is no restore to undo, or its previous data was already removed.', 'no_rollback');
  }
  const marker = { version: 1, id: last.id, kind: 'rollback', createdAt: new Date().toISOString(), attempts: 0 };
  await fsp.writeFile(restorePendingPath(resolvedHome), `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
  return { id: last.id, restartRequired: true };
}

/** @param {string} dir */
async function directorySize(dir) {
  let total = 0;
  /** @type {string[]} */
  const stack = [dir];
  while (stack.length) {
    const current = /** @type {string} */ (stack.pop());
    let entries;
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(abs);
      else if (entry.isFile()) total += (await fsp.stat(abs).catch(() => ({ size: 0 }))).size;
    }
  }
  return total;
}

/**
 * Delete the data a restore set aside. After this the restore cannot be undone.
 * @param {string} home
 */
export async function discardPreRestoreData(home) {
  const resolvedHome = path.resolve(home);
  const pending = readPendingRestore(resolvedHome);
  if (pending?.kind === 'rollback') {
    throw new BackupError('An undo is waiting for a restart. Cancel it first.', 'restore_pending');
  }
  const last = readLastRestore(resolvedHome);
  if (!last?.preRestoreDir) return { removed: false };
  await fsp.rm(preRestoreDir(resolvedHome, last.id), { recursive: true, force: true });
  await fsp.rmdir(path.join(resolvedHome, PRE_RESTORE_DIRNAME)).catch(() => {});
  const lastPath = path.join(resolvedHome, 'restore-last.json');
  await fsp.writeFile(lastPath, `${JSON.stringify({ ...last, preRestoreDir: null }, null, 2)}\n`, 'utf8');
  return { removed: true };
}

/**
 * What Settings shows about restores: anything waiting, and the last one done.
 * @param {string} home
 */
export async function describeRestoreState(home) {
  const resolvedHome = path.resolve(home);
  const pending = readPendingRestore(resolvedHome);
  const last = readLastRestore(resolvedHome);
  let previousDataBytes = 0;
  const canUndo = Boolean(
    last && !last.rolledBackAt && last.preRestoreDir && fs.existsSync(preRestoreDir(resolvedHome, last.id)),
  );
  if (canUndo && last) previousDataBytes = await directorySize(preRestoreDir(resolvedHome, last.id));
  return {
    pending: pending
      ? {
          id: pending.id,
          kind: pending.kind === 'rollback' ? 'rollback' : 'restore',
          createdAt: pending.createdAt ?? '',
          archive: pending.archive ?? null,
          categories: pending.categories ?? [],
          warnings: pending.warnings ?? [],
          attempts: Number(pending.attempts) || 0,
          lastError: typeof pending.lastError === 'string' ? pending.lastError : '',
          failed: pending.failed === true,
        }
      : null,
    last: last
      ? {
          id: last.id,
          appliedAt: last.appliedAt ?? '',
          rolledBackAt: last.rolledBackAt ?? null,
          archive: last.archive ?? null,
          categories: last.categories ?? [],
          keyChanged: last.keyChanged === true,
          setAside: Array.isArray(last.setAside) ? last.setAside.length : 0,
          canUndo,
          previousDataBytes,
        }
      : null,
  };
}
