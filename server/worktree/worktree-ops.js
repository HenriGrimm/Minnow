import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runProcess } from '../process-runner.js';
import { createWorktreeSetupQueue, runWorktreeSetupProcess } from './setup-process.js';
import { parseGitNumstat } from '../tools/git-change-stats.js';
import { invalidateRegisteredWorktreeCache } from './allowlist.js';
import { slugifyGitRefName } from '../../src/lib/git-branch-slug.mjs';
import { expandGitmojiShortcodes } from '../../src/lib/gitmoji-shortcodes.mjs';
import { refreshDependencies } from './dep-install.js';
import { ECOSYSTEM_ENTRIES, hasBrokenDepDir } from './dep-symlinks.js';
import { prepareWorktreeDependencies } from './prepare-dependencies.js';
import { prepareWorktreeEnvironment } from './local-environment.js';
import {
  getBoardWorktreesDir,
  getChatWorktreePath,
  isPathUnderWorktreesRoot,
} from './paths.js';
import {
  boardRepoLockKey, boardRepoPathspec, boardRepoRelativePath, boardRepoSlotPath as getWorktreeSlotPath,
  boardRevision, boardRevisionRepos, eachBoardRepo, readBoardRepos, runInBoardRepo,
  inBoardRepo, verifyScopedBoardCheckout, verifyBoardRepoSources, changedBoardSupport,
} from './board-repos.js';
import { getEffectiveWorkspaceRoot } from '../runtime/path-access.js';
import { normalizeWorkspacePathKey } from '../workspace/root.js';
import { worktreeAdd } from '../git/git-ops.js';
import { runGh } from '../git/gh-cli.js';
import {
  branchExistsInAny,
  createMirroredWorktree,
  multiRepoSources,
  readMirrorManifest,
  removeMirroredWorktree,
} from './multi-repo.js';

const GIT_TIMEOUT_MS = 120_000;
// Large batches of automatic chats otherwise start one disk-heavy install per
// checkout at once. Keep the installations isolated, but bound the fan-out.
const queueAutomaticChatInstall = createWorktreeSetupQueue(2);

async function git(args, cwd = getEffectiveWorkspaceRoot(), options = {}) {
  // Managed checkouts add several directories to otherwise valid project paths.
  // Scope Windows long-path support to our commands, leaving user config alone.
  const gitArgs = process.platform === 'win32' ? ['-c', 'core.longpaths=true', ...args] : args;
  return (options.signal ? runWorktreeSetupProcess : runProcess)('git', gitArgs, { cwd, timeout: GIT_TIMEOUT_MS, ...options });
}

const ok = (r) => r.code === 0;
const out = (r) => `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim();

const depFailureOutput = (deps) => deps.failed.map((f) => f.reason).join('; ');

/**
 * @param {string} wtPath
 * @param {string} intPath
 * @returns {Promise<{ ok: true, deps: { ok: boolean, linked: string[], repaired: string[], failed: Array<{ dir: string, reason: string }> } } | { ok: false, error: 'deps', deps: object, output: string }>}
 */
async function seedTaskWorktreeDeps(wtPath, intPath, options = {}) {
  options.signal?.throwIfAborted();
  const workspace = getEffectiveWorkspaceRoot();
  const preferred = (await pathExists(intPath)) ? intPath : workspace;
  let deps = await prepareWorktreeDependencies(preferred, wtPath, options);
  if (!deps.ok && !deps.environment && preferred !== workspace) {
    deps = await prepareWorktreeDependencies(workspace, wtPath, options);
  }
  if (!deps.ok || await hasBrokenDepDir(wtPath)) {
    return {
      ok: false,
      error: 'deps',
      deps,
      output: depFailureOutput(deps) || 'worktree still has a broken dependency link',
    };
  }
  return { ok: true, deps };
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Is `wtPath` a live git worktree checkout, or just a directory that happens to exist?
 *
 * A released slot can survive as a non-repo husk: `removeWorktree` runs
 * `git worktree remove --force` + `prune` (which drop `.git` and the
 * registration) before `fs.rm`, so if the rm fails — a lingering child process
 * holds the dir as its cwd, a dep junction is busy — the path is left behind
 * with no `.git`. Treating that as a reusable worktree runs every later git
 * command in a non-repo, which fails as
 * `fatal: not a git repository (or any of the parent directories): .git`
 * on every retry forever.
 *
 * @param {string} wtPath
 * @returns {Promise<boolean>}
 */
export async function isWorktreeCheckout(wtPath, options = {}) {
  if (!(await pathExists(path.join(wtPath, '.git')))) return false;
  const r = await git(['rev-parse', '--is-inside-work-tree'], wtPath, options);
  return ok(r) && (r.stdout ?? '').trim() === 'true';
}

/**
 * Empty a husk slot so `git worktree add` can claim the path again.
 *
 * `git worktree add` accepts an existing *empty* directory, so an undeletable
 * (but emptied) husk still recovers — deleting the leaf dir itself can be
 * impossible on Windows while any process holds it as its cwd.
 *
 * @param {string} wtPath
 * @returns {Promise<{ ok: boolean, output?: string }>}
 */
async function reclaimStaleWorktreeDir(wtPath, options = {}) {
  options.signal?.throwIfAborted();
  if (!isPathUnderWorktreesRoot(wtPath)) {
    return { ok: false, output: 'refusing to reclaim a path outside the worktrees root' };
  }
  // Drop any stale registration still pointing here before reusing the path.
  await git(['worktree', 'prune', '--expire', 'now'], undefined, options);
  /** @type {string[]} */
  let entries = [];
  try {
    entries = await fs.readdir(wtPath);
  } catch {
    return { ok: true };
  }
  for (const entry of entries) {
    options.signal?.throwIfAborted();
    // Junction/symlink dep dirs must be unlinked, never recursed into: the
    // targets are the real workspace node_modules.
    try {
      await fs.rm(path.join(wtPath, entry), {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      });
    } catch {
    }
  }
  // The dir itself may be pinned by another process' cwd; empty is good enough.
  try {
    await fs.rmdir(wtPath);
  } catch {
  }
  let remaining = [];
  try {
    remaining = await fs.readdir(wtPath);
  } catch {
    return { ok: true };
  }
  if (remaining.length > 0) {
    return { ok: false, output: `stale worktree dir not empty: ${remaining.join(', ')}` };
  }
  return { ok: true };
}

async function branchExists(branch, options = {}) {
  const r = await git(['rev-parse', '--verify', '--quiet', branch], undefined, options);
  return r.code === 0;
}

/**
 * Drop a leftover attempt branch so the next `createWorktree` can `-b` from integration.
 * `git worktree remove` leaves the ref; a task-keyed slot would otherwise re-attach it.
 * @param {string} branch
 * @returns {Promise<{ ok: boolean, output: string }>}
 */
export async function deleteLocalBranch(branch, options = {}) {
  const name = String(branch || '').trim();
  if (!name || name.includes('..') || name.includes('\0')) {
    return { ok: false, output: 'invalid branch name' };
  }
  const r = await git(['branch', '-D', name], undefined, options);
  const text = out(r);
  // Missing refs are success: first allocate never created the branch.
  if (ok(r) || /not found/i.test(text)) return { ok: true, output: text };
  return { ok: false, output: text };
}

export async function deleteBoardTaskBranch(boardId, branch, options) {
  const layout = await readBoardRepos(boardId);
  return layout ? repoResults(await eachBoardRepo(layout, () => deleteLocalBranch(branch, options))) : deleteLocalBranch(branch, options);
}

async function resolveRef(ref, cwd = getEffectiveWorkspaceRoot(), options = {}) {
  const r = await git(['rev-parse', '--verify', ref], cwd, options);
  if (!ok(r)) return null;
  const sha = `${r.stdout ?? ''}`.trim().split(/\s/)[0];
  return sha || null;
}

/**
 * @type {Map<string, Promise<unknown>>}
 */
const integrationOpChains = new Map();

const activeIntegrationOps = new Map();

const peakIntegrationOps = new Map();

/**
 * @template T
 * @param {string} boardId
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
function withBoardIntegrationLock(boardId, task) {
  const key = boardRepoLockKey(boardId) || '';
  const previous = integrationOpChains.get(key) ?? Promise.resolve();
  const run = async () => {
    const nextActive = (activeIntegrationOps.get(key) ?? 0) + 1;
    activeIntegrationOps.set(key, nextActive);
    peakIntegrationOps.set(key, Math.max(peakIntegrationOps.get(key) ?? 0, nextActive));
    try {
      return await task();
    } finally {
      const left = (activeIntegrationOps.get(key) ?? 1) - 1;
      if (left <= 0) activeIntegrationOps.delete(key);
      else activeIntegrationOps.set(key, left);
    }
  };
  const next = previous.then(run, run);
  integrationOpChains.set(
    key,
    next.catch(() => {}),
  );
  return next;
}

export function peakBoardIntegrationLockDepth(boardId) {
  return peakIntegrationOps.get(boardId || '') ?? 0;
}

export function resetBoardIntegrationLock() {
  integrationOpChains.clear();
  activeIntegrationOps.clear();
  peakIntegrationOps.clear();
}

function isBoardIntegrationLocked(boardId) {
  return (activeIntegrationOps.get(boardRepoLockKey(boardId) || '') ?? 0) > 0;
}

function repoResults(rows) {
  const failure = rows.find(([, result]) => !result.ok);
  return failure
    ? { ok: false, error: `${failure[0]}: ${failure[1].output || failure[1].error || 'Git operation failed'}`, repos: Object.fromEntries(rows) }
    : { ok: true, repos: Object.fromEntries(rows) };
}

function aggregateBoardStats(rows) {
  const changed = rows.filter(([, row]) => row.fileCount > 0);
  return {
    ...repoResults(rows),
    ...Object.fromEntries(['additions', 'deletions', 'fileCount'].map(key => [key, rows.reduce((sum, [, row]) => sum + (row[key] ?? 0), 0)])),
    alreadyLanded: rows.every(([, row]) => row.alreadyLanded),
    hasRemote: changed.length > 0 && changed.every(([, row]) => row.hasRemote),
    hasGh: changed.every(([, row]) => row.hasGh),
  };
}

/**
 * @param {string} wtPath
 * @param {string} name
 * @returns {Promise<string | null>}
 */
async function gitDirPath(wtPath, name) {
  const r = await git(['rev-parse', '--git-path', name], wtPath);
  const p = `${r.stdout ?? ''}`.trim();
  if (!p) return null;
  return path.isAbsolute(p) ? p : path.resolve(wtPath, p);
}

async function rebaseStateExists(wtPath) {
  const mergePath = await gitDirPath(wtPath, 'rebase-merge');
  const applyPath = await gitDirPath(wtPath, 'rebase-apply');
  return (
    Boolean(mergePath && (await pathExists(mergePath))) ||
    Boolean(applyPath && (await pathExists(applyPath)))
  );
}

/**
 * @param {string} wtPath
 * @param {string | null} shaBefore
 */
async function abortRebaseAndVerify(wtPath, shaBefore) {
  if (!(await rebaseStateExists(wtPath))) return;
  await git(['rebase', '--abort'], wtPath);
  if (!(await rebaseStateExists(wtPath))) return;

  await git(['rebase', '--quit'], wtPath);
  if (shaBefore) {
    await git(['reset', '--hard', shaBefore], wtPath);
  }
  await git(['clean', '-fd'], wtPath);
  if (!(await rebaseStateExists(wtPath))) return;

  const mergePath = await gitDirPath(wtPath, 'rebase-merge');
  const applyPath = await gitDirPath(wtPath, 'rebase-apply');
  if (mergePath && (await pathExists(mergePath))) {
    await fs.rm(mergePath, { recursive: true, force: true });
  }
  if (applyPath && (await pathExists(applyPath))) {
    await fs.rm(applyPath, { recursive: true, force: true });
  }
}

function parseNameOnly(stdout) {
  return `${stdout ?? ''}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * @param {{ boardId: string, branch: string, baseRef?: string }} input
 */
