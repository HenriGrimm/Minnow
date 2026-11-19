/**
 * Normalize workspace directory paths for stable comparison and map keys.
 * Mirrors server/config/validators.js (Windows drive casing, slashes).
 */

import { normalizePathForComparison } from '../tools/workspace-path-guard';

/** Normalize an absolute workspace root path for storage and equality checks. */
export function normalizeWorkspacePath(fsPath: string): string {
  if (!fsPath || typeof fsPath !== 'string') return '';
  return normalizePathForComparison(fsPath.trim());
}

/** Compare Windows drive paths without casing differences; preserve POSIX case. */
export function workspacePathsEqual(a: string, b: string): boolean {
  const left = normalizeWorkspacePath(a);
  const right = normalizeWorkspacePath(b);
  if (!left || !right) return false;
  return /^[A-Z]:\//.test(left)
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

/** Relative path of a child workspace, "." for the root, or null outside it. */
export function relativeWorkspacePath(root: string, child: string): string | null {
  const base = normalizeWorkspacePath(root);
  const target = normalizeWorkspacePath(child);
  if (!base || !target) return null;
  const prefix = base.endsWith('/') ? base : `${base}/`;
  const windows = /^[A-Z]:(?:\/|$)/.test(base);
  const key = (path: string) => windows ? path.toLowerCase() : path;
  if (key(base) === key(target)) return '.';
  return key(target).startsWith(key(prefix)) ? target.slice(prefix.length) : null;
}
