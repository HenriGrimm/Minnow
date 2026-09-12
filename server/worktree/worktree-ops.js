import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runProcess } from '../process-runner.js';
import { parseGitNumstat } from '../tools/git-change-stats.js';
import { invalidateRegisteredWorktreeCache } from './allowlist.js';
import { slugifyGitRefName } from '../../src/lib/git-branch-slug.mjs';
import { expandGitmojiShortcodes } from '../../src/lib/gitmoji-shortcodes.mjs';
import { refreshDependencies } from './dep-install.js';
import { ECOSYSTEM_ENTRIES, ensureDependencyDirs, hasBrokenDepDir } from './dep-symlinks.js';
import {
  getBoardWorktreesDir,
  getChatWorktreePath,
  getWorktreeSlotPath,
  isPathUnderWorktreesRoot,
} from './paths.js';
import { getEffectiveWorkspaceRoot } from '../runtime/path-access.js';
import { worktreeAdd } from '../git/git-ops.js';

const GIT_TIMEOUT_MS = 120_000;

async function git(args, cwd = getEffectiveWorkspaceRoot()) {
  return runProcess('git', args, { cwd, timeout: GIT_TIMEOUT_MS });
}

const ok = (r) => r.code === 0;
const out = (r) => `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim();

const depFailureOutput = (deps) => deps.failed.map((f) => f.reason).join('; ');

/**
 * @param {string} wtPath
 * @param {string} intPath
 * @returns {Promise<{ ok: true, deps: { ok: boolean, linked: string[], repaired: string[], failed: Array<{ dir: string, reason: string }> } } | { ok: false, error: 'deps', deps: object, output: string }>}
 */
async function seedTaskWorktreeDeps(wtPath, intPath) {
  const workspace = getEffectiveWorkspaceRoot();
  const preferred = (await pathExists(intPath)) ? intPath : workspace;
  let deps = await ensureDependencyDirs(preferred, wtPath);
  if (!deps.ok && preferred !== workspace) {
    deps = await ensureDependencyDirs(workspace, wtPath);
  }
  if (await hasBrokenDepDir(wtPath)) {
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
async function isWorktreeCheckout(wtPath) {
  if (!(await pathExists(path.join(wtPath, '.git')))) return false;
  const r = await git(['rev-parse', '--is-inside-work-tree'], wtPath);
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
async function reclaimStaleWorktreeDir(wtPath) {
  if (!isPathUnderWorktreesRoot(wtPath)) {
    return { ok: false, output: 'refusing to reclaim a path outside the worktrees root' };
  }
  // Drop any stale registration still pointing here before reusing the path.
  await git(['worktree', 'prune', '--expire', 'now']);
  /** @type {string[]} */
  let entries = [];
  try {
    entries = await fs.readdir(wtPath);
  } catch {
    return { ok: true };
  }
  for (const entry of entries) {
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

async function branchExists(branch) {
  const r = await git(['rev-parse', '--verify', '--quiet', branch]);
  return r.code === 0;
}

/**
 * Drop a leftover attempt branch so the next `createWorktree` can `-b` from integration.
 * `git worktree remove` leaves the ref; a task-keyed slot would otherwise re-attach it.
 * @param {string} branch
 * @returns {Promise<{ ok: boolean, output: string }>}
 */
export async function deleteLocalBranch(branch) {
  const name = String(branch || '').trim();
  if (!name || name.includes('..') || name.includes('\0')) {
    return { ok: false, output: 'invalid branch name' };
  }
  const r = await git(['branch', '-D', name]);
  const text = out(r);
  // Missing refs are success: first allocate never created the branch.
  if (ok(r) || /not found/i.test(text)) return { ok: true, output: text };
  return { ok: false, output: text };
}

async function resolveRef(ref, cwd = getEffectiveWorkspaceRoot()) {
  const r = await git(['rev-parse', '--verify', ref], cwd);
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
  const key = boardId || '';
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
  return (activeIntegrationOps.get(boardId || '') ?? 0) > 0;
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
export async function ensureIntegration({ boardId, branch, baseRef }) {
  const base = (baseRef && baseRef.trim()) || 'HEAD';
  if (!(await branchExists(branch))) {
    const b = await git(['branch', branch, base]);
    if (!ok(b)) return { ok: false, stage: 'branch', output: out(b) };
  }
  const intPath = getWorktreeSlotPath(boardId, 'integration');
  if (await pathExists(intPath)) {
    const deps = await ensureDependencyDirs(getEffectiveWorkspaceRoot(), intPath);
    return { ok: true, path: intPath, branch, created: false, deps };
  }
  await fs.mkdir(path.dirname(intPath), { recursive: true });
  const w = await git(['worktree', 'add', intPath, branch]);
  if (!ok(w)) return { ok: false, stage: 'worktree', path: intPath, output: out(w) };
  const deps = await ensureDependencyDirs(getEffectiveWorkspaceRoot(), intPath);
  return { ok: true, path: intPath, branch, created: true, deps };
}

async function mergeBaseIntoWorktree(wtPath, baseRef) {
  const m = await git(['merge', baseRef, '--no-edit'], wtPath);
  if (ok(m)) return { ok: true, output: out(m) };
  await git(['merge', '--abort'], wtPath);
  return { ok: false, conflict: true, output: out(m) };
}

/**
 * @param {{ boardId: string, slotId: string, branch: string, baseRef?: string }} input
 */
export async function createWorktree({ boardId, slotId, branch, baseRef }) {
  const wtPath = getWorktreeSlotPath(boardId, slotId);
  const base = (baseRef && baseRef.trim()) || 'HEAD';
  const intPath = getWorktreeSlotPath(boardId, 'integration');

  let exists = await pathExists(wtPath);

  if (exists && !(await isWorktreeCheckout(wtPath))) {
    // Husk from a release whose `fs.rm` failed. Reclaim the path instead of
    // reusing it, or every later git call runs in a non-repo.
    const reclaimed = await reclaimStaleWorktreeDir(wtPath);
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
    const seeded = await seedTaskWorktreeDeps(wtPath, intPath);
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
    const synced = await mergeBaseIntoWorktree(wtPath, base);
    if (!synced.ok) {
      return {
        ok: false,
        conflict: synced.conflict,
        path: wtPath,
        branch,
        output: synced.output,
      };
    }
    return { ok: true, path: wtPath, branch, created: false, synced: true, deps: seeded.deps };
  }

  await fs.mkdir(path.dirname(wtPath), { recursive: true });
  const baseSha = await resolveRef(base);
  if (!baseSha) {
    return { ok: false, error: `invalid baseRef: ${base}`, path: wtPath, branch };
  }

  if (await branchExists(branch)) {
    const w = await git(['worktree', 'add', wtPath, branch]);
    if (!ok(w)) return { ok: false, path: wtPath, branch, output: out(w) };
    const seeded = await seedTaskWorktreeDeps(wtPath, intPath);
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
    const synced = await mergeBaseIntoWorktree(wtPath, base);
    if (!synced.ok) {
      return {
        ok: false,
        conflict: synced.conflict,
        path: wtPath,
        branch,
        output: synced.output,
      };
    }
    return { ok: true, path: wtPath, branch, created: true, deps: seeded.deps };
  }

  const r = await git(['worktree', 'add', '-b', branch, wtPath, baseSha]);
  if (!ok(r)) return { ok: false, path: wtPath, branch, output: out(r) };
  const seeded = await seedTaskWorktreeDeps(wtPath, intPath);
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
  return withBoardIntegrationLock(input.boardId, () => mergeIntoIntegrationUnlocked(input));
}

/** @param {{ boardId: string, fromBranch: string, message?: string }} input */
async function mergeIntoIntegrationUnlocked({ boardId, fromBranch, message }) {
  const intPath = getWorktreeSlotPath(boardId, 'integration');
  try {
    await fs.access(intPath);
  } catch {
    return { ok: false, error: 'integration worktree missing' };
  }
  const headBefore = await git(['rev-parse', 'HEAD'], intPath);
  const integrationSha = ok(headBefore) ? `${headBefore.stdout ?? ''}`.trim() : null;
  const args = ['merge', '--no-edit'];
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
  return withBoardIntegrationLock(input.boardId, () => rebaseOntoIntegrationUnlocked(input));
}

/** @param {{ boardId: string, slotId: string }} input */
async function rebaseOntoIntegrationUnlocked({ boardId, slotId }) {
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
 * @param {{ boardId: string, slotId: string, message?: string }} input
 */
export async function commitWorktree({ boardId, slotId, message }) {
  const wtPath = getWorktreeSlotPath(boardId, slotId);
  try {
    await fs.access(wtPath);
  } catch {
    return { ok: false, error: 'worktree missing' };
  }
  const add = await git(['add', '-A'], wtPath);
  if (!ok(add)) return { ok: false, output: out(add) };
  const staged = await git(['diff', '--cached', '--quiet'], wtPath);
  if (staged.code === 0) {
    return { ok: true, committed: false };
  }
  const commitMsg = expandGitmojiShortcodes((message && message.trim()) || 'Board task commit');
  const commit = await git(['commit', '-m', commitMsg], wtPath);
  if (!ok(commit)) return { ok: false, output: out(commit) };
  return { ok: true, committed: true, output: out(commit) };
}

/**
 * @param {{ boardId: string, slotId: string }} input
 */
export async function checkWorktreeDirty({ boardId, slotId }) {
  const wtPath = getWorktreeSlotPath(boardId, slotId);
  try {
    await fs.access(wtPath);
  } catch {
    return { ok: false, error: 'worktree missing' };
  }
  const status = await git(['status', '--porcelain'], wtPath);
  const files = `${status.stdout ?? ''}${status.stderr ?? ''}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return { ok: true, dirty: files.length > 0, files };
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
  return withBoardIntegrationLock(input.boardId, () => restoreIntegrationUnlocked(input));
}

