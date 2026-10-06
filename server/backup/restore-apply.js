/**
 * Swap a staged restore into the Minnow home.
 *
 * A restore never overwrites in place. `restore.js` extracts and verifies the
 * archive into `restore-staging/<id>/tree` while Minnow keeps running, then
 * leaves `restore-pending.json`. This module runs at the next start, before
 * anything opens the home: each backed-up root is renamed aside into
 * `pre-restore/<id>/` and the staged copy renamed into its place. Every step is
 * a same-volume rename recorded in a journal, so a failure unwinds to exactly
 * the home that was there before, and a later rollback is the same swap in
 * reverse.
 *
 * Must stay free of store imports — it runs before the config cache, the
 * sessions DB and the secret box are allowed to read anything.
 */

import fs from 'node:fs';
import path from 'node:path';

import { getMinnowHome } from '../config/home.js';
import {
  BACKUP_CATEGORIES,
  PRE_RESTORE_DIRNAME,
  RESTORE_LAST_FILENAME,
  RESTORE_PENDING_FILENAME,
  RESTORE_STAGING_DIRNAME,
  findRoot,
  isCredentialPath,
  isJunkName,
} from './catalog.js';
import {
  MAX_SECRET_SCAN_BYTES,
  jsonTextHasSecretEnvelope,
  refillRedactedSecrets,
} from './secrets-scan.js';

/** A pending restore that failed this many starts in a row stops retrying. */
export const MAX_APPLY_ATTEMPTS = 3;

const RENAME_RETRIES = 5;
const RENAME_RETRY_MS = 150;
const UNDONE_DIRNAME = '.undone';

/** @param {string} home */
export function restorePendingPath(home = getMinnowHome()) {
  return path.join(home, RESTORE_PENDING_FILENAME);
}

/** @param {string} home */
export function restoreLastPath(home = getMinnowHome()) {
  return path.join(home, RESTORE_LAST_FILENAME);
}

/**
 * @param {string} home
 * @param {string} id
 */
export function restoreStagingDir(home, id) {
  return path.join(home, RESTORE_STAGING_DIRNAME, id);
}

/**
 * @param {string} home
 * @param {string} id
 */
export function preRestoreDir(home, id) {
  return path.join(home, PRE_RESTORE_DIRNAME, id);
}

/** @param {string} filePath */
function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * @param {string} filePath
 * @param {unknown} value
 */
function writeJsonFile(filePath, value) {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

/** @param {string} home */
export function readPendingRestore(home = getMinnowHome()) {
  const marker = readJsonFile(restorePendingPath(home));
  return marker && typeof marker === 'object' && typeof marker.id === 'string' ? marker : null;
}

/** @param {string} home */
export function readLastRestore(home = getMinnowHome()) {
  const last = readJsonFile(restoreLastPath(home));
  return last && typeof last === 'object' && typeof last.id === 'string' ? last : null;
}

/** @param {number} ms */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Rename, riding out the short-lived locks antivirus and indexers take on Windows.
 * @param {string} from
 * @param {string} to
 */
function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      const code = /** @type {NodeJS.ErrnoException} */ (err).code;
      const transient = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
      if (!transient || attempt >= RENAME_RETRIES) throw err;
      sleepSync(RENAME_RETRY_MS * (attempt + 1));
    }
  }
}

/** Renames performed so far, newest last, so a failure can be unwound. */
class Journal {
  constructor() {
    /** @type {Array<{ from: string, to: string }>} */
    this.moves = [];
  }

  /**
   * @param {string} from
   * @param {string} to
   */
  move(from, to) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    renameWithRetry(from, to);
    this.moves.push({ from, to });
  }

  /** Put everything back. Best effort: reports what could not be moved. */
  unwind() {
    /** @type {string[]} */
    const stuck = [];
    for (const { from, to } of this.moves.reverse()) {
      try {
        fs.mkdirSync(path.dirname(from), { recursive: true });
        renameWithRetry(to, from);
      } catch {
        stuck.push(to);
      }
    }
    this.moves = [];
    return stuck;
  }
}