export async function ensureIntegration({ boardId, branch, baseRef, signal, onProgress }) {
  signal?.throwIfAborted();
  const layout = await readBoardRepos(boardId);
  if (layout) {
    return withBoardIntegrationLock(boardId, async () => {
      const rows = await eachBoardRepo(layout, repo => ensureIntegration({ boardId, branch, baseRef: repo.baseSha, signal, onProgress }));
      return { ...repoResults(rows), path: getWorktreeSlotPath(boardId, 'integration'), branch };
    });
  }
  const base = (baseRef && baseRef.trim()) || 'HEAD';
  if (!(await branchExists(branch, { signal }))) {
    const b = await git(['branch', branch, base], undefined, { signal });
    if (!ok(b)) return { ok: false, stage: 'branch', output: out(b) };
  }
  const intPath = getWorktreeSlotPath(boardId, 'integration');
  if (await pathExists(intPath)) {
    if (!(await isWorktreeCheckout(intPath, { signal }))) {
      return {
        ok: false,
        stage: 'worktree',
        path: intPath,
        error: `Board integration folder is not a valid Git worktree: ${intPath}. Preserve any work in this folder, then repair or move it before retrying.`,
      };
    }
    await verifyScopedBoardCheckout(intPath, branch);
    const deps = await prepareWorktreeDependencies(getEffectiveWorkspaceRoot(), intPath, { signal, onProgress });
    if (!deps.ok) return { ok: false, stage: 'deps', path: intPath, deps, output: depFailureOutput(deps) };
    return { ok: true, path: intPath, branch, created: false, deps };
  }
  await fs.mkdir(path.dirname(intPath), { recursive: true });
  if (inBoardRepo()) await git(['worktree', 'prune', '--expire', 'now'], undefined, { signal });
  const w = await git(['worktree', 'add', intPath, branch], undefined, { signal });
  if (!ok(w)) return { ok: false, stage: 'worktree', path: intPath, output: out(w) };
  const deps = await prepareWorktreeDependencies(getEffectiveWorkspaceRoot(), intPath, { signal, onProgress });
  if (!deps.ok) return { ok: false, stage: 'deps', path: intPath, deps, output: depFailureOutput(deps) };
  return { ok: true, path: intPath, branch, created: true, deps };
}

async function mergeBaseIntoWorktree(wtPath, baseRef, options = {}) {
  const m = await git(['merge', baseRef, '--no-edit'], wtPath, options);
  if (ok(m)) return { ok: true, output: out(m) };
  await git(['merge', '--abort'], wtPath);
  return { ok: false, conflict: true, output: out(m) };
}

/**
 * @param {{ boardId: string, slotId: string, branch: string, baseRef?: string, syncBase?: boolean }} input
 */
export async function createWorktree({ boardId, slotId, branch, baseRef, syncBase = true, signal, onProgress }) {
  signal?.throwIfAborted();
  const layout = await readBoardRepos(boardId);
  if (layout) {
    const base = await withBoardIntegrationLock(boardId, () => readIntegrationRef({ boardId, ref: baseRef }));
    const revisions = boardRevisionRepos(base);
    if (!revisions) return { ok: false, error: 'Could not resolve all repository bases for the task checkout.' };
    const rows = await eachBoardRepo(layout, repo => createWorktree({ boardId, slotId, branch, baseRef: revisions.get(repo.id), syncBase, signal, onProgress }));
    return { ...repoResults(rows), path: getWorktreeSlotPath(boardId, slotId), branch, created: rows.some(([, result]) => result.created) };
  }
  onProgress?.({ stage: 'workspace', message: 'Preparing task checkout…' });
  const wtPath = getWorktreeSlotPath(boardId, slotId);
  const base = (baseRef && baseRef.trim()) || 'HEAD';
  const intPath = getWorktreeSlotPath(boardId, 'integration');

  let exists = await pathExists(wtPath);

  if (exists && !(await isWorktreeCheckout(wtPath, { signal }))) {
    if (inBoardRepo()) return { ok: false, error: `Invalid board checkout at ${wtPath}. Preserve its contents before retrying.` };
    // Husk from a release whose `fs.rm` failed. Reclaim the path instead of
    // reusing it, or every later git call runs in a non-repo.
    const reclaimed = await reclaimStaleWorktreeDir(wtPath, { signal });
    if (!reclaimed.ok) {
      return {
        ok: false,
        error: 'stale worktree directory',
        path: wtPath,
        branch,
        output: reclaimed.output,
      };
    }
    exists = false;
  }

  if (exists) {
    await verifyScopedBoardCheckout(wtPath, branch);
    // Validate/copy against the final base's ignore rules, not the old branch.
    const synced = syncBase ? await mergeBaseIntoWorktree(wtPath, base, { signal }) : { ok: true };
    if (!synced.ok) {
      return {
        ok: false,
        conflict: synced.conflict,
        path: wtPath,
        branch,
        output: synced.output,
      };
    }
    const seeded = await seedTaskWorktreeDeps(wtPath, intPath, { signal, onProgress });
    if (!seeded.ok) {
      return {
        ok: false,
        error: 'deps',
        path: wtPath,
        branch,
        created: false,
        deps: seeded.deps,
        output: seeded.output,
      };
    }
    return { ok: true, path: wtPath, branch, created: false, synced: syncBase, deps: seeded.deps };
  }

  await fs.mkdir(path.dirname(wtPath), { recursive: true });
  const baseSha = await resolveRef(base, undefined, { signal });
  if (!baseSha) {
    return { ok: false, error: `invalid baseRef: ${base}`, path: wtPath, branch };
  }

  if (await branchExists(branch, { signal })) {
    if (inBoardRepo()) await git(['worktree', 'prune', '--expire', 'now'], undefined, { signal });
    const w = await git(['worktree', 'add', wtPath, branch], undefined, { signal });
    if (!ok(w)) return { ok: false, path: wtPath, branch, output: out(w) };
    const synced = syncBase ? await mergeBaseIntoWorktree(wtPath, base, { signal }) : { ok: true };
    if (!synced.ok) {
      return {
        ok: false,
        conflict: synced.conflict,
        path: wtPath,
        branch,
        output: synced.output,
      };
    }
    const seeded = await seedTaskWorktreeDeps(wtPath, intPath, { signal, onProgress });
    if (!seeded.ok) {
      return {
        ok: false,
        error: 'deps',
        path: wtPath,
        branch,
        created: true,
        deps: seeded.deps,
        output: seeded.output,
      };
    }
    return { ok: true, path: wtPath, branch, created: true, deps: seeded.deps };
  }

  const r = await git(['worktree', 'add', '-b', branch, wtPath, baseSha], undefined, { signal });
  if (!ok(r)) return { ok: false, path: wtPath, branch, output: out(r) };
  const seeded = await seedTaskWorktreeDeps(wtPath, intPath, { signal, onProgress });
  if (!seeded.ok) {
    return {
      ok: false,
      error: 'deps',
      path: wtPath,
      branch,
      created: true,
      deps: seeded.deps,
      output: seeded.output,
    };
  }
  return { ok: true, path: wtPath, branch, created: true, deps: seeded.deps };
}

/**
 * @param {{ boardId: string, fromBranch: string, message?: string }} input
 */
export async function mergeIntoIntegration(input) {
  const layout = await readBoardRepos(input.boardId);
  if (layout) {
    return withBoardIntegrationLock(input.boardId, async () => {
      const rows = [];
      for (const repo of layout.repos) {
        const result = await runInBoardRepo(layout, repo, () => mergeIntoIntegration({ ...input, fastForwardOnly: true }));
        rows.push([repo.id, result]);
        if (!result.ok) return { ...repoResults(rows), conflictedFiles: (result.conflictedFiles ?? []).map(file => boardRepoRelativePath(repo, file)) };
      }
      return repoResults(rows);
    });
  }
  return withBoardIntegrationLock(input.boardId, () => mergeIntoIntegrationUnlocked(input));
}

