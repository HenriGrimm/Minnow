/**
 * Client cache of the git repos inside the active workspace folder.
 *
 * Mirrors `server/workspace/repos.js`. A normal project has one repo with id
 * `.`; a folder of sibling repos (`frontend/`, `backend/`) has one per repo.
 * Repo ids are workspace-relative, forward-slash paths.
 */

import { getWorkspacePath } from './workspace';

export interface WorkspaceRepoRemote {
  url: string;
  host: string;
  hostname: string;
  owner: string;
  name: string;
  slug: string;
}

export interface WorkspaceRepo {
  id: string;
  relPath: string;
  absPath: string;
  isRoot: boolean;
  remote: WorkspaceRepoRemote | null;
}

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { at: number; promise: Promise<WorkspaceRepo[] | null> }>();
type RepositoryLookupOptions = { refresh?: boolean; workspacePath?: string; checkoutPath?: string };

function workspaceKey(workspacePath?: string): string {
  return (workspacePath ?? getWorkspacePath()).trim().replace(/\\/g, '/').toLowerCase();
}

/** Null means discovery failed. An empty array means discovery found no repos. */
export function lookupWorkspaceRepos(options: RepositoryLookupOptions = {}): Promise<WorkspaceRepo[] | null> {
  const key = workspaceKey(options.checkoutPath ?? options.workspacePath);
  const hit = cache.get(key);
  if (!options.refresh && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.promise;
  const promise = (async () => {
    try {
      const params = new URLSearchParams();
      if (options.refresh) params.set('refresh', '1');
      if (options.checkoutPath) params.set('checkout', options.checkoutPath);
      const qs = params.size ? `?${params}` : '';
      const headers: Record<string, string> = {};
      if (options.workspacePath) headers['X-Minnow-Workspace'] = options.workspacePath;
      const response = await fetch(`/api/workspace/repos${qs}`, { headers });
      if (!response.ok) return null;
      const payload = (await response.json()) as { ok?: boolean; repos?: WorkspaceRepo[] };
      return payload.ok !== false && Array.isArray(payload.repos) ? payload.repos : null;
    } catch {
      return null;
    }
  })();
  cache.set(key, { at: Date.now(), promise });
  void promise.then((repos) => { if (!repos?.length && cache.get(key)?.promise === promise) cache.delete(key); });
  return promise;
}

export async function fetchWorkspaceRepos(options?: RepositoryLookupOptions): Promise<WorkspaceRepo[]> {
  return await lookupWorkspaceRepos(options) ?? [];
}

/** Forget cached repos (all workspaces when omitted). */
export function invalidateWorkspaceReposCache(workspacePath?: string): void {
  if (workspacePath === undefined) cache.clear();
  else cache.delete(workspaceKey(workspacePath));
}

function comparable(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * The deepest repo containing `path` (absolute, or relative to the workspace root).
 */
export function resolveRepoForPath(path: string, repos: readonly WorkspaceRepo[], workspacePath = getWorkspacePath()): WorkspaceRepo | null {
  const isAbs = /^([a-zA-Z]:[\\/]|[\\/])/.test(path);
  const abs = comparable(isAbs ? path : `${workspacePath.replace(/[\\/]+$/, '')}/${path}`);
  let best: WorkspaceRepo | null = null;
  for (const repo of repos) {
    const base = comparable(repo.absPath);
    if ((abs === base || abs.startsWith(`${base}/`)) && (!best || base.length > comparable(best.absPath).length)) best = repo;
  }
  return best;
}

/** `owner/name` for a repo's remote, or ''. */
export function repoRemoteSlug(repo: WorkspaceRepo | null | undefined): string {
  return repo?.remote?.owner && repo.remote.name ? `${repo.remote.owner}/${repo.remote.name}` : '';
}

/**
 * The repo id whose remote is `owner/name`, in a multi-repo workspace only —
 * single-repo workspaces leave links unqualified, as before.
 */
export async function repoIdForRemoteSlug(slug: string | undefined, workspacePath?: string): Promise<string | undefined> {
  const wanted = slug?.trim().toLowerCase();
  if (!wanted) return undefined;
  const repos = await fetchWorkspaceRepos(workspacePath ? { workspacePath } : {});
  if (repos.length < 2) return undefined;
  return repos.find((repo) => repoRemoteSlug(repo).toLowerCase() === wanted)?.id;
}

/** True when the workspace holds more than one repo. */
export function isMultiRepo(repos: readonly WorkspaceRepo[]): boolean {
  return repos.length > 1;
}