/** @param {string} target */
function exists(target) {
  try {
    fs.lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Files under `treeAbs` that count as credentials: a credential path, or JSON
 * carrying a secret-box envelope. Returned as home-relative paths.
 * @param {string} treeAbs absolute path of the root inside some tree
 * @param {string} rootRel home-relative root path
 * @returns {string[]}
 */
function listCredentialFiles(treeAbs, rootRel) {
  /** @type {string[]} */
  const found = [];
  let rootStat;
  try {
    rootStat = fs.lstatSync(treeAbs);
  } catch {
    return found;
  }

  /**
   * @param {string} abs
   * @param {string} rel
   * @param {number} size
   */
  const consider = (abs, rel, size) => {
    if (isCredentialPath(rel)) {
      found.push(rel);
      return;
    }
    if (!rel.toLowerCase().endsWith('.json') || size > MAX_SECRET_SCAN_BYTES) return;
    try {
      if (jsonTextHasSecretEnvelope(fs.readFileSync(abs, 'utf8'))) found.push(rel);
    } catch {
    }
  };

  if (rootStat.isFile()) {
    consider(treeAbs, rootRel, rootStat.size);
    return found;
  }
  if (!rootStat.isDirectory()) return found;

  /** @type {Array<{ abs: string, rel: string }>} */
  const stack = [{ abs: treeAbs, rel: rootRel }];
  while (stack.length) {
    const dir = /** @type {{ abs: string, rel: string }} */ (stack.pop());
    let entries;
    try {
      entries = fs.readdirSync(dir.abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink() || isJunkName(entry.name)) continue;
      const abs = path.join(dir.abs, entry.name);
      const rel = `${dir.rel}/${entry.name}`;
      if (entry.isDirectory()) {
        stack.push({ abs, rel });
      } else if (entry.isFile()) {
        let size = 0;
        try {
          size = fs.statSync(abs).size;
        } catch {
          continue;
        }
        consider(abs, rel, size);
      }
    }
  }
  return found;
}

/**
 * Credential files a restore would leave behind under a key that no longer
 * opens them: those in secret-holding roots the restore does not swap, minus
 * the loose files it writes itself.
 * @param {string} home
 * @param {Iterable<string>} swappedRootPaths
 * @param {Iterable<string>} restoredLooseFiles
 * @returns {string[]} home-relative paths
 */
export function findStrandedCredentialFiles(home, swappedRootPaths, restoredLooseFiles) {
  const swapped = new Set(swappedRootPaths);
  const restored = new Set(restoredLooseFiles);
  /** @type {string[]} */
  const stranded = [];
  for (const category of BACKUP_CATEGORIES) {
    for (const spec of category.roots) {
      if (!spec.secrets || swapped.has(spec.path)) continue;
      const rootAbs = path.join(home, ...spec.path.split('/'));
      for (const rel of listCredentialFiles(rootAbs, spec.path)) {
        if (!restored.has(rel)) stranded.push(rel);
      }
    }
  }
  return stranded;
}

/**
 * Replace one root with an incoming copy, parking the outgoing one, then carry
 * over what the backup deliberately left out: excluded caches, and — when the
 * incoming side brings no credentials — the credential files already here.
 *
 * @param {{
 *   journal: Journal,
 *   home: string,
 *   root: { path: string, kind: 'dir' | 'file', exclude?: string[] },
 *   incomingTree: string,
 *   outgoingTree: string,
 *   carryCredentials: boolean,
 * }} options
 */
function swapRoot({ journal, home, root, incomingTree, outgoingTree, carryCredentials }) {
  const parts = root.path.split('/');
  const live = path.join(home, ...parts);
  const incoming = path.join(incomingTree, ...parts);
  const outgoing = path.join(outgoingTree, ...parts);

  if (!exists(incoming)) {
    // A file root the backup left out (an encrypted file in a backup without
    // credentials) stays as it is. A directory root is restored as empty.
    if (root.kind === 'file') return;
    fs.mkdirSync(incoming, { recursive: true });
  }

  const hadLive = exists(live);
  if (hadLive) journal.move(live, outgoing);
  journal.move(incoming, live);
  if (!hadLive || root.kind !== 'dir') return;

  for (const sub of root.exclude ?? []) {
    const from = path.join(outgoing, ...sub.split('/'));
    const to = path.join(live, ...sub.split('/'));
    if (exists(from) && !exists(to) && exists(path.dirname(to))) journal.move(from, to);
  }

  if (!carryCredentials || !findRoot(root.path)?.spec.secrets) return;
  for (const rel of listCredentialFiles(outgoing, root.path)) {
    const inner = rel.split('/').slice(parts.length);
    const from = path.join(outgoing, ...inner);
    const to = path.join(live, ...inner);
    // Only where the restored tree still has the folder this secret belongs to.
    if (!exists(to) && exists(path.dirname(to))) journal.move(from, to);
  }
}

/**
 * Fill secrets the backup blanked from the files it is about to replace.
 * Edits staged files only, so there is nothing to unwind.
 * @param {string} home
 * @param {string} stagedTree
 * @param {Record<string, string[][]>} redacted
 */
function refillStagedSecrets(home, stagedTree, redacted) {
  for (const [rel, paths] of Object.entries(redacted ?? {})) {
    if (typeof rel !== 'string' || !Array.isArray(paths)) continue;
    const staged = path.join(stagedTree, ...rel.split('/'));
    const live = path.join(home, ...rel.split('/'));
    const restored = readJsonFile(staged);
    const existing = readJsonFile(live);
    if (restored === null || existing === null) continue;
    const { value, filled } = refillRedactedSecrets(restored, existing, paths);
    if (filled > 0) writeJsonFile(staged, value);
  }
}

/**
 * @param {string} a
 * @param {string} b
 */
function sameFileContent(a, b) {
  try {
    return fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch {
    return false;
  }
}

/**
 * @param {string} home
 * @param {Record<string, any>} marker
 */
function applyRestore(home, marker) {
  const stagedTree = path.join(restoreStagingDir(home, marker.id), 'tree');
  if (!exists(stagedTree)) {
    throw new Error('The staged restore is missing. Start the restore again from the backup file.');
  }
  const parked = preRestoreDir(home, marker.id);
  const roots = Array.isArray(marker.roots) ? marker.roots : [];
  const looseFiles = Array.isArray(marker.looseFiles) ? marker.looseFiles : [];
  const includeCredentials = marker.includeCredentials === true;

  const stagedKey = path.join(stagedTree, '.key');
  const liveKey = path.join(home, '.key');
  const keyChanges = exists(stagedKey) && exists(liveKey) && !sameFileContent(stagedKey, liveKey);

  refillStagedSecrets(home, stagedTree, marker.redacted);

  const journal = new Journal();
  /** @type {string[]} */
  const setAside = [];
  try {
    for (const root of roots) {
      swapRoot({
        journal,
        home,
        root,
        incomingTree: stagedTree,
        outgoingTree: parked,
        carryCredentials: !includeCredentials,
      });
    }

    // Credential files whose own root was not part of this restore.
    for (const rel of looseFiles) {
      const parts = String(rel).split('/');
      const staged = path.join(stagedTree, ...parts);
      if (!exists(staged)) continue;
      const live = path.join(home, ...parts);
      if (exists(live)) journal.move(live, path.join(parked, ...parts));
      journal.move(staged, live);
    }

    // A new key cannot open what the old key sealed. Park those files instead of
    // leaving stores that fail on every read.
    if (keyChanges) {
      const stranded = findStrandedCredentialFiles(
        home,
        roots.map((root) => root.path),
        looseFiles,
      );
      for (const rel of stranded) {
        journal.move(path.join(home, ...rel.split('/')), path.join(parked, ...rel.split('/')));
        setAside.push(rel);
      }
    }
  } catch (err) {
    const stuck = journal.unwind();
    if (stuck.length) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `${detail} Some folders could not be moved back; they are in ${parked}.`,
      );
    }
    throw err;
  }

  return { parked, setAside, keyChanged: keyChanges };
}

/**
 * @param {string} home
 * @param {Record<string, any>} last
 */
function applyRollback(home, last) {
  const parked = preRestoreDir(home, last.id);
  if (!exists(parked)) {
    throw new Error('The data from before the restore is no longer on disk, so it cannot be put back.');
  }
  const undone = path.join(parked, UNDONE_DIRNAME);
  const roots = Array.isArray(last.roots) ? last.roots : [];
  const journal = new Journal();
  try {
    for (const root of [...roots].reverse()) {
      const parts = root.path.split('/');
      const parkedRoot = path.join(parked, ...parts);
      const live = path.join(home, ...parts);
      if (!exists(parkedRoot)) {
        // Nothing was here before the restore: take the restored copy back out.
        if (exists(live) && last.createdRoots?.includes(root.path)) {
          journal.move(live, path.join(undone, ...parts));
        }
        continue;
      }
      swapRoot({
        journal,
        home,
        root,
        incomingTree: parked,
        outgoingTree: undone,
        carryCredentials: last.includeCredentials !== true,
      });
    }
    for (const rel of Array.isArray(last.looseFiles) ? last.looseFiles : []) {
      const parts = String(rel).split('/');
      const live = path.join(home, ...parts);
      const before = path.join(parked, ...parts);
      if (exists(live)) journal.move(live, path.join(undone, ...parts));
      if (exists(before)) journal.move(before, live);
    }
    for (const rel of Array.isArray(last.setAside) ? last.setAside : []) {
      const parts = String(rel).split('/');
      const before = path.join(parked, ...parts);
      const live = path.join(home, ...parts);
      if (exists(before) && !exists(live)) journal.move(before, live);
    }
  } catch (err) {
    journal.unwind();
    throw err;
  }
  fs.rmSync(parked, { recursive: true, force: true });
}

/**
 * Only the latest restore can be undone, so data set aside by an earlier one has
 * no way back in and would sit on disk unseen. Staging warns that it goes.
 * @param {string} home
 * @param {string} keepId
 */
function removeSupersededPreRestoreData(home, keepId) {
  const root = path.join(home, PRE_RESTORE_DIRNAME);
  let names;
  try {
    names = fs.readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === keepId) continue;
    try {
      fs.rmSync(path.join(root, name), { recursive: true, force: true });
    } catch {
      /* left for the next restore or a manual delete */
    }
  }
}

