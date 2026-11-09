/**
 * Client-side mirror of registered git worktree roots for approval UX.
 * The server remains authoritative; this cache avoids false path blocks in the modal.
 */

import { normalizePathForComparison } from '../tools/workspace-path-guard.ts';
import { getWorkspacePath } from '../state/workspace.ts';
import { panelPathsEqual } from '../ui/panel-worktree-cwd.ts';

const CACHE_TTL_MS = 30_000;

let cachedPaths: string[] = [];
let cacheExpiresAt = 0;

/** Record worktree paths from a recent `git worktree list` response. */
export function noteRegisteredWorktreePaths(paths: string[]): void {
  cachedPaths = paths.map((p) => normalizePathForComparison(p));
  cacheExpiresAt = Date.now() + CACHE_TTL_MS;
}

/** Drop cached worktree paths (tests / after add/remove). */
export function resetRegisteredWorktreePathCache(): void {
  cachedPaths = [];
  cacheExpiresAt = 0;
}

function repoLocalWorktreesPrefix(): string | undefined {
  const ws = getWorkspacePath().trim();
  if (!ws) return undefined;
  return normalizePathForComparison(`${ws.replace(/\\/g, '/').replace(/\/+$/, '')}/.worktrees`);
}

/** True when path matches a recently listed git worktree or repo-local `.worktrees/`. */
export function isCachedRegisteredWorktreePath(userPath: string): boolean {
  const resolved = normalizePathForComparison(userPath.replace(/\\/g, '/'));
  const localPrefix = repoLocalWorktreesPrefix();
  if (localPrefix && (resolved === localPrefix || resolved.startsWith(`${localPrefix}/`))) {
    return true;
  }
  if (Date.now() > cacheExpiresAt) return false;
  for (const root of cachedPaths) {
    if (panelPathsEqual(resolved, root) || resolved.startsWith(`${root}/`)) {
      return true;
    }
  }
  return false;
}

/** Registered worktree roots still fresh in the cache (treated as part of the project). */
export function getCachedRegisteredWorktreePaths(): string[] {
  const local = repoLocalWorktreesPrefix();
  const fresh = Date.now() > cacheExpiresAt ? [] : cachedPaths;
  return local ? [local, ...fresh] : [...fresh];
}
