/**
 * Decide what a backup of a given home contains: walk the catalog roots, tag
 * credential files, and note which JSON files need plaintext secrets blanked.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  BACKUP_CATEGORIES,
  CREDENTIALS_CATEGORY,
  isCredentialPath,
  isExcludedByRoot,
  isJunkName,
  normalizeCategoryIds,
} from './catalog.js';
import {
  MAX_SECRET_SCAN_BYTES,
  containsSecretEnvelope,
  redactPlaintextSecrets,
} from './secrets-scan.js';

const SQLITE_EXTENSIONS = new Set(['.db', '.sqlite', '.sqlite3']);

/** Files at or under this size are hashed for the change fingerprint. */
const FINGERPRINT_HASH_MAX_BYTES = 256 * 1024;

/** Changes to these never count as "something changed since the last snapshot". */
const FINGERPRINT_IGNORED = new Set(['backup.json']);

/**
 * @typedef {{
 *   rel: string,
 *   abs: string,
 *   size: number,
 *   mtimeMs: number,
 *   category: string,
 *   kind: 'file' | 'sqlite' | 'json',
 *   credential: boolean,
 *   json?: unknown,
 *   redactedPaths?: string[][],
 * }} PlannedFile
 * `json` kind carries already-parsed content to be re-serialised (redacted).
 *
 * @typedef {{
 *   files: PlannedFile[],
 *   roots: Array<{ path: string, category: string, kind: 'dir' | 'file', exclude: string[] }>,
 *   categories: Array<{ id: string, files: number, bytes: number }>,
 *   includesCredentials: boolean,
 *   credentialsOmitted: number,
 *   redacted: Record<string, string[][]>,
 *   totals: { files: number, bytes: number },
 * }} BackupPlan
 */

/** @param {string} rel */
export function isSqlitePath(rel) {
  return SQLITE_EXTENSIONS.has(path.posix.extname(rel).toLowerCase());
}

/**
 * Yield every regular file under a root, honouring junk names, excluded
 * subpaths and skipped directory names. Symlinks are never followed.
 * @param {string} home
 * @param {import('./catalog.js').BackupRootSpec} spec
 * @returns {AsyncGenerator<{ rel: string, abs: string, size: number, mtimeMs: number }>}
 */
async function* walkRoot(home, spec) {
  const rootAbs = path.join(home, ...spec.path.split('/'));
  let rootStat;
  try {
    rootStat = await fs.lstat(rootAbs);
  } catch {
    return;
  }
  if (rootStat.isSymbolicLink()) return;
  if (rootStat.isFile()) {
    yield { rel: spec.path, abs: rootAbs, size: rootStat.size, mtimeMs: rootStat.mtimeMs };
    return;
  }
  if (!rootStat.isDirectory()) return;

  const skipDirs = new Set(spec.skipDirNames ?? []);
  /** @type {string[]} */
  const stack = [spec.path];
  while (stack.length) {
    const dirRel = /** @type {string} */ (stack.pop());
    const dirAbs = path.join(home, ...dirRel.split('/'));
    let entries;
    try {
      entries = await fs.readdir(dirAbs, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.isSymbolicLink() || isJunkName(entry.name)) continue;
      const rel = `${dirRel}/${entry.name}`;
      if (isExcludedByRoot(spec, rel)) continue;
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) stack.push(rel);
        continue;
      }
      if (!entry.isFile()) continue;
      const abs = path.join(dirAbs, entry.name);
      let stat;
      try {
        stat = await fs.lstat(abs);
      } catch {
        continue;
      }
      yield { rel, abs, size: stat.size, mtimeMs: stat.mtimeMs };
    }
  }
}

/**
 * Parse a small JSON file, or null when it is not one.
 * @param {string} abs
 * @param {number} size
 */
async function readSmallJson(abs, size) {
  if (size > MAX_SECRET_SCAN_BYTES) return null;
  try {
    return { value: JSON.parse(await fs.readFile(abs, 'utf8')) };
  } catch {
    return null;
  }
}

/**
 * @param {{
 *   home: string,
 *   categories?: string[],
 *   includeCredentials: boolean,
 * }} options
 * `includeCredentials` is the caller's decision that this archive is
 * passphrase-protected *and* the credentials category is selected.
 * @returns {Promise<BackupPlan>}
 */
