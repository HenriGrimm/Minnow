/**
 * Workspace repositories — the git roots inside one workspace folder.
 *
 * A workspace keeps a single root for path safety, but that folder may hold
 * several independent repos (`frontend/`, `backend/`, each with its own remote).
 * Every git, forge and worktree caller resolves one of these instead of assuming
 * the workspace root is the repo. A normal project is the degenerate case: one
 * repo with id `.`.
 *
 * Repo ids are workspace-relative paths with forward slashes (`.`, `frontend`,
 * `apps/web`). They are what issues, links and board records store — never an
 * absolute path.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { runProcess } from '../process-runner.js';
import { getEffectiveWorkspaceRoot } from '../runtime/path-access.js';
import { normalizePathForComparison } from './safe-path.js';
import { parseRemoteHost } from '../git/forge-ops.js';

/** How deep below the workspace root to look for child repos. */
export const REPO_SCAN_DEPTH = 2;
const CACHE_TTL_MS = 30_000;
const SKIP_DIRS = new Set(['node_modules', 'bower_components', 'vendor', 'dist', 'build', 'target', 'out']);

/** @type {Map<string, { at: number, promise: Promise<WorkspaceRepo[]> }>} */
const cache = new Map();

/**
 * @typedef {{ url: string, host: string, hostname: string, owner: string, name: string, slug: string }} RepoRemote
 * @typedef {{ id: string, relPath: string, absPath: string, isRoot: boolean, remote: RepoRemote | null }} WorkspaceRepo
 */

async function git(args, cwd) {
  try {
    return await runProcess('git', args, { cwd, timeout: 15_000 });
  } catch {
    return { code: 1, stdout: '', stderr: '' };
  }
}

async function readRemote(cwd) {
  let result = await git(['remote', 'get-url', 'origin'], cwd);
  let url = result.code === 0 ? String(result.stdout ?? '').trim() : '';
  if (!url) {
    const names = await git(['remote'], cwd);
    const first = String(names.stdout ?? '').split('\n').map((line) => line.trim()).filter(Boolean)[0];
    if (first) {
      result = await git(['remote', 'get-url', first], cwd);
      url = result.code === 0 ? String(result.stdout ?? '').trim() : '';
    }
  }
  if (!url) return null;
  const { host, slug, hostname } = parseRemoteHost(url);
  const parts = slug.split('/').filter(Boolean);
  return {
    url,
    host,
    hostname,
    slug,
    owner: parts.length >= 2 ? parts.slice(0, -1).join('/') : '',
    name: parts.length ? parts[parts.length - 1] : '',
  };
}

async function hasGitMarker(dir) {
  try {
    await fs.lstat(path.join(dir, '.git'));
    return true;
  } catch {
    return false;
  }
}

async function rootIsInsideRepo(root) {
  const result = await git(['rev-parse', '--is-inside-work-tree'], root);
  return result.code === 0 && String(result.stdout ?? '').trim() === 'true';
}

function skipDir(name) {
  return name.startsWith('.') || SKIP_DIRS.has(name.toLowerCase());
}

/** Child directories (≤ REPO_SCAN_DEPTH) that are repo roots; does not descend into a found repo. */
async function scanChildRepos(root) {
  /** @type {string[]} */
  const found = [];
  /** @param {string} dir @param {number} depth */
  async function walk(dir, depth) {
    if (depth > REPO_SCAN_DEPTH) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(entries.map(async (entry) => {
      if (!entry.isDirectory() || skipDir(entry.name)) return;
      const child = path.join(dir, entry.name);
      if (await hasGitMarker(child)) {
        found.push(child);
        return;
      }
      await walk(child, depth + 1);
    }));
  }
  await walk(root, 1);
  return found;
}

/** Forward-slash, case-folded on Windows. */
function comparable(fsPath) {
  const norm = normalizePathForComparison(fsPath);
  return process.platform === 'win32' ? norm.toLowerCase() : norm;
}

/** @param {string} root @param {string} abs */
export function repoIdForPath(root, abs) {
  const rel = path.relative(root, abs).split(path.sep).join('/');
  return rel === '' ? '.' : rel;
}

async function scan(root) {
  const [rootRepo, children] = await Promise.all([rootIsInsideRepo(root), scanChildRepos(root)]);
  const dirs = [...(rootRepo ? [root] : []), ...children];
  const repos = await Promise.all(dirs.map(async (absPath) => {
    const id = repoIdForPath(root, absPath);
    return { id, relPath: id, absPath, isRoot: id === '.', remote: await readRemote(absPath) };
  }));
  return repos.sort((a, b) => (a.isRoot ? -1 : b.isRoot ? 1 : a.id.localeCompare(b.id)));
}

/**
 * Discover the repos in a workspace. Cached per root for 30 s.
 * @param {string} [workspaceRoot]
 * @param {{ refresh?: boolean }} [options]
 * @returns {Promise<WorkspaceRepo[]>}
 */
export async function discoverWorkspaceRepos(workspaceRoot = getEffectiveWorkspaceRoot(), options = {}) {
  const root = path.resolve(workspaceRoot);
  const key = comparable(root);
  const hit = cache.get(key);
  if (!options.refresh && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.promise;
  const promise = scan(root);
  cache.set(key, { at: Date.now(), promise });
  promise.catch(() => cache.delete(key));
  return promise;
}

/** Drop the cached repo list for one workspace (or all when omitted). */
export function invalidateWorkspaceRepos(workspaceRoot) {
  if (!workspaceRoot) {
    cache.clear();
    return;
  }
  cache.delete(comparable(path.resolve(workspaceRoot)));
}

/**
 * The deepest repo containing `absPath`, or null.
 * @param {string} absPath
 * @param {WorkspaceRepo[]} repos
 */
export function findRepoForPath(absPath, repos) {
  const target = comparable(path.resolve(absPath));
  let best = null;
  let bestLen = -1;
  for (const repo of repos) {
    const base = comparable(repo.absPath).replace(/\/+$/, '');
    const inside = target === base || target.startsWith(`${base}/`);
    if (inside && base.length > bestLen) {
      best = repo;
      bestLen = base.length;
    }
  }
  return best;
}

/** `owner/name` for a repo's remote, or ''. */
export function repoRemoteSlug(repo) {
  return repo?.remote?.owner && repo.remote.name ? `${repo.remote.owner}/${repo.remote.name}` : '';
}

/**
 * The system-prompt repo map. Empty unless the workspace holds two or more
 * repos, so single-repo prompts are byte-for-byte unchanged. Branches are left
 * out on purpose: the block stays stable across turns (prompt-cache friendly).
 * @param {WorkspaceRepo[]} repos
 */
export function renderWorkspaceReposBlock(repos) {
  if (!Array.isArray(repos) || repos.length < 2) return '';
  const lines = repos.map((repo) => {
    const remote = repo.remote ? `${repo.remote.hostname || repo.remote.host}/${repo.remote.slug}` : 'no remote';
    return `- \`${repo.id}\` — ${remote}`;
  });
  return [
    '## Workspace repositories',
    'This workspace folder holds several independent git repositories. Each has its own branches, history and remote.',
    ...lines,
    'Pass `repo` (the id above) to git tools when no file path identifies the repo. Commit, push and open PRs once per repo. Run `gh` and other repo-scoped commands from inside the repo directory, e.g. `cd backend && gh pr create`.',
  ].join('\n');
}