/** @param {{ boardId: string, fromBranch: string, message?: string }} input */
async function mergeIntoIntegrationUnlocked({ boardId, fromBranch, message, fastForwardOnly }) {
  const intPath = getWorktreeSlotPath(boardId, 'integration');
  try {
    await fs.access(intPath);
  } catch {
    return { ok: false, error: 'integration worktree missing' };
  }
  const headBefore = await git(['rev-parse', 'HEAD'], intPath);
  const integrationSha = ok(headBefore) ? `${headBefore.stdout ?? ''}`.trim() : null;
  const args = ['merge', '--no-edit', ...(fastForwardOnly ? ['--ff-only'] : [])];
  if (message && message.trim()) args.push('-m', message.trim());
  args.push(fromBranch);
  const m = await git(args, intPath);
  if (!ok(m)) {
    const diff = await git(['diff', '--name-only', '--diff-filter=U'], intPath);
    const conflictedFiles = parseNameOnly(diff.stdout);
    return {
      ok: false,
      conflict: true,
      output: out(m),
      conflictedFiles,
      integrationSha: integrationSha || undefined,
    };
  }
  return { ok: true, output: out(m), integrationSha: integrationSha || undefined };
}

/**
 * @param {{ boardId: string }} input
 */
export async function mergeInProgress({ boardId }) {
  const layout = await readBoardRepos(boardId);
  if (layout) {
    const rows = await eachBoardRepo(layout, () => mergeInProgress({ boardId }));
    return { ...repoResults(rows), inProgress: isBoardIntegrationLocked(boardId) || rows.some(([, row]) => row.inProgress) };
  }
  const intPath = getWorktreeSlotPath(boardId, 'integration');
  try {
    await fs.access(intPath);
  } catch {
    return { ok: false, error: 'integration worktree missing' };
  }
  const r = await git(['rev-parse', '--verify', 'MERGE_HEAD'], intPath);
  return { ok: true, inProgress: r.code === 0 || isBoardIntegrationLocked(boardId) };
}

/**
 * @param {{ boardId: string, ref?: string }} input
 * @returns {Promise<string | null>}
 */
export async function readIntegrationRef({ boardId, ref = 'HEAD' }) {
  const layout = await readBoardRepos(boardId);
  if (layout) {
    const rows = await eachBoardRepo(layout, () => readIntegrationRef({ boardId, ref }));
    return rows.every(([, sha]) => sha) ? boardRevision(Object.fromEntries(rows)) : null;
  }
  const intPath = getWorktreeSlotPath(boardId, 'integration');
  try {
    await fs.access(intPath);
  } catch {
    return null;
  }
  const name = (ref && String(ref).trim()) || 'HEAD';
  return resolveRef(name, intPath);
}

/**
 * @param {{ boardId: string, slotId: string }} input
 * @returns {Promise<{ ok: true, sha: string } | { ok: false, conflicts: string[], error?: string }>}
 */
export async function rebaseOntoIntegration(input) {
  const layout = await readBoardRepos(input.boardId);
  if (layout) {
    return withBoardIntegrationLock(input.boardId, async () => {
      const rows = [];
      for (const repo of layout.repos) {
        const result = await runInBoardRepo(layout, repo, () => rebaseOntoIntegration({ ...input, rebaseUnchanged: true }));
        if (!result.ok) return {
          ok: false, conflicts: (result.conflicts ?? []).map(file => boardRepoRelativePath(repo, file)),
          error: `${repo.id}: ${result.error || 'rebase conflicted'}`,
        };
        rows.push([repo.id, result.sha]);
      }
      return { ok: true, sha: boardRevision(Object.fromEntries(rows)) };
    });
  }
  return withBoardIntegrationLock(input.boardId, () => rebaseOntoIntegrationUnlocked(input));
}

/** @param {{ boardId: string, slotId: string }} input */
async function rebaseOntoIntegrationUnlocked({ boardId, slotId, rebaseUnchanged }) {
  const wtPath = getWorktreeSlotPath(boardId, slotId);
  const intPath = getWorktreeSlotPath(boardId, 'integration');
  try {
    await fs.access(wtPath);
  } catch {
    return { ok: false, error: 'worktree missing', conflicts: [] };
  }
  try {
    await fs.access(intPath);
  } catch {
    return { ok: false, error: 'integration worktree missing', conflicts: [] };
  }

  const shaBefore = await resolveRef('HEAD', wtPath);
  const intSha = await resolveRef('HEAD', intPath);
  if (!shaBefore) return { ok: false, error: 'could not resolve worktree HEAD', conflicts: [] };
  if (!intSha) return { ok: false, error: 'could not resolve integration HEAD', conflicts: [] };

  const unique = await git(['rev-list', '--count', `${intSha}..HEAD`], wtPath);
  const uniqueCount = Number.parseInt(`${unique.stdout ?? ''}`.trim(), 10) || 0;
  if (uniqueCount === 0) {
    if (rebaseUnchanged && intSha !== shaBefore) {
      const fastForward = await git(['merge', '--ff-only', intSha], wtPath);
      if (!ok(fastForward)) return { ok: false, conflicts: [], error: out(fastForward) };
      return { ok: true, sha: intSha };
    }
    return { ok: true, sha: shaBefore };
  }

  const rebase = await git(['rebase', intSha], wtPath);
  if (ok(rebase)) {
    const shaAfter = (await resolveRef('HEAD', wtPath)) || shaBefore;
    return { ok: true, sha: shaAfter };
  }

  const diff = await git(['diff', '--name-only', '--diff-filter=U'], wtPath);
  const conflicts = parseNameOnly(diff.stdout);

  await abortRebaseAndVerify(wtPath, shaBefore);

  if (conflicts.length > 0) {
    return { ok: false, conflicts };
  }
  return {
    ok: false,
    conflicts: [],
    error: out(rebase) || 'rebase failed',
  };
}

/**
 * @param {{ boardId: string, slotId: string, message?: string, paths?: string[] }} input
 */
export async function commitWorktree({ boardId, slotId, message, paths, signal }) {
  signal?.throwIfAborted();
  const layout = await readBoardRepos(boardId);
  if (layout) {
    if (!paths) {
      const outside = await changedBoardSupport(layout, slotId);
      if (outside.length) return { ok: false, error: `Changes outside board repositories: ${outside.join(', ')}. Move the changes into a repository or restore the workspace-level files.` };
    }
    const rows = await eachBoardRepo(layout, repo => {
      const selected = paths && paths.filter(file => (layout.repos
        .filter(candidate => candidate.id === '.' || file.startsWith(candidate.id + '/'))
        .sort((a, b) => b.id.length - a.id.length)[0])?.id === repo.id)
        .map(file => repo.id === '.' ? file : file.slice(repo.id.length + 1));
      return selected?.length === 0 ? { ok: true } : commitWorktree({ boardId, slotId, message, paths: selected, signal });
    });
    return { ...repoResults(rows), committed: rows.some(([, result]) => result.committed) };
  }
  const wtPath = getWorktreeSlotPath(boardId, slotId);
  try {
    await fs.access(wtPath);
  } catch {
    return { ok: false, error: 'worktree missing' };
  }
  const excludes = boardRepoPathspec();
  const pathspec = paths?.length || excludes.length ? ['--', ...(paths ?? []), ...excludes] : [];
  const add = await git(['add', '-A', ...pathspec], wtPath, { signal });
  if (!ok(add)) return { ok: false, output: out(add) };
  const staged = await git(['diff', '--cached', '--quiet', ...pathspec], wtPath, { signal });
  if (staged.code === 0) {
    return { ok: true, committed: false };
  }
  const commitMsg = expandGitmojiShortcodes((message && message.trim()) || 'Board task commit');
  const commit = await git(['commit', '-m', commitMsg, ...pathspec], wtPath, { signal });
  if (!ok(commit)) return { ok: false, output: out(commit) };
  return { ok: true, committed: true, output: out(commit) };
}

/**
 * @param {{ boardId: string, slotId: string }} input
 */
