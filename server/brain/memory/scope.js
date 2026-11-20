/**
 * Project memory scope: one key per Git repository (shared by linked worktrees,
 * board slots and sub-agent checkouts), or per canonical folder when the
 * workspace is not a Git repository.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runProcess } from '../../process-runner.js';
import { legacyBrainWorkspaceSlug } from '../paths.js';
import { readMirrorManifest } from '../../worktree/multi-repo.js';
import { getRepoWorktreesDir, isPathUnderWorktreesRoot } from '../../worktree/paths.js';
import { isResolvedPathUnderRoot } from '../../workspace/safe-path.js';

/** Pages-relative folder holding every memory. */
export const MEMORY_ROOT = 'memory';
export const USER_MEMORY_PREFIX = `${MEMORY_ROOT}/user/`;
export const PROJECT_MEMORY_PREFIX = `${MEMORY_ROOT}/projects/`;
export const MEMORY_PROJECT_KEY_RE = /^[a-z0-9._-]+--[a-f0-9]{32}$/;

/** @type {Map<string, Promise<{ key: string, label: string, root: string }>>} */
const cache = new Map();

const identity = value => (process.platform === 'win32' ? value.toLowerCase() : value);

function projectKey(label, canonical) {
  const digest = createHash('sha256').update(identity(canonical)).digest('hex').slice(0, 32);
  return `${legacyBrainWorkspaceSlug(label).slice(0, 60)}--${digest}`;
}

async function gitCommonDir(root) {
  const result = await runProcess('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    { cwd: root, timeout: 15_000 }).catch(() => null);
  if (result?.timedOut) throw new Error('Git repository identity lookup timed out; retry memory lookup.');
  if (!result || result.code !== 0) return null;
  const raw = result.stdout.trim();
  if (!raw) return null;
  return fs.realpath(raw).catch(() => null);
}

/** A mirrored multi-repo chat checkout shares its source folder's memory. */
async function mirrorSourceRoot(canonical) {
  if (!isPathUnderWorktreesRoot(canonical)) return null;
  const manifest = await readMirrorManifest(canonical);
  if (typeof manifest?.workspaceRoot !== 'string' || !manifest.workspaceRoot) return null;
  const source = await fs.realpath(manifest.workspaceRoot).catch(() => null);
  // A manifest inside an agent-writable checkout must not redirect reads to an
  // unrelated project. Its source must match this checkout's storage namespace.
  return source && isResolvedPathUnderRoot(canonical, getRepoWorktreesDir(source)) ? source : null;
}

async function resolveUncached(root) {
  const canonical = await fs.realpath(root).catch(() => path.resolve(root));
  const common = await gitCommonDir(canonical);
  if (common) {
    const principal = path.basename(common).toLowerCase() === '.git' ? path.dirname(common) : common;
    const label = path.basename(principal).replace(/\.git$/i, '') || 'project';
    return { key: projectKey(label, common), label, root: canonical };
  }
  const folder = (await mirrorSourceRoot(canonical)) ?? canonical;
  const label = path.basename(folder) || 'project';
  return { key: projectKey(label, folder), label, root: canonical };
}

/**
 * Resolve the memory project for a workspace root. Results are cached per root;
 * a caller's abort signal only stops its own wait, never the shared lookup.
 * @param {string} root
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<{ key: string, label: string, root: string } | null>}
 */
export async function resolveMemoryProject(root, options = {}) {
  options.signal?.throwIfAborted();
  const trimmed = String(root ?? '').trim();
  if (!trimmed) return null;
  const cacheKey = identity(path.resolve(trimmed));
  let pending = cache.get(cacheKey);
  if (!pending) {
    pending = resolveUncached(trimmed);
    cache.set(cacheKey, pending);
    pending.catch(() => cache.delete(cacheKey));
  }
  const signal = options.signal;
  if (!signal) return pending;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    pending.then(value => {
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    }, error => {
      signal.removeEventListener('abort', onAbort);
      reject(error);
    });
  });
}

/** Forget cached resolutions (tests and project moves). */
export function clearMemoryProjectCache(root) {
  if (root === undefined) {
    cache.clear();
    return;
  }
  cache.delete(identity(path.resolve(String(root))));
}

/** Folder for one project's memories, relative to pages/. */
export function projectMemoryFolder(key) {
  if (!MEMORY_PROJECT_KEY_RE.test(key)) throw new Error('Invalid memory project key');
  return `${PROJECT_MEMORY_PREFIX}${key}`;
}

/** Classify a pages-relative path: user memory, a project's memory, or neither. */
export function memoryScopeOfPath(relPath) {
  const rel = String(relPath ?? '').replace(/\\/g, '/');
  if (!rel.endsWith('.md') || rel.split('/').some(part => !part || part === '.' || part === '..')) return null;
  if (rel.startsWith(USER_MEMORY_PREFIX) && !rel.slice(USER_MEMORY_PREFIX.length).includes('/')) {
    return { scope: 'user', projectKey: null };
  }
  if (rel.startsWith(PROJECT_MEMORY_PREFIX)) {
    const [key, file, ...rest] = rel.slice(PROJECT_MEMORY_PREFIX.length).split('/');
    if (key && file && rest.length === 0 && MEMORY_PROJECT_KEY_RE.test(key)) {
      return { scope: 'project', projectKey: key };
    }
  }
  return null;
}
