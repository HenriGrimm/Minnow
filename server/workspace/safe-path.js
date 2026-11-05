/**
 * Canonical path resolution for workspace boundary checks (symlink-safe).
 */

import fs from 'node:fs';
import path from 'node:path';

/** Normalize slashes for consistent prefix checks on Windows. */
export function normalizePathForComparison(fsPath) {
  return path.normalize(fsPath).replace(/\\/g, '/');
}

/**
 * Resolve symlinks for boundary checks. Walks up the tree on ENOENT so
 * create/write paths for not-yet-existing files still validate parent dirs.
 * On Windows, use native realpath so 8.3 short names match the long path.
 * @param {string} resolvedAbs Absolute path from path.resolve
 * @returns {string}
 */
export function realpathForBoundaryCheck(resolvedAbs) {
  try {
    if (process.platform === 'win32' && typeof fs.realpathSync.native === 'function') {
      return fs.realpathSync.native(resolvedAbs);
    }
    return fs.realpathSync(resolvedAbs);
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? err.code : null;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      // A dangling link is an existing directory entry. A subsequent write can
      // follow it outside the workspace even though realpath reported ENOENT.
      if (code === 'ENOENT' && fs.lstatSync(resolvedAbs, { throwIfNoEntry: false })?.isSymbolicLink()) {
        throw new Error('Cannot resolve a dangling symlink for a workspace boundary check');
      }
      const parent = path.dirname(resolvedAbs);
      if (parent === resolvedAbs) {
        throw err;
      }
      const realParent = realpathForBoundaryCheck(parent);
      return path.join(realParent, path.basename(resolvedAbs));
    }
    throw err;
  }
}

/**
 * True when resolvedAbs lies under rootAbs after canonicalizing both via realpath.
 * @param {string} resolvedAbs
 * @param {string} rootAbs
 */
export function isResolvedPathUnderRoot(resolvedAbs, rootAbs) {
  const rootReal = realpathForBoundaryCheck(rootAbs);
  const targetReal = realpathForBoundaryCheck(resolvedAbs);
  const rootNorm = normalizePathForComparison(rootReal);
  const targetNorm = normalizePathForComparison(targetReal);
  return targetNorm === rootNorm || targetNorm.startsWith(`${rootNorm}/`);
}