export async function checkWorktreeDirty({ boardId, slotId }) {
  const layout = await readBoardRepos(boardId);
  if (layout) {
    const rows = await eachBoardRepo(layout, () => checkWorktreeDirty({ boardId, slotId }));
    const outside = await changedBoardSupport(layout, slotId);
    return { ...repoResults(rows), dirty: outside.length > 0 || rows.some(([, row]) => row.dirty),
      files: [...outside, ...rows.flatMap(([id, row]) => (row.files ?? []).map(file => `${id}: ${file}`))] };
  }
  const wtPath = getWorktreeSlotPath(boardId, slotId);
  try {
    await fs.access(wtPath);
  } catch {
    return { ok: false, error: 'worktree missing' };
  }
  const status = await git(['status', '--porcelain', '--', ...boardRepoPathspec()], wtPath);
  const files = `${status.stdout ?? ''}${status.stderr ?? ''}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return { ok: ok(status), dirty: files.length > 0, files };
}

/**
 * @param {{ boardId: string, fromBranch: string }} input
 */
export async function checkMerged({ boardId, fromBranch }) {
  const intPath = getWorktreeSlotPath(boardId, 'integration');
  try {
    await fs.access(intPath);
  } catch {
    return { ok: false, error: 'integration worktree missing' };
  }
  const branch = (fromBranch && fromBranch.trim()) || '';
  if (!branch) return { ok: false, error: 'fromBranch required' };
  const r = await git(['merge-base', '--is-ancestor', branch, 'HEAD'], intPath);
  return { ok: true, merged: r.code === 0 };
}

/**
 * @param {{ boardId: string, sha: string }} input
 */
export async function restoreIntegration(input) {
  const layout = await readBoardRepos(input.boardId);
  if (layout) {
    const revisions = boardRevisionRepos(input.sha);
    if (!revisions || revisions.size !== layout.repos.length || layout.repos.some(repo => !revisions.has(repo.id))) {
      return { ok: false, error: 'Integration revision does not match the board repositories' };
    }
    return withBoardIntegrationLock(input.boardId, async () => {
      const changed = [];
      for (const repo of layout.repos) {
        const { ok: targetExists, head } = await runInBoardRepo(layout, repo, async () => ({
          ok: Boolean(await resolveRef(revisions.get(repo.id))),
          head: await readIntegrationRef({ boardId: input.boardId }),
        }));
        if (!targetExists || !head) return { ok: false, error: `Cannot restore integration history for ${repo.id}.` };
        if (head !== revisions.get(repo.id)) {
          const dirty = await runInBoardRepo(layout, repo, () => checkWorktreeDirty({ boardId: input.boardId, slotId: 'integration' }));
          if (!dirty.ok || dirty.dirty) return { ok: false, error: `Integration checkout ${repo.id} has local changes. Preserve them before restoring.` };
          changed.push(repo);
        }
      }
      const rows = await eachBoardRepo({ ...layout, repos: changed }, repo => restoreIntegration({ ...input, sha: revisions.get(repo.id), preserveUntracked: true }));
      return { ...repoResults(rows), sha: input.sha };
    });
  }
  return withBoardIntegrationLock(input.boardId, () => restoreIntegrationUnlocked(input));
}

/** @param {{ boardId: string, sha: string }} input */
async function restoreIntegrationUnlocked({ boardId, sha, preserveUntracked }) {
  const intPath = getWorktreeSlotPath(boardId, 'integration');
  try {
    await fs.access(intPath);
  } catch {
    return { ok: false, error: 'integration worktree missing' };
  }
  const target = (sha && sha.trim()) || '';
  if (!target) return { ok: false, error: 'sha required' };
  const resolved = await resolveRef(target);
  if (!resolved) return { ok: false, error: `invalid sha: ${target}` };

  await git(['merge', '--abort'], intPath);
  const reset = await git(['reset', '--hard', resolved], intPath);
  if (!ok(reset)) return { ok: false, output: out(reset) };
  if (!preserveUntracked) await git(['clean', '-fd'], intPath);
  return { ok: true, sha: resolved, output: out(reset) };
}

/**
 * @param {{ boardId: string, fromBranch: string }} input
 */
export async function verifyIntegrationMerge({ boardId, fromBranch }) {
  const layout = await readBoardRepos(boardId);
  if (layout) {
    const rows = await eachBoardRepo(layout, () => verifyIntegrationMerge({ boardId, fromBranch }));
    return { ...repoResults(rows), verified: rows.every(([, result]) => result.verified),
      reasons: rows.flatMap(([id, result]) => (result.reasons ?? []).map(reason => {
        const prefix = 'conflict markers remain in: ';
        return reason.startsWith(prefix)
          ? prefix + reason.slice(prefix.length).split(', ').map(file => boardRepoRelativePath({ id }, file.replace(/^HEAD:/, ''))).join(', ')
          : `${id}: ${reason}`;
      })) };
  }
  const intPath = getWorktreeSlotPath(boardId, 'integration');
  try {
    await fs.access(intPath);
  } catch {
    return { ok: false, error: 'integration worktree missing' };
  }
  const branch = (fromBranch && fromBranch.trim()) || '';
  if (!branch) return { ok: false, error: 'fromBranch required' };

  const reasons = [];

  const ancestor = await git(['merge-base', '--is-ancestor', branch, 'HEAD'], intPath);
  if (ancestor.code !== 0) {
    reasons.push(`${branch} is not an ancestor of integration HEAD`);
  }

  const markers = await git(
    ['grep', '-lE', '^(<{7}|={7}|>{7})( |$)', 'HEAD'],
    intPath,
  );
  if (ok(markers)) {
    const files = `${markers.stdout ?? ''}`
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (files.length) {
      reasons.push(`conflict markers remain in: ${files.join(', ')}`);
    }
  }

  // `--untracked-files=no` on purpose: an untracked path cannot conflict with a
  // merge, and counting it as dirty fails every merge in a worktree that has
  // linked dep dirs, build output, or stray scratch files lying around.
  const status = await git(['status', '--porcelain', '--untracked-files=no'], intPath);
  const dirty = `${status.stdout ?? ''}${status.stderr ?? ''}`.trim();
  if (dirty) {
    reasons.push('integration worktree has uncommitted changes to tracked files');
  }

  return { ok: true, verified: reasons.length === 0, reasons };
}

/**
 * @param {{ boardId: string }} input
 */
export async function abortMerge(input) {
  const layout = await readBoardRepos(input.boardId);
  if (layout) return repoResults(await eachBoardRepo(layout, () => abortMerge(input)));
  return withBoardIntegrationLock(input.boardId, () => abortMergeUnlocked(input));
}

/** @param {{ boardId: string }} input */
async function abortMergeUnlocked({ boardId }) {
  const intPath = getWorktreeSlotPath(boardId, 'integration');
  try {
    await fs.access(intPath);
  } catch {
    return { ok: false, error: 'integration worktree missing' };
  }
  const r = await git(['merge', '--abort'], intPath);
  return { ok: ok(r) || /no merge in progress/i.test(out(r)), output: out(r) };
}

/**
 * @param {{ boardId: string, slotId: string }} input
 */
export async function removeWorktree({ boardId, slotId, protectDirty = false }) {
  const layout = await readBoardRepos(boardId);
  if (layout) {
    await verifyBoardRepoSources(layout);
    const root = getWorktreeSlotPath(boardId, slotId);
    if (protectDirty && await pathExists(root) && (await changedBoardSupport(layout, slotId)).length) {
      return { ok: false, error: `Preserve workspace-level changes in ${root} before removing this slot.` };
    }
    const rows = await eachBoardRepo({ ...layout, repos: [...layout.repos].reverse() }, () => removeWorktree({ boardId, slotId, protectDirty }));
    const result = repoResults(rows);
    if (result.ok && !layout.repos.some(repo => repo.id === '.') && isPathUnderWorktreesRoot(root)) {
      await fs.rm(root, { recursive: true, force: true });
    }
    return { ...result, path: root };
  }
  const wtPath = getWorktreeSlotPath(boardId, slotId);
  if (!isPathUnderWorktreesRoot(wtPath)) {
    return { ok: false, error: 'refusing to remove path outside the worktrees root' };
  }
  if (protectDirty) {
    if (!(await pathExists(wtPath))) return { ok: true };
    const removed = await git(['worktree', 'remove', wtPath]);
    return ok(removed) ? { ok: true, path: wtPath } : { ok: false, output: out(removed) };
  }
  const r = await git(['worktree', 'remove', '--force', wtPath]);
  await git(['worktree', 'prune', '--expire', 'now']);
  try {
    await fs.rm(wtPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
  }
  if (await pathExists(wtPath)) {
    return {
      ok: false,
      error: 'worktree directory survived removal',
      path: wtPath,
      output: out(r),
    };
  }
  return { ok: true, path: wtPath, output: out(r) };
}

/**
 * Drop many slots with one prune instead of `git worktree remove` + prune per slot.
 *
 * Per-slot remove is O(n²) against git's worktree list: each prune re-reads every
 * remaining registration. A board that leaked hundreds of attempt slots then
 * blocked engine load (and the SSE snapshot) for minutes — EventSource stayed
 * on "reconnecting" and later fetches failed.
 *
 * `rm` + `prune --expire now` is the documented recovery for missing worktree
 * directories; `--expire now` is required because prune's default grace is 3 months.
 *
 * @param {{ boardId: string, slotIds: string[] }} input
 * @returns {Promise<{ ok: boolean, removed: string[], failedSlots: string[] }>}
 */
export async function removeWorktreeSlotsBulk({ boardId, slotIds }) {
  /** @type {string[]} */
  const removed = [];
  /** @type {string[]} */
  const failedSlots = [];
  for (const slotId of slotIds) {
    const wtPath = getWorktreeSlotPath(boardId, slotId);
    if (!isPathUnderWorktreesRoot(wtPath)) {
      failedSlots.push(slotId);
      continue;
    }
    try {
      await fs.rm(wtPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
    }
    if (await pathExists(wtPath)) {
      failedSlots.push(slotId);
      continue;
    }
    removed.push(wtPath);
  }
  await git(['worktree', 'prune', '--expire', 'now']);
  return { ok: failedSlots.length === 0, removed, failedSlots };
}

/** Top-level dirs a husk may hold that are never someone's work. */
const DISPOSABLE_REAL_DEP_DIRS = new Set(['node_modules', '.venv', 'venv']);
const LINKABLE_DEP_DIRS = new Set(ECOSYSTEM_ENTRIES.flatMap((entry) => entry.dirs));
const HUSK_FILE_LIMIT = 20_000;

/**
 * Every blob path in HEAD and in this board's branches, keyed by repo-relative path.
 * @param {string} boardId
 * @returns {Promise<Map<string, Set<string>> | null>}
 */
async function loadCommittedBlobs(boardId) {
  const refs = await git(['for-each-ref', '--format=%(refname)', `refs/heads/minnow/board/${boardId}/`]);
  const revs = ['HEAD', ...(ok(refs) ? parseNameOnly(refs.stdout) : [])];
  /** @type {Map<string, Set<string>>} */
  const blobs = new Map();
  let anyTree = false;
  for (const rev of revs) {
    const tree = await git(['ls-tree', '-r', '-z', '--full-tree', rev]);
    if (!ok(tree)) continue;
    anyTree = true;
    for (const record of String(tree.stdout ?? '').split('\0')) {
      const match = /^\d+ blob ([0-9a-f]+)\t(.+)$/s.exec(record);
      if (!match) continue;
      const set = blobs.get(match[2]) ?? new Set();
      set.add(match[1]);
      blobs.set(match[2], set);
    }
  }
  return anyTree ? blobs : null;
}

/** @param {Buffer} content @param {number} shaLength */
function gitBlobIds(content, shaLength) {
  const algo = shaLength === 64 ? 'sha256' : 'sha1';
  const id = (buf) => createHash(algo).update(`blob ${buf.length}\0`).update(buf).digest('hex');
  const ids = [id(content)];
  // autocrlf checkouts turn committed LF into CRLF on disk.
  if (content.includes('\r\n')) ids.push(id(Buffer.from(content.toString('latin1').replace(/\r\n/g, '\n'), 'latin1')));
  return ids;
}

/**
 * @typedef {{ root: string, files: string[], dirs: string[], disposable: string[], unverified: string[], truncated: boolean }} HuskInspection
 */

/**
 * Inspect a slot folder whose `.git` is gone — typically a worktree removal whose
 * recursive rm deleted `.git` and then hit a locked file. Such a husk is safe to
 * delete only when every file in it is recoverable from a commit.
 *
 * @param {string} root
 * @param {Promise<Map<string, Set<string>> | null>} committedPromise
 * @returns {Promise<HuskInspection>}
 */
async function inspectHusk(root, committedPromise) {
  /** @type {HuskInspection} */
  const husk = { root, files: [], dirs: [], disposable: [], unverified: [], truncated: false };
  /** @type {Map<string, Set<string>> | null | undefined} */
  let committed;
  const walk = async (dir, rel) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      // Node reports Windows junctions as symbolic links.
      if (!rel && LINKABLE_DEP_DIRS.has(entry.name) && entry.isSymbolicLink()) {
        husk.disposable.push(abs);
        continue;
      }
      if (!rel && entry.isDirectory() && DISPOSABLE_REAL_DEP_DIRS.has(entry.name)) {
        husk.disposable.push(abs);
        continue;
      }
      if (entry.isDirectory()) {
        await walk(abs, relPath);
        husk.dirs.push(abs);
        continue;
      }
      if (husk.files.length >= HUSK_FILE_LIMIT) {
        husk.truncated = true;
        husk.unverified.push(relPath);
        continue;
      }
      husk.files.push(abs);
      committed ??= await committedPromise;
      const expected = committed?.get(relPath);
      let content;
      try {
        content = entry.isSymbolicLink() ? Buffer.from(await fs.readlink(abs)) : await fs.readFile(abs);
      } catch {
        husk.unverified.push(relPath);
        continue;
      }
      const shaLength = expected?.values().next().value?.length ?? 40;
      if (!expected || !gitBlobIds(content, shaLength).some((id) => expected.has(id))) {
        husk.unverified.push(relPath);
      }
    }
  };
  await walk(root, '');
  return husk;
}

/** @param {HuskInspection} husk */
function huskRetainedReason(husk) {
  const sample = husk.unverified.slice(0, 3).join(', ');
  const more = husk.unverified.length > 3 ? ` and ${husk.unverified.length - 3} more` : '';
  return husk.truncated
    ? `Git metadata is missing and the folder is too large to verify (${sample}${more}). Review or move it before deleting this folder.`
    : `Git metadata is missing and ${husk.unverified.length} file(s) are not in any commit (${sample}${more}). Review or move them before deleting this folder.`;
}

/**
 * Delete exactly what inspection verified. Directories go with non-recursive
 * rmdir, so anything written after inspection makes removal fail and survives.
 * @param {HuskInspection} husk
 */
async function removeVerifiedHusk(husk) {
  for (const dep of husk.disposable) {
    // Dep links are unlinked, never followed: their targets are the real workspace deps.
    await fs.rm(dep, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
  for (const file of husk.files) await fs.rm(file, { force: true });
  for (const dir of husk.dirs) await fs.rmdir(dir);
  await fs.rmdir(husk.root);
}

/**
 * @param {{ boardId: string, includeIntegration?: boolean, protectDirty?: boolean, checkOnly?: boolean }} input
 */
export async function cleanupBoardWorktrees({ boardId, includeIntegration = false, protectDirty = false, checkOnly = false }) {
  if (typeof boardId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(boardId)) {
    return { ok: false, error: 'Invalid board id' };
  }
  const dir = getBoardWorktreesDir(boardId);
  if (!isPathUnderWorktreesRoot(dir)) {
    return { ok: false, error: 'refusing to clean path outside the worktrees root' };
  }
  let slots = [];
  try {
    slots = await fs.readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: true, removed: 0 };
    return { ok: false, error: `Could not inspect board worktrees: ${err.message}` };
  }
  let keptIntegration = false;
  /** @type {string[]} */
  const toRemove = [];
  for (const slot of slots) {
    if (!includeIntegration && slot === 'integration') {
      keptIntegration = true;
      continue;
    }
    toRemove.push(slot);
  }
  const layout = await readBoardRepos(boardId);
  if (layout) {
    if (protectDirty || checkOnly) {
      const dirtyWorktrees = [];
      for (const slot of toRemove) {
        const rows = await eachBoardRepo(layout, async () => {
          const cwd = getWorktreeSlotPath(boardId, slot);
          if (!(await pathExists(cwd))) return { ok: true };
          const result = await checkWorktreeDirty({ boardId, slotId: slot });
          return { ...result, path: cwd };
        });
        for (const [, row] of rows) if (!row.ok || row.dirty) dirtyWorktrees.push({ slot, path: row.path });
      }
      if (dirtyWorktrees.length) return { ok: false, dirtyWorktrees, error: `Preserve local changes in ${dirtyWorktrees.map(item => item.path).join(', ')} before cleanup.` };
      if (checkOnly) return { ok: true, removed: 0 };
    }
    let removed = 0;
    for (const slot of toRemove) {
      const result = await removeWorktree({ boardId, slotId: slot, protectDirty });
      if (!result.ok) return { ...result, removed };
      removed++;
    }
    await fs.rmdir(dir).catch(error => { if (!['ENOENT', 'ENOTEMPTY', 'EBUSY'].includes(error.code)) throw error; });
    return { ok: true, removed, keptIntegration };
  }
  if (protectDirty || checkOnly) {
    const dirtyWorktrees = [];
    const retainedWorktrees = [];
    const liveSlots = [];
    /** @type {Array<{ slot: string, husk: HuskInspection }>} */
    const huskSlots = [];
    /** @type {Promise<Map<string, Set<string>> | null> | undefined} */
    let committed;
    for (const slot of toRemove) {
      const wtPath = getWorktreeSlotPath(boardId, slot);
      if (!(await isWorktreeCheckout(wtPath))) {
        try {
          committed ??= loadCommittedBlobs(boardId);
          const husk = await inspectHusk(wtPath, committed);
          if (husk.unverified.length === 0) huskSlots.push({ slot, husk });
          else retainedWorktrees.push({ path: wtPath, reason: huskRetainedReason(husk) });
        } catch (err) {
          if (err.code !== 'ENOENT') retainedWorktrees.push({ path: wtPath, reason: `Could not inspect folder: ${err.message}` });
        }
        continue;
      }
      liveSlots.push(slot);
      const status = await git(['status', '--porcelain', '--untracked-files=all'], wtPath);
      if (!ok(status)) return { ok: false, error: `Could not inspect ${slot}: ${out(status)}` };
      if (status.stdout.trim()) dirtyWorktrees.push({ slot, path: wtPath });
    }
    if (dirtyWorktrees.length) {
      return { ok: false, dirtyWorktrees, error: `Uncommitted work in ${dirtyWorktrees.map((item) => item.path).join(', ')}. Commit or move these changes before cleaning up. Nothing was deleted.` };
    }
    if (checkOnly) return { ok: true, removed: 0, retainedWorktrees };
    // Git checks again at deletion time, protecting edits made after inspection.
    let removed = 0;
    for (const slot of liveSlots) {
      const result = await git(['worktree', 'remove', getWorktreeSlotPath(boardId, slot)]);
      if (!ok(result)) return { ok: false, removed, error: `Could not remove ${slot}: ${out(result)}` };
      removed += 1;
    }
    for (const { husk } of huskSlots) {
      try {
        await removeVerifiedHusk(husk);
        removed += 1;
      } catch (err) {
        if (err.code !== 'ENOENT') retainedWorktrees.push({ path: husk.root, reason: `Folder was kept: ${err.message}` });
      }
    }
    invalidateRegisteredWorktreeCache();
    return { ok: true, removed, retainedWorktrees };
  }
  const bulk = await removeWorktreeSlotsBulk({ boardId, slotIds: toRemove });
  for (const slot of bulk.failedSlots) {
    console.warn(`[worktree] ${boardId}/${slot} survived cleanup`);
  }
  if (!keptIntegration) {
    try {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
    }
  }
  return {
    ok: bulk.ok,
    removed: bulk.removed.length,
    keptIntegration,
    failedSlots: bulk.failedSlots,
  };
}

/** Delete only this board's local branches whose commits are in the workspace HEAD. */
export async function cleanupBoardBranches({ boardId }) {
  const layout = await readBoardRepos(boardId);
  if (layout) {
    await verifyBoardRepoSources(layout);
    const rows = await eachBoardRepo(layout, () => cleanupBoardBranches({ boardId }));
    return { ...repoResults(rows), retainedBranches: rows.flatMap(([id, row]) => (row.retainedBranches ?? []).map(value => ({ ...value, branch: `${id}: ${value.branch}` }))) };
  }
  if (typeof boardId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(boardId)) {
    return { ok: false, error: 'Invalid board id' };
  }
  const prefix = `refs/heads/minnow/board/${boardId}/`;
  const refs = await git(['for-each-ref', '--format=%(refname)', prefix]);
  if (!ok(refs)) return { ok: false, error: out(refs) };
  const removedBranches = [];
  const retainedBranches = [];
  for (const ref of parseNameOnly(refs.stdout).filter((name) => name.startsWith(prefix))) {
    const branch = ref.slice('refs/heads/'.length);
    const merged = await git(['merge-base', '--is-ancestor', ref, 'HEAD']);
    if (!ok(merged)) {
      retainedBranches.push({ branch, reason: 'Has commits not merged into the current workspace branch.' });
      continue;
    }
    // Keep Git's checked-out and merge protections, including other worktrees.
    const deleted = await git(['branch', '-d', '--', branch]);
    if (ok(deleted)) removedBranches.push(branch);
    else retainedBranches.push({ branch, reason: out(deleted) });
  }
  return { ok: true, removedBranches, retainedBranches };
}

/**
 * @param {{ boardId: string, baseRef?: string }} input
 */
export async function integrationStats({ boardId, baseRef }) {
  const layout = await readBoardRepos(boardId);
  if (layout) return aggregateBoardStats(await eachBoardRepo(layout, repo => integrationStats({ boardId, baseRef: repo.baseSha })));
  const intPath = getWorktreeSlotPath(boardId, 'integration');
  try {
    await fs.access(intPath);
  } catch {
    return { ok: false, error: 'integration worktree missing' };
  }
  const base = (baseRef && baseRef.trim()) || 'HEAD';
  const diff = await git(['diff', '--numstat', `${base}...HEAD`], intPath);
  if (!ok(diff)) return { ok: false, output: out(diff) };
  const parsed = parseGitNumstat(diff.stdout ?? '');

  const remote = await git(['remote', 'get-url', 'origin'], intPath);
  const hasRemote = ok(remote) && Boolean(`${remote.stdout ?? ''}`.trim());

  let hasGh = false;
  try {
    const gh = await runGh(['--version'], { cwd: intPath, timeout: 10_000 });
    hasGh = gh.code === 0;
  } catch {
    hasGh = false;
  }

  return {
    ok: true,
    additions: parsed.additions,
    deletions: parsed.deletions,
    fileCount: parsed.paths.length,
    hasRemote,
    hasGh,
  };
}

async function workspaceGitCapabilities(workspace) {
  const remote = await git(['remote', 'get-url', 'origin'], workspace);
  const hasRemote = ok(remote) && Boolean(`${remote.stdout ?? ''}`.trim());
  let hasGh = false;
  try {
    const gh = await runGh(['--version'], { cwd: workspace, timeout: 10_000 });
    hasGh = gh.code === 0;
  } catch {
    hasGh = false;
  }
  return { hasRemote, hasGh };
}

async function workspaceDirtyStats() {
  const workspace = getEffectiveWorkspaceRoot();
  const diff = await git(['diff', '--numstat', 'HEAD'], workspace);
  if (!ok(diff)) return { ok: false, output: out(diff) };
  const parsed = parseGitNumstat(diff.stdout ?? '');

  const status = await git(['status', '--porcelain'], workspace);
  const untracked = `${status.stdout ?? ''}`
    .split(/\r?\n/)
    .filter((line) => line.startsWith('?? ')).length;

  const current = await git(['branch', '--show-current'], workspace);
  const { hasRemote, hasGh } = await workspaceGitCapabilities(workspace);

  return {
    ok: true,
    additions: parsed.additions,
    deletions: parsed.deletions,
    fileCount: parsed.paths.length + untracked,
    untrackedCount: untracked,
    hasRemote,
    hasGh,
    alreadyLanded: false,
    dirtyWorkspace: true,
    currentBranch: `${current.stdout ?? ''}`.trim() || null,
  };
}

/**
 * @param {{ branch?: string }} input
 */
export async function workspaceLandingStats({ branch, targetRef } = {}) {
  const id = /^minnow\/board\/([\w-]+)\/integration$/.exec(branch ?? '')?.[1];
  const layout = id && await readBoardRepos(id);
  if (layout) return { ...aggregateBoardStats(await eachBoardRepo(layout, repo => workspaceLandingStats({ branch, targetRef: repo.baseBranch || repo.baseSha }))),
    multiRepo: true, baseBranches: Object.fromEntries(layout.repos.map(repo => [repo.id, repo.baseBranch])) };
  const workspace = getEffectiveWorkspaceRoot();
  const intBranch = (branch && branch.trim()) || '';
  if (!intBranch) return workspaceDirtyStats();
  if (!(await branchExists(intBranch))) {
    return { ok: false, error: 'integration branch not found' };
  }

  const current = await git(['branch', '--show-current'], workspace);
  const currentBranch = `${current.stdout ?? ''}`.trim() || null;

  const destination = targetRef || 'HEAD';
  const ancestor = await git(['merge-base', '--is-ancestor', intBranch, destination], workspace);
  const alreadyLanded = ancestor.code === 0;

  const diff = alreadyLanded
    ? targetRef ? { code: 0, stdout: '' } : await git(['diff', '--numstat'], workspace)
    : await git(['diff', '--numstat', `${destination}...${intBranch}`], workspace);
  if (!ok(diff)) return { ok: false, output: out(diff) };
  const parsed = parseGitNumstat(diff.stdout ?? '');

  const { hasRemote, hasGh } = await workspaceGitCapabilities(workspace);

  return {
    ok: true,
    additions: parsed.additions,
    deletions: parsed.deletions,
    fileCount: parsed.paths.length,
    hasRemote,
    hasGh,
    alreadyLanded,
    currentBranch,
  };
}

/**
 * @param {{ branch: string, message?: string, targetBranch?: string, createBranch?: boolean, baseRef?: string }} input
 */
export async function mergeIntegrationIntoWorkspace({ branch, message, targetBranch, createBranch = false, baseRef }) {
  const boardId = /^minnow\/board\/([\w-]+)\/integration$/.exec(branch ?? '')?.[1];
  const layout = boardId && await readBoardRepos(boardId);
  if (layout) {
    await verifyBoardRepoSources(layout);
    const { loadState } = await import('../orchestrator/journal.js');
    if ((await loadState(boardId)).status === 'running') return { ok: false, error: 'Stop the board before merging it into its source repositories.' };
    const rows = await eachBoardRepo(layout, async repo => {
      const destination = targetBranch || repo.baseBranch;
      if (!destination) return { ok: false, error: 'Select a base branch in this repository before landing the board.' };
      const alreadyMerged = await git(['merge-base', '--is-ancestor', branch, destination]);
      if (ok(alreadyMerged)) return { ok: true, alreadyUpToDate: true };
      return mergeIntegrationIntoWorkspace({ branch, message, targetBranch: destination, createBranch, baseRef: baseRef || repo.baseSha });
    });
    return { ...repoResults(rows), merged: rows.some(([, row]) => row.merged) };
  }
  const workspace = getEffectiveWorkspaceRoot();
  let createdBranch;
  const intBranch = (branch && branch.trim()) || '';
  if (!intBranch) return { ok: false, error: 'branch required' };
  if (!(await branchExists(intBranch))) {
    return { ok: false, error: 'integration branch not found' };
  }

  const mergeHead = await git(['rev-parse', '--verify', 'MERGE_HEAD'], workspace);
  if (mergeHead.code === 0) {
    return {
      ok: false,
      error: 'workspace_merge_in_progress',
      output: 'Resolve or abort the in-progress merge in your workspace first.',
    };
  }

  if (targetBranch !== undefined) {
    const target = typeof targetBranch === 'string' ? targetBranch.trim() : '';
    const valid = target && !target.startsWith('-')
      ? await git(['check-ref-format', `refs/heads/${target}`], workspace)
      : null;
    if (!valid || !ok(valid)) return { ok: false, error: 'Invalid destination branch name.' };
    const status = await git(['status', '--porcelain', '--', ...boardRepoPathspec()], workspace);
    if (!ok(status)) return { ok: false, output: out(status) };
    if (status.stdout.trim()) {
      return { ok: false, error: 'Commit or stash workspace changes before landing the board.' };
    }
    const exists = await git(['show-ref', '--verify', '--quiet', `refs/heads/${target}`], workspace);
    if (createBranch && exists.code === 0) return { ok: false, error: `Branch already exists: ${target}` };
    if (!createBranch && exists.code !== 0) return { ok: false, error: `Destination branch does not exist: ${target}` };
    const current = await git(['branch', '--show-current'], workspace);
    if (createBranch || current.stdout.trim() !== target) {
      const args = createBranch ? ['switch', '-c', target] : ['switch', target];
      if (createBranch && baseRef) {
        const resolved = await git(['rev-parse', '--verify', '--end-of-options', `${baseRef}^{commit}`], workspace);
        if (!ok(resolved)) return { ok: false, error: 'Starting branch no longer exists.', output: out(resolved) };
        args.push(resolved.stdout.trim());
      }
      const switched = await git(args, workspace);
      if (!ok(switched)) return { ok: false, error: 'Could not switch to the destination branch.', output: out(switched) };
      if (createBranch) createdBranch = target;
    }
  }

  const ancestor = await git(['merge-base', '--is-ancestor', intBranch, 'HEAD'], workspace);
  if (ancestor.code === 0) {
    return { ok: true, merged: false, alreadyUpToDate: true, ...(createdBranch ? { createdBranch } : {}) };
  }

  const mergeMsg = (message && message.trim()) || `Merge ${intBranch}`;
  const merge = await git(['merge', '--no-edit', intBranch, '-m', mergeMsg], workspace);
  if (!ok(merge)) {
    const conflict = await git(['rev-parse', '--verify', 'MERGE_HEAD'], workspace);
    return {
      ok: false,
      merged: false,
      conflict: conflict.code === 0,
      output: out(merge),
      error: conflict.code === 0 ? 'merge_conflict' : 'merge_failed',
      ...(createdBranch ? { createdBranch } : {}),
    };
  }
  return { ok: true, merged: true, output: out(merge), ...(createdBranch ? { createdBranch } : {}) };
}

/**
 * @param {{ title?: string, body?: string, baseBranch?: string }} input
 */
export async function openWorkspacePr({ title, body, baseBranch }) {
  const workspace = getEffectiveWorkspaceRoot();
  const branchResult = await git(['branch', '--show-current'], workspace);
  const branch = `${branchResult.stdout ?? ''}`.trim();
  if (!branch) {
    return { ok: false, error: 'detached_head', output: 'Checkout a branch before opening a PR.' };
  }

  let ghAvailable = false;
  try {
    const gh = await runGh(['--version'], { cwd: workspace, timeout: 10_000 });
    ghAvailable = gh.code === 0;
  } catch {
    ghAvailable = false;
  }
  if (!ghAvailable) {
    return { ok: false, error: 'gh_unavailable', output: 'GitHub CLI (gh) is not installed' };
  }

  const args = ['pr', 'create', '--head', branch];
  if (baseBranch && baseBranch.trim() !== branch) args.push('--base', baseBranch.trim());
  const titleText = (title && title.trim()) || `Orchestrate: ${branch}`;
  const bodyText = (body && body.trim()) || '';
  args.push('--title', titleText);
  if (bodyText) args.push('--body', bodyText);

  const r = await runGh(args, { cwd: workspace, timeout: 120_000 });
  const text = out(r);
  const urlMatch = text.match(/https?:\/\/\S+/);
  if (!ok(r)) return { ok: false, output: text, error: 'gh_failed' };
  return { ok: true, url: urlMatch?.[0], output: text };
}

/**
 * @param {{ boardId: string, message?: string }} input
 */
export async function commitIntegration({ boardId, message }) {
  return commitWorktree({ boardId, slotId: 'integration', message });
}

/**
 * @param {{ boardId: string, branch: string }} input
 */
export async function pushIntegration({ boardId, branch }) {
  const layout = await readBoardRepos(boardId);
  if (layout) {
    const revisions = await verifiedBoardRevision(layout, branch);
    const rows = await eachBoardRepo(layout, async repo => {
      const head = revisions.get(repo.id);
      const intPath = getWorktreeSlotPath(boardId, 'integration');
      const diff = await git(['diff', '--quiet', repo.baseSha, head], intPath);
      if (diff.code === 0) return { ok: true, unchanged: true };
      if (diff.code !== 1) return { ok: false, output: out(diff) };
      const push = await git(['push', 'origin', `${head}:refs/heads/${branch}`], intPath);
      return { ok: ok(push), pushed: ok(push), output: out(push) };
    });
    return { ...repoResults(rows), pushed: rows.some(([, row]) => row.pushed) };
  }
  const intPath = getWorktreeSlotPath(boardId, 'integration');
  try {
    await fs.access(intPath);
  } catch {
    return { ok: false, error: 'integration worktree missing' };
  }
  const remote = await git(['remote', 'get-url', 'origin'], intPath);
  if (!ok(remote) || !`${remote.stdout ?? ''}`.trim()) {
    return {
      ok: false,
      pushed: false,
      error: 'no_remote',
      output: 'No origin remote configured',
    };
  }
  const b = (branch && branch.trim()) || '';
  if (!b) return { ok: false, error: 'branch required' };
  const push = await git(['push', '-u', 'origin', b], intPath);
  if (!ok(push)) return { ok: false, pushed: false, output: out(push) };
  return { ok: true, pushed: true, output: out(push) };
}

/**
 * @param {{ boardId: string, branch: string, title?: string, body?: string }} input
 */
export async function openPr({ boardId, branch, title, body, baseBranch }) {
  const layout = await readBoardRepos(boardId);
  if (layout) {
    const pushed = await pushIntegration({ boardId, branch });
    if (!pushed.ok) return pushed;
    const rows = await eachBoardRepo(layout, repo => {
      if (pushed.repos[repo.id]?.unchanged) return { ok: true, unchanged: true };
      if (!repo.baseBranch) return { ok: false, error: 'A base branch is required to open a pull request.' };
      return openPr({ boardId, branch, title, body, baseBranch: repo.baseBranch });
    });
    return { ...repoResults(rows), urls: rows.flatMap(([repo, row]) => row.url ? [{ repo, url: row.url }] : []) };
  }
  const intPath = getWorktreeSlotPath(boardId, 'integration');
  try {
    await fs.access(intPath);
  } catch {
    return { ok: false, error: 'integration worktree missing' };
  }
  const b = (branch && branch.trim()) || '';
  if (!b) return { ok: false, error: 'branch required' };

  let ghAvailable = false;
  try {
    const gh = await runGh(['--version'], { cwd: intPath, timeout: 10_000 });
    ghAvailable = gh.code === 0;
  } catch {
    ghAvailable = false;
  }
  if (!ghAvailable) {
    return { ok: false, error: 'gh_unavailable', output: 'GitHub CLI (gh) is not installed' };
  }

  const args = ['pr', 'create', '--head', b];
  if (baseBranch && inBoardRepo()) {
    const existing = await runGh(['pr', 'list', '--head', b, '--base', baseBranch, '--state', 'open', '--json', 'url', '--limit', '1'], { cwd: intPath, timeout: 30_000 });
    if (!ok(existing)) return { ok: false, output: out(existing) };
    const url = JSON.parse(existing.stdout || '[]')[0]?.url;
    if (url) return { ok: true, url };
    args.push('--base', baseBranch);
  }
  const titleText = (title && title.trim()) || `Orchestrate: ${b}`;
  const bodyText = (body && body.trim()) || '';
  args.push('--title', titleText);
  if (bodyText) args.push('--body', bodyText);

  const r = await runGh(args, { cwd: intPath, timeout: 120_000 });
  const text = out(r);
  const urlMatch = text.match(/https?:\/\/\S+/);
  if (!ok(r)) return { ok: false, output: text, error: 'gh_failed' };
  return { ok: true, url: urlMatch?.[0], output: text };
}

async function verifiedBoardRevision(layout, branch) {
  const { boardId } = layout;
  if (branch !== `minnow/board/${boardId}/integration`) throw new Error('The branch does not belong to this board.');
  const { loadState } = await import('../orchestrator/journal.js');
  const state = await loadState(boardId);
  const head = await readIntegrationRef({ boardId });
  const branches = await readIntegrationRef({ boardId, ref: `refs/heads/${branch}` });
  const clean = await checkWorktreeDirty({ boardId, slotId: 'integration' });
  if (!state.finished || state.finalTest?.outcome !== 'pass' || Object.keys(state.recoveryHolds).length ||
    [...state.tasks.values()].some(task => task.waived || !task.mergedSha) ||
    state.finalTest.evidence?.integrationSha !== head || head !== branches || !clean.ok || clean.dirty) {
    throw new Error('Publishing requires a finished board with clean, verified integration checkouts.');
  }
  return boardRevisionRepos(head);
}

/**
 * `missing` lists registered worktrees whose folder is gone. Git reports those
 * as `prunable` only when unlocked; a locked one (Codex leaves `initializing`)
 * otherwise looks like a live checkout forever.
 */
export async function listWorktrees(cwd) {
  const r = await git(['worktree', 'list', '--porcelain'], cwd);
  if (!ok(r)) return { ok: false, output: out(r) };
  const paths = String(r.stdout ?? '').split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length).trim());
  const exists = await Promise.all(paths.map((p) => pathExists(p)));
  return { ok: true, output: out(r), missing: paths.filter((_, i) => !exists[i]) };
}

const automaticChatSetups = new Map();

/**
 * Install dependencies in a chat worktree — once per repo for a mirrored
 * (multi-repo) worktree, where the folder root holds no manifests of its own.
 * @param {string} wtPath
 * @param {{ signal?: AbortSignal, preferCachedNpm?: boolean }} [options]
 */
export async function refreshChatWorktreeDependencies(wtPath, options = {}) {
  const files = ECOSYSTEM_ENTRIES.flatMap(e => [...e.manifests, ...(e.lockfiles ?? [])]);
  const mirror = await readMirrorManifest(wtPath);
  if (!mirror) return refreshDependencies(wtPath, files, options);
  const ran = [];
  const failed = [];
  for (const repo of mirror.repos) {
    const result = await refreshDependencies(repo.worktreePath, files, options);
    ran.push(...result.ran.map((entry) => `${repo.id}: ${entry}`));
    failed.push(...result.failed.map((entry) => `${repo.id}: ${entry}`));
  }
  return { ran, failed };
}

/**
 * Copy local dotenv files into a chat worktree. A mirrored (multi-repo)
 * worktree copies from each repo into that repo's worktree: the workspace
 * folder holding them is not a repository, so git cannot list its files.
 * @param {string} wtPath
 * @param {{ signal?: AbortSignal }} [options]
 */
export async function prepareChatWorktreeEnvironment(wtPath, options = {}) {
  const mirror = await readMirrorManifest(wtPath);
  if (!mirror) return prepareWorktreeEnvironment(getEffectiveWorkspaceRoot(), wtPath, options);
  const copied = [], skipped = [], failed = [];
  for (const repo of mirror.repos) {
    const result = await prepareWorktreeEnvironment(repo.source, repo.worktreePath, options);
    const inRepo = (file) => (file ? `${repo.relPath}/${file}` : file);
    copied.push(...result.copied.map(inRepo));
    skipped.push(...result.skipped.map(inRepo));
    failed.push(...result.failed.map((item) => ({ file: inRepo(item.file), reason: `${repo.id}: ${item.reason}` })));
  }
  return { ok: failed.length === 0, copied, skipped, failed };
}

/** One-click setup. Coalesce repeated clicks and retain failed slots for retry. */
export function enableChatWorktree({ chatId, title, signal, onCheckout }) {
  signal?.throwIfAborted();
  if (typeof chatId !== 'string' || !chatId.trim()) {
    return Promise.resolve({ ok: false, error: 'chatId is required' });
  }
  const wtPath = getChatWorktreePath(chatId.trim());
  if (automaticChatSetups.has(wtPath)) return automaticChatSetups.get(wtPath);
  const pending = (async () => {
    let branch;
    const sources = await multiRepoSources(getEffectiveWorkspaceRoot());
    const mirror = await readMirrorManifest(wtPath);
    if (mirror) {
      branch = mirror.branch;
    } else if (sources && !(await pathExists(wtPath))) {
      const slug = slugifyGitRefName(typeof title === 'string' ? title : '', 'worktree').slice(0, 48).replace(/[./-]+$/, '') || 'worktree';
      const suffix = createHash('sha256').update(chatId).digest('hex').slice(0, 10);
      const stem = `minnow/${slug}-${suffix}`;
      branch = stem;
      for (let i = 2; await branchExistsInAny(sources, branch); i++) branch = `${stem}-${i}`;
      const created = await createChatWorktree({ chatId, branch, baseRef: 'HEAD', requireNewBranch: true, signal, prepareDependencies: false });
      if (!created.ok) return { ...created, error: created.error || created.output || 'Could not create worktree' };
    } else if (await pathExists(wtPath)) {
      const registered = await git(['worktree', 'list', '--porcelain'], undefined, { signal });
      const paths = (registered.stdout ?? '').split('\n').filter(line => line.startsWith('worktree '))
        .map(line => normalizeWorkspacePathKey(line.slice(9).trim()));
      if (!ok(registered) || !paths.includes(normalizeWorkspacePathKey(wtPath)) || !(await isWorktreeCheckout(wtPath))) {
        return { ok: false, error: 'The worktree folder exists but is not a registered checkout. Inspect it in Source Control before retrying.' };
      }
      const head = await git(['symbolic-ref', '--short', 'HEAD'], wtPath, { signal });
      if (!ok(head)) return { ok: false, error: 'The existing worktree has a detached HEAD. Select a branch in Source Control first.' };
      branch = head.stdout.trim();
    } else {
      if (!(await resolveRef('HEAD'))) {
        return { ok: false, error: 'Worktrees need a Git repository with at least one commit. Create the first commit in Source Control, then retry.' };
      }
      const slug = slugifyGitRefName(typeof title === 'string' ? title : '', 'worktree').slice(0, 48).replace(/[./-]+$/, '') || 'worktree';
      // Short stable numeric suffix keeps same-titled chats apart; UI titles
      // recognise and hide it (src/lib/worktree-title.ts, MIN-14).
      const digest = parseInt(createHash('sha256').update(chatId).digest('hex').slice(0, 8), 16);
      const suffix = String(digest % 1_000_000).padStart(6, '0');
      const stem = `minnow/${slug}-${suffix}`;
      branch = stem;
      for (let i = 2; await branchExists(branch); i++) branch = `${stem}-${i}`;
      const created = await createChatWorktree({ chatId, branch, baseRef: 'HEAD', signal, prepareDependencies: false });
      if (!created.ok) return { ...created, error: created.error || created.output || 'Could not create worktree' };
    }
    signal?.throwIfAborted();
    // Canonical chats durably bind the allocated checkout before installers run.
    await onCheckout?.({ path: wtPath, branch });
    signal?.throwIfAborted();
    const environment = await prepareChatWorktreeEnvironment(wtPath, { signal });
    if (!environment.ok) return { ok: false, path: wtPath, branch, environment,
      error: `Worktree kept. Local environment setup failed: ${environment.failed.map(item => item.reason).join(' ')} Retry setup after repair.` };
    const preparation = await queueAutomaticChatInstall(
      () => refreshChatWorktreeDependencies(wtPath, { signal, preferCachedNpm: true }), signal);
    signal?.throwIfAborted();
    if (preparation.failed.length) {
      return { ok: false, path: wtPath, branch, ...preparation, error: `Worktree kept. Setup failed: ${preparation.failed.join(', ')}. Retry Enable worktree after fixing the dependency error.` };
    }
    return { ok: true, path: wtPath, branch, ...preparation };
  })().finally(() => automaticChatSetups.delete(wtPath));
  automaticChatSetups.set(wtPath, pending);
  return pending;
}

/**
 * @param {{ chatId: string, branch: string, baseRef?: string, checkoutExisting?: boolean, requireNewBranch?: boolean, signal?: AbortSignal, prepareDependencies?: boolean }} input
 */
export async function createChatWorktree({ chatId, branch, baseRef, checkoutExisting, requireNewBranch = false, signal, prepareDependencies = true }) {
  signal?.throwIfAborted();
  if (!chatId || typeof chatId !== 'string' || !chatId.trim()) {
    return { ok: false, error: 'chatId is required' };
  }
  if (!branch || typeof branch !== 'string' || !branch.trim()) {
    return { ok: false, error: 'branch is required' };
  }

  const wtPath = getChatWorktreePath(chatId.trim());
  const checkout = Boolean(checkoutExisting);
  const branchName = checkout ? branch.trim() : slugifyGitRefName(branch, 'worktree');
  const base = (baseRef && baseRef.trim()) || 'HEAD';
  const depSource = getEffectiveWorkspaceRoot();
  if (requireNewBranch && checkout) return { ok: false, error: 'A new owned checkout cannot attach an existing branch' };

  let exists = false;
  try {
    await fs.access(wtPath);
    exists = true;
  } catch {
  }

  if (exists) {
    if (requireNewBranch) return { ok: false, error: 'The owned worktree slot already exists; verify its allocation before reuse', path: wtPath, branch: branchName };
    const mirror = await readMirrorManifest(wtPath);
    if (mirror) {
      const repos = mirror.repos.map(({ id, worktreePath }) => ({ id, path: worktreePath }));
      if (prepareDependencies) {
        const environment = await prepareChatWorktreeEnvironment(wtPath, { signal });
        if (!environment.ok) return { ok: false, path: wtPath, branch: mirror.branch, repos, environment,
          error: `Worktree kept. ${environment.failed.map(item => item.reason).join(' ')}` };
      }
      return { ok: true, path: wtPath, branch: mirror.branch, created: false, repos };
    }
    if (!(await isWorktreeCheckout(wtPath))) return { ok: false, error: 'The managed worktree folder is not a valid checkout. Inspect it in Source Control.' };
    const head = await git(['symbolic-ref', '--short', 'HEAD'], wtPath);
    if (!ok(head)) return { ok: false, error: 'The existing worktree has a detached HEAD.' };
    if (prepareDependencies) {
      const environment = await prepareWorktreeEnvironment(depSource, wtPath, { signal });
      if (!environment.ok) return { ok: false, path: wtPath, branch: head.stdout.trim(), environment,
        error: `Worktree kept. ${environment.failed.map(item => item.reason).join(' ')}` };
    }
    return { ok: true, path: wtPath, branch: head.stdout.trim(), created: false };
  }

  await fs.mkdir(path.dirname(wtPath), { recursive: true });

  // A folder of repos gets one worktree per repo, laid out like the workspace.
  // Each repo branches from its own HEAD; git never runs in the parent folder.
  const sources = await multiRepoSources(depSource, { refresh: requireNewBranch });
  if (sources) {
    return createMirroredWorktree({
      wtPath,
      workspaceRoot: depSource,
      repos: sources,
      branch: branchName,
      signal,
      requireNewBranch,
      prepare: prepareDependencies ? (source, worktree) => prepareWorktreeDependencies(source, worktree, { signal }) : undefined,
    }).finally(() => invalidateRegisteredWorktreeCache());
  }

  if (checkout) {
    const added = await worktreeAdd({
      cwd: depSource,
      branch: branchName,
      path: wtPath,
      checkoutExisting: true,
    });
    if (!added.ok) {
      return {
        ok: false,
        path: wtPath,
        branch: branchName,
        error: added.error,
        output: added.error,
      };
    }
    const deps = prepareDependencies ? await prepareWorktreeDependencies(depSource, wtPath, { signal }) : undefined;
    invalidateRegisteredWorktreeCache();
    return {
      ok: deps?.ok !== false,
      path: wtPath,
      branch: added.branch ?? branchName,
      created: true,
      deps,
      ...(deps?.ok === false ? { error: `Worktree kept. Setup failed: ${depFailureOutput(deps)}` } : {}),
    };
  }

  const resolvedBase = signal ? await git(['rev-parse', '--verify', base], depSource, { signal }) : null;
  const baseSha = signal ? ok(resolvedBase) ? resolvedBase.stdout.trim().split(/\s/)[0] : null : await resolveRef(base);
  if (!baseSha) {
    return { ok: false, error: `invalid baseRef: ${base}`, path: wtPath, branch: branchName };
  }

  signal?.throwIfAborted();
  if (!requireNewBranch && await branchExists(branchName)) {
    const w = await git(['worktree', 'add', wtPath, branchName], depSource, { signal });
    if (!ok(w)) return { ok: false, path: wtPath, branch: branchName, output: out(w) };
    const deps = prepareDependencies ? await prepareWorktreeDependencies(depSource, wtPath, { signal }) : undefined;
    invalidateRegisteredWorktreeCache();
    return { ok: deps?.ok !== false, path: wtPath, branch: branchName, created: true, deps,
      ...(deps?.ok === false ? { error: `Worktree kept. Setup failed: ${depFailureOutput(deps)}` } : {}) };
  }

  const r = await git(['worktree', 'add', '-b', branchName, wtPath, baseSha], depSource, { signal });
  if (!ok(r)) return { ok: false, path: wtPath, branch: branchName, output: out(r) };
  signal?.throwIfAborted();
  const deps = prepareDependencies ? await prepareWorktreeDependencies(depSource, wtPath, { signal }) : undefined;
  signal?.throwIfAborted();
  invalidateRegisteredWorktreeCache();
  return { ok: deps?.ok !== false, path: wtPath, branch: branchName, created: true, deps,
    ...(deps?.ok === false ? { error: `Worktree kept. Setup failed: ${depFailureOutput(deps)}` } : {}) };
}

/**
 * @param {{ chatId: string }} input
 */
export async function removeChatWorktree({ chatId }) {
  if (!chatId || typeof chatId !== 'string' || !chatId.trim()) {
    return { ok: false, error: 'chatId is required' };
  }
  const wtPath = getChatWorktreePath(chatId.trim());
  if (!isPathUnderWorktreesRoot(wtPath)) {
    return { ok: false, error: 'refusing to remove path outside the worktrees root' };
  }
  try {
    await fs.access(wtPath);
  } catch {
    return { ok: true, path: wtPath, removed: false };
  }
  if (await readMirrorManifest(wtPath)) {
    const removed = await removeMirroredWorktree(wtPath);
    invalidateRegisteredWorktreeCache();
    return removed;
  }
  const r = await git(['worktree', 'remove', '--force', wtPath]);
  await git(['worktree', 'prune']);
  try {
    await fs.rm(wtPath, { recursive: true, force: true });
  } catch {
  }
  invalidateRegisteredWorktreeCache();
  return { ok: true, path: wtPath, removed: true, output: out(r) };
}

/**
 * @param {{ boardId: string, sinceSha?: string }} input
 */
export async function refreshIntegrationDeps({ boardId, sinceSha }) {
  const layout = await readBoardRepos(boardId);
  if (layout) {
    const bases = boardRevisionRepos(sinceSha);
    const rows = await eachBoardRepo(layout, repo => refreshIntegrationDeps({ boardId, sinceSha: bases?.get(repo.id) }));
    return repoResults(rows);
  }
  const intPath = getWorktreeSlotPath(boardId, 'integration');
  try {
    await fs.access(intPath);
  } catch {
    return { ok: false, error: 'integration worktree missing' };
  }
  const since = (sinceSha && sinceSha.trim()) || '';
  if (!since) return { ok: true, ran: [], skipped: 'no sinceSha' };
  const diff = await git(['diff', '--name-only', since, 'HEAD'], intPath);
  if (!ok(diff)) return { ok: false, output: out(diff) };
  const changedFiles = `${diff.stdout ?? ''}`
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const environment = await prepareWorktreeEnvironment(getEffectiveWorkspaceRoot(), intPath);
  if (!environment.ok) return { ok: false, error: 'environment', environment,
    output: environment.failed.map(item => item.reason).join(' ') };
  const { ran, failed } = await refreshDependencies(intPath, changedFiles);
  return { ok: true, ran, failed };
}