/** @param {string} dir */
function removeIfEmpty(dir) {
  try {
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch {
  }
}

/**
 * Apply the pending restore or rollback, if there is one. Call before any
 * other code reads the home. Never throws: a failure leaves the home as it was
 * and records the error on the marker for Settings to show.
 *
 * @param {{ home?: string, now?: () => Date }} [options]
 * @returns {{ applied: boolean, kind?: 'restore' | 'rollback', id?: string, error?: string }}
 */
export function applyPendingRestore(options = {}) {
  const home = options.home ?? getMinnowHome();
  const now = options.now ?? (() => new Date());
  const marker = readPendingRestore(home);
  if (!marker || marker.failed === true) return { applied: false };

  const kind = marker.kind === 'rollback' ? 'rollback' : 'restore';
  try {
    if (kind === 'rollback') {
      const last = readLastRestore(home);
      if (!last || last.id !== marker.id) {
        throw new Error('There is no completed restore to roll back.');
      }
      applyRollback(home, last);
      writeJsonFile(restoreLastPath(home), {
        ...last,
        rolledBackAt: now().toISOString(),
        preRestoreDir: null,
      });
    } else {
      const liveBefore = new Set(
        (Array.isArray(marker.roots) ? marker.roots : [])
          .filter((root) => exists(path.join(home, ...root.path.split('/'))))
          .map((root) => root.path),
      );
      const result = applyRestore(home, marker);
      writeJsonFile(restoreLastPath(home), {
        version: 1,
        id: marker.id,
        appliedAt: now().toISOString(),
        archive: marker.archive ?? null,
        categories: marker.categories ?? [],
        roots: marker.roots ?? [],
        createdRoots: (marker.roots ?? [])
          .map((root) => root.path)
          .filter((rootPath) => !liveBefore.has(rootPath)),
        looseFiles: marker.looseFiles ?? [],
        includeCredentials: marker.includeCredentials === true,
        setAside: result.setAside,
        keyChanged: result.keyChanged,
        preRestoreDir: exists(result.parked) ? result.parked : null,
        rolledBackAt: null,
      });
      fs.rmSync(restoreStagingDir(home, marker.id), { recursive: true, force: true });
      removeIfEmpty(path.join(home, RESTORE_STAGING_DIRNAME));
      removeSupersededPreRestoreData(home, marker.id);
    }
    fs.rmSync(restorePendingPath(home), { force: true });
    removeIfEmpty(path.join(home, PRE_RESTORE_DIRNAME));
    return { applied: true, kind, id: marker.id };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const attempts = (Number(marker.attempts) || 0) + 1;
    try {
      writeJsonFile(restorePendingPath(home), {
        ...marker,
        attempts,
        lastError: error,
        lastAttemptAt: now().toISOString(),
        failed: attempts >= MAX_APPLY_ATTEMPTS,
      });
    } catch {
    }
    return { applied: false, kind, id: marker.id, error };
  }
}
