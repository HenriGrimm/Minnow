/**
 * Isolated chat worktrees for a workspace folder that holds several repos.
 *
 * A single-repo workspace gets one `git worktree` per chat (worktree-ops.js).
 * A folder such as `frontend/` + `backend/` is not itself a repository, so a
 * chat worktree there is a *mirrored* folder: one worktree per repo, each at
 * the repo's relative path, so `../backend` imports and relative paths still
 * resolve inside the copy. A small manifest at the folder root records which
 * repos it holds and where each came from.
 *
 * Git never runs in the parent folder — every command runs in a repo or one
 * of its worktrees.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { runProcess } from '../process-runner.js';
import { discoverWorkspaceRepos } from '../workspace/repos.js';
import { isGitRepository } from '../tools/git-change-stats.js';
import { normalizeWorkspacePathKey } from '../workspace/root.js';
import { getChatWorktreesDir, isPathUnderWorktreesRoot } from './paths.js';

export const MIRROR_MANIFEST = '.minnow-worktree.json';
const MANIFEST_VERSION = 1;

const out = (result) => `${result?.stderr || ''}\n${result?.stdout || ''}`.trim();
const git = (cwd, args, options = {}) => runProcess('git', args, { cwd, timeout: 120_000, ...options });

/**
 * @typedef {{ id: string, relPath: string, source: string, worktreePath: string, baseSha: string, baseBranch: string }} MirrorRepo
 * @typedef {{ version: number, kind: 'multi-repo', workspaceRoot: string, branch: string, repos: MirrorRepo[], createdAt: number }} MirrorManifest
 */

/**
 * The child repos when `workspaceRoot` is a folder of repos (and not itself a
 * repo); null for an ordinary single-repo workspace or a plain folder.
 * @param {string} workspaceRoot
 */
export async function multiRepoSources(workspaceRoot, options) {
  if (!workspaceRoot || await isGitRepository(workspaceRoot)) return null;
  const repos = (await discoverWorkspaceRepos(workspaceRoot, options)).filter((repo) => !repo.isRoot);
  return repos.length ? repos : null;
}

/** @param {string} wtPath @returns {Promise<MirrorManifest | null>} */
export async function readMirrorManifest(wtPath) {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(wtPath, MIRROR_MANIFEST), 'utf8'));
    if (raw?.kind !== 'multi-repo' || !Array.isArray(raw.repos)) return null;
    return raw;
  } catch {
    return null;
  }
}

/** A separately listed child is part of an indivisible chat checkout. */
export async function mirrorBranchForCheckout(cwd) {
  if (!isPathUnderWorktreesRoot(cwd)) return null;
  const key = normalizeWorkspacePathKey;
  for (let parent = path.dirname(cwd); isPathUnderWorktreesRoot(parent); parent = path.dirname(parent)) {
    const manifest = await readMirrorManifest(parent);
    if (typeof manifest?.workspaceRoot !== 'string' || typeof manifest.branch !== 'string' ||
        key(path.dirname(parent)) !== key(getChatWorktreesDir(manifest.workspaceRoot))) continue;
    if (manifest.repos.some(repo => typeof repo?.worktreePath === 'string' && key(repo.worktreePath) === key(cwd))) return manifest.branch;
  }
  return null;
}

