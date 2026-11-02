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
