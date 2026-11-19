/**
 * Registered git worktree allowlist for workspaceRoot validation (browse + agent cwd).
 * Extends the fixed sandbox roots so file tools can target any `git worktree list` path
 * and repo-local `.worktrees/` slots without Full disk access.
 */

import path from 'node:path';
import { normalizeWorkspacePathKey } from '../workspace/root.js';
import { isResolvedPathUnderRoot } from '../workspace/safe-path.js';
import { listWorktrees } from './worktree-ops.js';
import { getEffectiveWorkspaceRoot, getRequestWorkspaceRoot } from '../runtime/path-access.js';

const CACHE_TTL_MS = 30_000;

/**
 * `git worktree list` output, cached per repo root.
 *
 * This used to be one global slot, which is wrong the moment two workspaces are
 * open: whichever folder asked last would answer for both.
 * @type {Map<string, { paths: Set<string>, expiresAt: number }>}
 */
const cacheByRepo = new Map();

/** Parse absolute worktree paths from `git worktree list --porcelain`. */
function parseWorktreePaths(porcelain) {
  const paths = [];
  for (const rawLine of String(porcelain ?? '').split('\n')) {
    const line = rawLine.trimEnd();
    if (!line.startsWith('worktree ')) continue;
    const wt = line.slice('worktree '.length).trim();
    if (wt) paths.push(path.resolve(wt));
  }
  return paths;
}

/** Repo-local default worktrees folder (`git worktree add .worktrees/...`). */
function getRepoLocalWorktreesDir(workspaceRoot = getEffectiveWorkspaceRoot()) {
  return path.join(path.resolve(workspaceRoot), '.worktrees');
}

/**
 * Drop cached registered worktree paths (call after add/remove).
 * @param {string} [workspaceRoot] Defaults to every repo.
 */
export function invalidateRegisteredWorktreeCache(workspaceRoot) {
  if (workspaceRoot && String(workspaceRoot).trim()) {
    cacheByRepo.delete(normalizeWorkspacePathKey(workspaceRoot));
    return;
  }
  cacheByRepo.clear();
}

/**
 * Load registered worktree paths for one repo (cached ~30s).
 * @param {string} workspaceRoot
 * @returns {Promise<Set<string>>}
 */
async function loadRegisteredWorktreePaths(workspaceRoot) {
  const repoKey = normalizeWorkspacePathKey(workspaceRoot);
  const now = Date.now();
  const cached = cacheByRepo.get(repoKey);
  if (cached && cached.expiresAt > now) {
    return cached.paths;
  }

  const paths = new Set();
  const list = await listWorktrees(workspaceRoot);
  if (list.ok && list.output) {
    for (const wt of parseWorktreePaths(list.output)) {
      paths.add(normalizeWorkspacePathKey(wt));
    }
  }

  cacheByRepo.set(repoKey, { paths, expiresAt: now + CACHE_TTL_MS });
  return paths;
}

/**
 * True when resolvedPath is a registered git worktree for the open repo or under
 * repo-local `.worktrees/` (even before git registers the path).
 * @param {string} resolvedPath
 */
export async function isRegisteredGitWorktreePath(resolvedPath) {
  if (!resolvedPath || typeof resolvedPath !== 'string') return false;
  const resolved = path.resolve(resolvedPath.trim());
  const key = normalizeWorkspacePathKey(resolved);

  const workspaceRoot = getRequestWorkspaceRoot();
  const registered = await loadRegisteredWorktreePaths(workspaceRoot);
  if (registered.has(key) || isResolvedPathUnderRoot(resolved, getRepoLocalWorktreesDir(workspaceRoot))) return true;

  const { discoverWorkspaceRepos } = await import('../workspace/repos.js');
  const repos = await discoverWorkspaceRepos(workspaceRoot);
  const childWorktrees = await Promise.all(repos.filter(repo => !repo.isRoot).map(repo => loadRegisteredWorktreePaths(repo.absPath)));
  return childWorktrees.some(paths => paths.has(key));
}

/**
 * Synchronous check for repo-local `.worktrees/` only (no git subprocess).
 * @param {string} resolvedPath
 */
export function isRepoLocalWorktreePath(resolvedPath) {
  if (!resolvedPath || typeof resolvedPath !== 'string') return false;
  const resolved = path.resolve(resolvedPath.trim());
  return isResolvedPathUnderRoot(resolved, getRepoLocalWorktreesDir());
}