/** Resolve a manifest row through source discovery and Git's live registration. */
export async function verifyMirrorRepo(wtPath, workspaceRoot, row) {
  const repos = await multiRepoSources(workspaceRoot);
  const original = repos?.find(repo => repo.id === row?.id);
  if (!original || row.relPath !== original.relPath || typeof row.source !== 'string' ||
      typeof row.worktreePath !== 'string' || typeof row.baseBranch !== 'string' ||
      !/^[a-f0-9]{40,64}$/i.test(row.baseSha ?? '')) throw new Error('The worktree repository no longer matches the workspace.');
  const source = await fs.realpath(original.absPath);
  const target = path.join(wtPath, original.relPath);
  const key = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  const same = (a, b) => typeof a === 'string' && typeof b === 'string' && key(a) === key(b);
  if (!same(source, original.absPath) || !same(source, row.source) || !same(target, row.worktreePath) ||
      !same(target, await fs.realpath(target))) throw new Error(`The worktree path for ${row.id} changed.`);
  const [listed, targetGit, sourceGit] = await Promise.all([
    git(source, ['worktree', 'list', '--porcelain', '-z']),
    git(target, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir']),
    git(source, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir']),
  ]);
  const [targetTop, targetCommon] = targetGit.stdout.trim().split(/\r?\n/);
  const [sourceTop, sourceCommon] = sourceGit.stdout.trim().split(/\r?\n/);
  if ([listed, targetGit, sourceGit].some(result => result.code !== 0 || result.accumulationTruncated) ||
      !same(targetTop, target) || !same(sourceTop, source) || !same(targetCommon, sourceCommon) ||
      !listed.stdout.split('\0').some(entry => entry.startsWith('worktree ') && same(entry.slice(9), target))) {
    throw new Error(`The worktree for ${row.id} is no longer registered in its original repository.`);
  }
  return { ...row, source, worktreePath: target };
}

async function writeManifest(wtPath, manifest) {
  await fs.writeFile(path.join(wtPath, MIRROR_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

async function currentBranch(cwd) {
  const head = await git(cwd, ['symbolic-ref', '--short', 'HEAD']);
  return head.code === 0 ? head.stdout.trim() : '';
}

/** True when `branch` exists in any of the repos. */
export async function branchExistsInAny(repos, branch) {
  for (const repo of repos) {
    if ((await git(repo.absPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0) return true;
  }
  return false;
}

/**
 * Create one worktree per repo inside `wtPath`, all on `branch`. All or
 * nothing: a failure removes the worktrees already added.
 * Setup failures (`prepare` returning `ok: false`) keep the worktree for retry.
 * @param {{ wtPath: string, workspaceRoot: string, repos: import('../workspace/repos.js').WorkspaceRepo[], branch: string, signal?: AbortSignal, requireNewBranch?: boolean, prepare?: (source: string, worktree: string) => Promise<any> }} input
 */
export async function createMirroredWorktree({ wtPath, workspaceRoot, repos, branch, signal, requireNewBranch = false, prepare }) {
  signal?.throwIfAborted();
  if (requireNewBranch && await branchExistsInAny(repos, branch)) {
    return { ok: false, error: 'The owned worktree branch already exists in a workspace repository.' };
  }
  /** @type {MirrorRepo[]} */
  const added = [];
  const rollback = async () => {
    for (const repo of added.reverse()) await git(repo.source, ['worktree', 'remove', '--force', repo.worktreePath]);
    await fs.rm(wtPath, { recursive: true, force: true }).catch(() => {});
  };
  await fs.mkdir(wtPath, { recursive: !requireNewBranch });
  try {
    for (const repo of repos) {
      signal?.throwIfAborted();
      const head = await git(repo.absPath, ['rev-parse', '--verify', 'HEAD']);
      if (head.code !== 0) {
        await rollback();
        return { ok: false, error: `Repository ${repo.id} has no commits yet. Create its first commit, then retry.` };
      }
      const baseSha = head.stdout.trim();
      const baseBranch = await currentBranch(repo.absPath);
      const worktreePath = path.join(wtPath, ...repo.relPath.split('/'));
      await fs.mkdir(path.dirname(worktreePath), { recursive: true });
      const exists = !requireNewBranch && (await git(repo.absPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0;
      const result = exists
        ? await git(repo.absPath, ['worktree', 'add', worktreePath, branch])
        : await git(repo.absPath, ['worktree', 'add', '-b', branch, worktreePath, baseSha]);
      if (result.code !== 0) {
        await rollback();
        return { ok: false, error: `Could not create a worktree for ${repo.id}: ${out(result)}` };
      }
      added.push({ id: repo.id, relPath: repo.relPath, source: repo.absPath, worktreePath, baseSha, baseBranch });
    }
    /** @type {MirrorManifest} */
    const manifest = { version: MANIFEST_VERSION, kind: 'multi-repo', workspaceRoot, branch, repos: added, createdAt: Date.now() };
    await writeManifest(wtPath, manifest);
    const repoRows = added.map(({ id, worktreePath }) => ({ id, path: worktreePath }));
    if (prepare) {
      const deps = [];
      for (const repo of added) deps.push({ repo: repo.id, ...(await prepare(repo.source, repo.worktreePath)) });
      const failed = deps.filter((row) => row.ok === false);
      if (failed.length) {
        const reasons = failed.flatMap((row) => (row.failed ?? []).map((item) => `${row.repo}: ${item.reason ?? item.dir ?? item}`));
        return { ok: false, path: wtPath, branch, created: true, repos: repoRows, deps,
          error: `Worktree kept. Setup failed: ${reasons.join(' ') || failed.map((row) => row.repo).join(', ')}` };
      }
      return { ok: true, path: wtPath, branch, created: true, repos: repoRows, deps };
    }
    return { ok: true, path: wtPath, branch, created: true, repos: repoRows };
  } catch (err) {
    await rollback();
    throw err;
  }
}

/** Remove every child worktree, then the mirrored folder. */
export async function removeMirroredWorktree(wtPath) {
  const manifest = await readMirrorManifest(wtPath);
  const results = [];
  for (const repo of manifest?.repos ?? []) {
    const removed = await git(repo.source, ['worktree', 'remove', '--force', repo.worktreePath]);
    await git(repo.source, ['worktree', 'prune']);
    results.push({ repo: repo.id, ok: removed.code === 0, output: out(removed) });
  }
  await fs.rm(wtPath, { recursive: true, force: true }).catch(() => {});
  return { ok: true, path: wtPath, removed: true, repos: results };
}

/**
 * Status of each child worktree, for "is everything committed?" checks.
 * @param {MirrorManifest} manifest
 */
export async function mirroredWorktreeStatus(manifest) {
  const rows = [];
  for (const repo of manifest.repos) {
    const status = await git(repo.worktreePath, ['status', '--porcelain']);
    const head = await git(repo.worktreePath, ['rev-parse', 'HEAD']);
    const branch = await currentBranch(repo.worktreePath);
    rows.push({
      id: repo.id,
      ok: status.code === 0 && head.code === 0,
      dirty: Boolean(status.stdout?.trim()),
      head: head.stdout?.trim() ?? '',
      branch,
      changed: head.code === 0 && head.stdout.trim() !== repo.baseSha,
    });
  }
  return rows;
}

/**
 * Merge each repo's worktree branch into its target. `mergeOne` is the
 * single-repo merge (merge-chat.js), run per repo; repos the chat never
 * committed to are left alone. One repo's conflict does not undo another's
 * merge — the result reports each repo separately.
 * @param {MirrorManifest} manifest
 * @param {{ branch: string, targetBranch?: string, keepWorktree?: boolean }} input
 * @param {(repoRoot: string, worktree: string, branch: string, targetBranch: string) => Promise<any>} mergeOne
 */
export async function mergeMirroredWorktree(wtPath, manifest, input, mergeOne) {
  const statuses = await mirroredWorktreeStatus(manifest);
  const unavailable = statuses.filter((row) => !row.ok).map((row) => row.id);
  if (unavailable.length) return { ok: false, error: `Could not verify ${unavailable.join(', ')}. The worktree has been kept.` };
  const dirty = statuses.filter((row) => row.dirty).map((row) => row.id);
  if (dirty.length) {
    return { ok: false, error: `Commit the agent’s changes in ${dirty.join(', ')} before approving. The worktree has been kept.` };
  }
  const wrongBranch = statuses.filter((row) => row.branch !== input.branch).map((row) => row.id);
  if (wrongBranch.length) {
    return { ok: false, error: `The worktree for ${wrongBranch.join(', ')} is no longer on ${input.branch}. It has been kept.` };
  }
  const repos = [];
  for (const repo of manifest.repos) {
    const status = statuses.find((row) => row.id === repo.id);
    if (!status?.changed) {
      repos.push({ repo: repo.id, ok: true, unchanged: true });
      continue;
    }
    const wanted = input.targetBranch?.trim();
    const hasWanted = wanted && (await git(repo.source, ['rev-parse', '--verify', '--quiet', `refs/heads/${wanted}`])).code === 0;
    const target = hasWanted ? wanted : repo.baseBranch || 'main';
    const result = await mergeOne(repo.source, repo.worktreePath, input.branch, target);
    repos.push({ repo: repo.id, target, ...result });
  }
  const failed = repos.filter((row) => !row.ok);
  if (!failed.length) {
    if (input.keepWorktree) return { ok: true, removed: false, path: wtPath, repos };
    // Once a newly changed file/tip is visible, leave the whole allocation in
    // place. Git's ordinary remove also rejects edits made after this check.
    const after = await mirroredWorktreeStatus(manifest);
    if (after.some((row, index) => !row.ok || row.dirty || row.head !== statuses[index].head || row.branch !== input.branch)) {
      return { ok: true, removed: false, path: wtPath, repos };
    }
    const directories = new Map([[wtPath, new Set([MIRROR_MANIFEST])]]);
    for (const { worktreePath } of manifest.repos) {
      for (let child = worktreePath; child !== wtPath; child = path.dirname(child)) {
        const parent = path.dirname(child);
        if (!directories.has(parent)) directories.set(parent, new Set());
        directories.get(parent).add(path.basename(child));
      }
    }
    for (const [dir, contents] of directories) {
      if ((await fs.readdir(dir)).some(name => !contents.has(name))) return { ok: true, removed: false, path: wtPath, repos };
    }
    for (const repo of manifest.repos) {
      const removed = await git(repo.source, ['worktree', 'remove', repo.worktreePath]);
      if (removed.code !== 0) return { ok: true, removed: false, path: wtPath, repos, cleanupError: out(removed) };
    }
    try {
      await fs.unlink(path.join(wtPath, MIRROR_MANIFEST));
      for (const dir of [...directories.keys()].sort((a, b) => b.length - a.length)) await fs.rmdir(dir);
      return { ok: true, removed: true, path: wtPath, repos };
    } catch (error) {
      return { ok: true, removed: false, path: wtPath, repos, cleanupError: error.message };
    }
  }
  return {
    ok: false,
    conflict: failed.some((row) => row.conflict),
    error: failed.map((row) => `${row.repo}: ${row.error}`).join('\n'),
    path: wtPath,
    repos,
  };
}