export async function planBackup({ home, categories, includeCredentials }) {
  const selected = new Set(normalizeCategoryIds(categories));
  if (!includeCredentials) selected.delete(CREDENTIALS_CATEGORY);
  else selected.add(CREDENTIALS_CATEGORY);

  /** @type {PlannedFile[]} */
  const files = [];
  /** @type {BackupPlan['roots']} */
  const roots = [];
  /** @type {Record<string, string[][]>} */
  const redacted = {};
  let credentialsOmitted = 0;

  for (const category of BACKUP_CATEGORIES) {
    const categorySelected = selected.has(category.id);
    for (const spec of category.roots) {
      // An unselected root is still searched for credential files when
      // credentials are going in: "Credentials" means every secret, wherever it lives.
      if (!categorySelected && !(includeCredentials && spec.secrets)) continue;

      let sawAnything = false;
      for await (const found of walkRoot(home, spec)) {
        sawAnything = true;
        const isJson = found.rel.toLowerCase().endsWith('.json');
        const parsed = spec.secrets && isJson ? await readSmallJson(found.abs, found.size) : null;
        const credential =
          isCredentialPath(found.rel) || (parsed ? containsSecretEnvelope(parsed.value) : false);

        if (credential) {
          if (!includeCredentials) {
            credentialsOmitted += 1;
            continue;
          }
          files.push({ ...found, category: CREDENTIALS_CATEGORY, kind: 'file', credential: true });
          continue;
        }
        if (!categorySelected) continue;

        if (parsed && !includeCredentials) {
          const { value, paths } = redactPlaintextSecrets(parsed.value);
          if (paths.length) {
            redacted[found.rel] = paths;
            files.push({
              ...found,
              category: category.id,
              kind: 'json',
              credential: false,
              json: value,
              redactedPaths: paths,
            });
            continue;
          }
        }
        files.push({
          ...found,
          category: category.id,
          kind: isSqlitePath(found.rel) ? 'sqlite' : 'file',
          credential: false,
        });
      }

      if (!categorySelected) continue;
      const rootAbs = path.join(home, ...spec.path.split('/'));
      let kind = /** @type {'dir' | 'file' | null} */ (null);
      try {
        const stat = await fs.lstat(rootAbs);
        kind = stat.isDirectory() ? 'dir' : stat.isFile() ? 'file' : null;
      } catch {
        kind = null;
      }
      // A root that does not exist here is left alone on restore.
      if (!kind || (kind === 'file' && !sawAnything)) continue;
      roots.push({ path: spec.path, category: category.id, kind, exclude: [...(spec.exclude ?? [])] });
    }
  }

  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

  /** @type {Map<string, { id: string, files: number, bytes: number }>} */
  const perCategory = new Map();
  for (const file of files) {
    const row = perCategory.get(file.category) ?? { id: file.category, files: 0, bytes: 0 };
    row.files += 1;
    row.bytes += file.size;
    perCategory.set(file.category, row);
  }
  const order = BACKUP_CATEGORIES.map((category) => category.id);
  const categoryRows = [...perCategory.values()].sort(
    (a, b) => order.indexOf(a.id) - order.indexOf(b.id),
  );
  // A selected category with nothing in it still appears, so a preview can say so.
  for (const id of order) {
    if (selected.has(id) && !perCategory.has(id)) categoryRows.push({ id, files: 0, bytes: 0 });
  }
  categoryRows.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));

  return {
    files,
    roots,
    categories: categoryRows,
    includesCredentials: includeCredentials,
    credentialsOmitted,
    redacted,
    totals: {
      files: files.length,
      bytes: files.reduce((sum, file) => sum + file.size, 0),
    },
  };
}

/**
 * Size every category of a home without planning a specific backup — the
 * figures shown beside the checkboxes.
 * @param {string} home
 * @returns {Promise<Array<{ id: string, files: number, bytes: number }>>}
 */
export async function measureCategories(home) {
  const plan = await planBackup({
    home,
    categories: BACKUP_CATEGORIES.map((category) => category.id),
    includeCredentials: true,
  });
  return plan.categories;
}

/**
 * A digest that changes when the planned content changes. Small files are
 * hashed; large ones and SQLite stores are compared by size and mtime.
 * @param {BackupPlan} plan
 * @returns {Promise<string>}
 */
export async function fingerprintPlan(plan) {
  const hash = crypto.createHash('sha256');
  for (const file of plan.files) {
    if (FINGERPRINT_IGNORED.has(file.rel)) continue;
    hash.update(`${file.rel}\0`);
    if (file.kind === 'json') {
      hash.update(JSON.stringify(file.json));
    } else if (file.kind === 'sqlite') {
      hash.update(`${file.size}:${Math.trunc(file.mtimeMs)}`);
      try {
        // Uncheckpointed writes live in the WAL. An empty one is just a reader's
        // leftover (taking a backup opens the store) and must not count as change.
        const wal = await fs.stat(`${file.abs}-wal`);
        if (wal.size > 0) hash.update(`:${wal.size}:${Math.trunc(wal.mtimeMs)}`);
      } catch {
        /* no WAL beside it */
      }
    } else if (file.size <= FINGERPRINT_HASH_MAX_BYTES) {
      try {
        hash.update(await fs.readFile(file.abs));
      } catch {
        hash.update(`${file.size}:${Math.trunc(file.mtimeMs)}`);
      }
    } else {
      hash.update(`${file.size}:${Math.trunc(file.mtimeMs)}`);
    }
    hash.update('\0');
  }
  return hash.digest('hex');
}