/** @param {{ boardId: string, sha: string }} input */
async function restoreIntegrationUnlocked({ boardId, sha }) {
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
  await git(['clean', '-fd'], intPath);
  return { ok: true, sha: resolved, output: out(reset) };
}

/**
 * @param {{ boardId: string, fromBranch: string }} input
 */
export async function verifyIntegrationMerge({ boardId, fromBranch }) {
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
export async function removeWorktree({ boardId, slotId }) {
  const wtPath = getWorktreeSlotPath(boardId, slotId);
  if (!isPathUnderWorktreesRoot(wtPath)) {
    return { ok: false, error: 'refusing to remove path outside the worktrees root' };
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
    const gh = await runProcess('gh', ['--version'], { cwd: intPath, timeout: 10_000 });
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
    const gh = await runProcess('gh', ['--version'], { cwd: workspace, timeout: 10_000 });
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
export async function workspaceLandingStats({ branch } = {}) {
  const workspace = getEffectiveWorkspaceRoot();
  const intBranch = (branch && branch.trim()) || '';
  if (!intBranch) return workspaceDirtyStats();
  if (!(await branchExists(intBranch))) {
    return { ok: false, error: 'integration branch not found' };
  }

  const current = await git(['branch', '--show-current'], workspace);
  const currentBranch = `${current.stdout ?? ''}`.trim() || null;

  const ancestor = await git(['merge-base', '--is-ancestor', intBranch, 'HEAD'], workspace);
  const alreadyLanded = ancestor.code === 0;

  const diff = alreadyLanded
    ? await git(['diff', '--numstat'], workspace)
    : await git(['diff', '--numstat', `HEAD...${intBranch}`], workspace);
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
 * @param {{ branch: string, message?: string }} input
 */
export async function mergeIntegrationIntoWorkspace({ branch, message }) {
  const workspace = getEffectiveWorkspaceRoot();
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

  const ancestor = await git(['merge-base', '--is-ancestor', intBranch, 'HEAD'], workspace);
  if (ancestor.code === 0) {
    return { ok: true, merged: false, alreadyUpToDate: true };
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
    };
  }
  return { ok: true, merged: true, output: out(merge) };
}

/**
 * @param {{ title?: string, body?: string }} input
 */
export async function openWorkspacePr({ title, body }) {
  const workspace = getEffectiveWorkspaceRoot();
  const branchResult = await git(['branch', '--show-current'], workspace);
  const branch = `${branchResult.stdout ?? ''}`.trim();
  if (!branch) {
    return { ok: false, error: 'detached_head', output: 'Checkout a branch before opening a PR.' };
  }

  let ghAvailable = false;
  try {
    const gh = await runProcess('gh', ['--version'], { cwd: workspace, timeout: 10_000 });
    ghAvailable = gh.code === 0;
  } catch {
    ghAvailable = false;
  }
  if (!ghAvailable) {
    return { ok: false, error: 'gh_unavailable', output: 'GitHub CLI (gh) is not installed' };
  }

  const args = ['pr', 'create', '--head', branch];
  const titleText = (title && title.trim()) || `Orchestrate: ${branch}`;
  const bodyText = (body && body.trim()) || '';
  args.push('--title', titleText);
  if (bodyText) args.push('--body', bodyText);

  const r = await runProcess('gh', args, { cwd: workspace, timeout: 120_000 });
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
export async function openPr({ boardId, branch, title, body }) {
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
    const gh = await runProcess('gh', ['--version'], { cwd: intPath, timeout: 10_000 });
    ghAvailable = gh.code === 0;
  } catch {
    ghAvailable = false;
  }
  if (!ghAvailable) {
    return { ok: false, error: 'gh_unavailable', output: 'GitHub CLI (gh) is not installed' };
  }

  const args = ['pr', 'create', '--head', b];
  const titleText = (title && title.trim()) || `Orchestrate: ${b}`;
  const bodyText = (body && body.trim()) || '';
  args.push('--title', titleText);
  if (bodyText) args.push('--body', bodyText);

  const r = await runProcess('gh', args, { cwd: intPath, timeout: 120_000 });
  const text = out(r);
  const urlMatch = text.match(/https?:\/\/\S+/);
  if (!ok(r)) return { ok: false, output: text, error: 'gh_failed' };
  return { ok: true, url: urlMatch?.[0], output: text };
}

export async function listWorktrees() {
  const r = await git(['worktree', 'list', '--porcelain']);
  return { ok: ok(r), output: out(r) };
}

/**
 * @param {{ chatId: string, branch: string, baseRef?: string, checkoutExisting?: boolean }} input
 */
export async function createChatWorktree({ chatId, branch, baseRef, checkoutExisting }) {
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

  let exists = false;
  try {
    await fs.access(wtPath);
    exists = true;
  } catch {
  }

  if (exists) {
    return { ok: true, path: wtPath, branch: branchName, created: false };
  }

  await fs.mkdir(path.dirname(wtPath), { recursive: true });

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
    const deps = await ensureDependencyDirs(depSource, wtPath);
    invalidateRegisteredWorktreeCache();
    return {
      ok: true,
      path: wtPath,
      branch: added.branch ?? branchName,
      created: true,
      deps,
    };
  }

  const baseSha = await resolveRef(base);
  if (!baseSha) {
    return { ok: false, error: `invalid baseRef: ${base}`, path: wtPath, branch: branchName };
  }

  if (await branchExists(branchName)) {
    const w = await git(['worktree', 'add', wtPath, branchName]);
    if (!ok(w)) return { ok: false, path: wtPath, branch: branchName, output: out(w) };
    const deps = await ensureDependencyDirs(depSource, wtPath);
    invalidateRegisteredWorktreeCache();
    return { ok: true, path: wtPath, branch: branchName, created: true, deps };
  }

  const r = await git(['worktree', 'add', '-b', branchName, wtPath, baseSha]);
  if (!ok(r)) return { ok: false, path: wtPath, branch: branchName, output: out(r) };
  const deps = await ensureDependencyDirs(depSource, wtPath);
  invalidateRegisteredWorktreeCache();
  return { ok: true, path: wtPath, branch: branchName, created: true, deps };
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
  const { ran, failed } = await refreshDependencies(intPath, changedFiles);
  return { ok: true, ran, failed };
}
