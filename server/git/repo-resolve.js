/**
 * Pick the repo a git or forge call runs in.
 *
 * A workspace folder may hold several repos (see server/workspace/repos.js).
 * Callers name one by `repo` id (or its `owner/name` remote), or pass a file
 * path that lives inside one. With neither, a workspace whose root is a repo
 * — or that holds exactly one — resolves as before; one with several repos is
 * ambiguous, which strict callers (agent tools) report and lenient callers
 * (routes, for older clients) treat as the workspace root.
 */

import path from 'node:path';
import { getEffectiveWorkspaceRoot } from '../runtime/path-access.js';
import { discoverWorkspaceRepos, findRepoForPath, repoRemoteSlug } from '../workspace/repos.js';

/**
 * @typedef {import('../workspace/repos.js').WorkspaceRepo} WorkspaceRepo
 * @typedef {{ cwd: string, repo: WorkspaceRepo | null, relPath?: string }} ResolvedRepo
 */

export class RepoResolveError extends Error {}

function listIds(repos) {
  return repos.map((r) => r.id).join(', ') || '(none)';
}

/**
 * @param {WorkspaceRepo[]} repos
 * @param {string} wanted
 */
export function findRepoById(repos, wanted) {
  const id = String(wanted ?? '').trim().replace(/\\/g, '/').replace(/(.)\/+$/, '$1');
  if (!id) return null;
  const lower = id.toLowerCase();
  return repos.find((r) => r.id === id)
    ?? repos.find((r) => r.id.toLowerCase() === lower)
    ?? repos.find((r) => repoRemoteSlug(r).toLowerCase() === lower)
    ?? repos.find((r) => r.remote?.name?.toLowerCase() === lower && repos.filter((o) => o.remote?.name?.toLowerCase() === lower).length === 1)
    ?? null;
}

/**
 * @param {{ cwd?: unknown, repo?: unknown, path?: unknown }} [input]
 * @param {{ strict?: boolean, workspaceRoot?: string }} [options]
 * @returns {Promise<ResolvedRepo>}
 */
export async function resolveRepoCwd(input = {}, options = {}) {
  const strict = options.strict !== false;
  const explicitCwd = typeof input.cwd === 'string' && input.cwd.trim() ? input.cwd.trim() : '';
  const base = path.resolve(explicitCwd || options.workspaceRoot || getEffectiveWorkspaceRoot());
  const wanted = typeof input.repo === 'string' ? input.repo.trim() : '';
  const filePath = typeof input.path === 'string' ? input.path.trim() : '';

  if (wanted) {
    const repos = await discoverWorkspaceRepos(base);
    const repo = findRepoById(repos, wanted);
    if (!repo) throw new RepoResolveError(`Unknown repo "${wanted}"; known: ${listIds(repos)}`);
    const out = { cwd: repo.absPath, repo };
    if (filePath) out.relPath = relativeToRepo(base, repo, filePath);
    return out;
  }

  // An explicit cwd (a worktree, an issue's workspace) is the caller's decision.
  if (explicitCwd && !filePath) return { cwd: base, repo: null };

  const repos = await discoverWorkspaceRepos(base);
  if (filePath) {
    const abs = path.resolve(base, filePath);
    const repo = findRepoForPath(abs, repos);
    if (repo) return { cwd: repo.absPath, repo, relPath: relativeToRepo(base, repo, filePath) };
  }

  const root = repos.find((r) => r.isRoot);
  if (root) return { cwd: root.absPath, repo: root, ...(filePath ? { relPath: filePath } : {}) };
  if (repos.length === 1) return { cwd: repos[0].absPath, repo: repos[0] };
  if (repos.length > 1 && strict) {
    throw new RepoResolveError(`This workspace has several repos (${listIds(repos)}); pass repo`);
  }
  return { cwd: base, repo: null };
}

/** A workspace-relative (or absolute) path rewritten relative to the repo root. */
function relativeToRepo(base, repo, filePath) {
  const abs = path.resolve(base, filePath);
  const rel = path.relative(repo.absPath, abs);
  if (!rel) return '.';
  if (rel.startsWith('..') || path.isAbsolute(rel)) return filePath;
  return rel.split(path.sep).join('/');
}

/** The repo list for the active workspace, for error messages and prompts. */
export async function listWorkspaceRepoIds(workspaceRoot) {
  return (await discoverWorkspaceRepos(workspaceRoot)).map((r) => r.id);
}
