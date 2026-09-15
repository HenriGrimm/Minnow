import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runProcess } from '../process-runner.js';
import { isGitRepository } from '../tools/git-change-stats.js';
import { invalidateRegisteredWorktreeCache } from '../worktree/allowlist.js';
import { normalizeWorkspacePathKey } from '../workspace/root.js';
import {
  gitRefFolderName,
  slugifyGitRefName,
} from '../../src/lib/git-branch-slug.mjs';
import { expandGitmojiShortcodes } from '../../src/lib/gitmoji-shortcodes.mjs';
import { getEffectiveWorkspaceRoot } from '../runtime/path-access.js';

const GIT_TIMEOUT_MS = 120_000;

function resolveCwd(cwd) {
  return cwd && String(cwd).trim() ? String(cwd).trim() : getEffectiveWorkspaceRoot();
}

async function git(args, cwd, env) {
  return runProcess('git', args, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    ...(env && typeof env === 'object' ? { env } : {}),
  });
}

function processError(result) {
  const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
  return text || `git exited with code ${result.code}`;
}

async function requireGitRepo(cwd) {
  const root = resolveCwd(cwd);
  if (!(await isGitRepository(root))) {
    return { ok: false, error: 'Not a git repository' };
  }
  return { ok: true, cwd: root };
}

/**
 * @param {string} text
 */
export function parsePorcelainStatus(text) {
  const staged = [];
  const unstaged = [];
  const untracked = [];
  let branch = '';
  let ahead = 0;
  let behind = 0;

  for (const rawLine of String(text ?? '').split('\n')) {
    const line = rawLine.trimEnd();
    if (!line) continue;

    if (line.startsWith('##')) {
      const header = line.slice(3).trim();
      const branchPart = header.split('...')[0]?.trim() ?? '';
      branch =
        branchPart === 'HEAD (no branch)' || branchPart.startsWith('HEAD (')
          ? 'HEAD'
          : branchPart;

      const bracket = header.match(/\[(.+)\]/);
      if (bracket) {
        const aheadMatch = bracket[1].match(/ahead\s+(\d+)/);
        const behindMatch = bracket[1].match(/behind\s+(\d+)/);
        ahead = aheadMatch ? Number(aheadMatch[1]) : 0;
        behind = behindMatch ? Number(behindMatch[1]) : 0;
      }
      continue;
    }

    const x = line[0] ?? ' ';
    const y = line[1] ?? ' ';
    let path = line.slice(3);
    let status = y !== ' ' ? y : x;

    if (x === '?' && y === '?') {
      untracked.push({ path, status: '?' });
      continue;
    }

    if (x === 'R' || y === 'R' || x === 'C' || y === 'C') {
      status = 'R';
      const arrow = path.indexOf(' -> ');
      if (arrow !== -1) {
        path = path.slice(arrow + 4);
      }
    }

    const entry = { path, status };

    if (x !== ' ' && x !== '?') {
      staged.push(entry);
    }
    if (y !== ' ' && y !== '?') {
      unstaged.push(entry);
    }
  }

  return { branch, ahead, behind, staged, unstaged, untracked };
}

/**
 * @param {string} text
 */
export function parseBranchList(text) {
  let current = '';
  const local = [];
  const lockedLocal = [];
  const remote = [];

  for (const rawLine of String(text ?? '').split('\n')) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    const isCurrent = line.startsWith('* ');
    const checkedOutElsewhere = line.startsWith('+ ');
    const name = line.slice(2).trim();
    if (!name) continue;
    if (isCurrent) {
      current = name;
    }
    if (name.startsWith('remotes/')) {
      remote.push(name);
    } else if (checkedOutElsewhere) {
      lockedLocal.push(name);
    } else {
      local.push(name);
    }
  }

  return { current, local, lockedLocal, remote };
}

export function isMinnowBoardBranch(name) {
  return typeof name === 'string' && name.startsWith('minnow/board/');
}

/**
 * @param {string} porcelain
 * @param {string} mainRepoRoot
 */
export function parseWorktreeLockedBranches(porcelain, mainRepoRoot) {
  const locked = new Set();
  const norm = (p) =>
    String(p ?? '')
      .replace(/\\/g, '/')
      .replace(/\/+$/, '')
      .toLowerCase();
  const main = norm(mainRepoRoot);
  let currentPath = '';

  for (const rawLine of String(porcelain ?? '').split('\n')) {
    const line = rawLine.trimEnd();
    if (line.startsWith('worktree ')) {
      currentPath = line.slice('worktree '.length);
      continue;
    }
    if (!line.startsWith('branch ') || !currentPath) continue;
    const branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    if (norm(currentPath) !== main) {
      locked.add(branch);
    }
  }

  return locked;
}

/**
 * Checkout pickers: drop refs already used in another worktree.
 * Board branches (`minnow/board/…`) stay listed once unlocked (MIN-789).
 * @param {string[]} local
 * @param {Set<string>} [lockedElsewhere]
 */
export function filterUserFacingBranches(local, lockedElsewhere = new Set()) {
  return local.filter((b) => !lockedElsewhere.has(b));
}

/**
 * @param {string} line
 */
const LOG_RELATIVE_TIME =
  /^(.*) (\d+ seconds? ago|\d+ minutes? ago|\d+ hours? ago|\d+ days? ago|\d+ weeks? ago|\d+ months? ago|\d+ years? ago|just now)(?:\s+(.+))?\s*$/i;

function splitLogRefList(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return [];
  const inner =
    trimmed.startsWith('(') && trimmed.endsWith(')') ? trimmed.slice(1, -1) : trimmed;
  return inner
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean);
}

const LOG_FIELD_SEP = '\u001f';

export function parseLogLine(line) {
  const trimmed = String(line ?? '').trimEnd();
  if (!trimmed || trimmed.length < 42) return null;

  if (trimmed.includes(LOG_FIELD_SEP)) {
    const [hash, parentsField, subject, author, relativeTime, refsField] =
      trimmed.split(LOG_FIELD_SEP);
    if (!/^[0-9a-f]{40}$/.test(hash ?? '')) return null;
    return {
      hash,
      parents: (parentsField ?? '').split(' ').filter(Boolean),
      subject: (subject ?? '').trim(),
      author: (author ?? '').trim(),
      relativeTime: (relativeTime ?? '').trim(),
      refs: splitLogRefList(refsField ?? ''),
    };
  }

  const hash = trimmed.slice(0, 40);
  if (!/^[0-9a-f]{40}$/.test(hash)) return null;

  let pos = 41;
  const parents = [];
  while (pos < trimmed.length) {
    const slice = trimmed.slice(pos);
    const match = slice.match(/^([0-9a-f]{40})( |$)/);
    if (!match) break;
    parents.push(match[1]);
    pos += 40;
    if (match[2] === ' ') pos += 1;
  }

  let remainder = trimmed.slice(pos).trimStart();
  let refs = [];
  let relativeTime = '';

  const timeDecorMatch = remainder.match(LOG_RELATIVE_TIME);
  if (timeDecorMatch) {
    relativeTime = timeDecorMatch[2];
    remainder = timeDecorMatch[1];
    if (timeDecorMatch[3]) {
      refs = splitLogRefList(timeDecorMatch[3]);
    }
  } else {
    const parenRefMatch = remainder.match(/^(.*) (\([^)]+\))\s*$/);
    if (parenRefMatch) {
      refs = splitLogRefList(parenRefMatch[2]);
      remainder = parenRefMatch[1];
    } else {
      const headRefMatch = remainder.match(/^(.*) (HEAD -> .+)\s*$/);
      if (headRefMatch) {
        refs = splitLogRefList(headRefMatch[2]);
        remainder = headRefMatch[1];
      }
    }
  }

  const lastSpace = remainder.lastIndexOf(' ');
  let author = '';
  let subject = remainder;
  if (lastSpace !== -1) {
    author = remainder.slice(lastSpace + 1);
    subject = remainder.slice(0, lastSpace);
  }

  return { hash, parents, subject, author, relativeTime, refs };
}

/**
 * @param {string} text
 */
export function splitShowOutput(text) {
  const raw = String(text ?? '');
  const diffIdx = raw.search(/^diff --git /m);
  if (diffIdx === -1) {
    return { stat: raw.trimEnd(), patch: '' };
  }
  const before = raw.slice(0, diffIdx).trimEnd();
  const patch = raw.slice(diffIdx).trimEnd();
  const statLines = before.split('\n');
  const statStart = statLines.findIndex((l) => /\d+ files? changed/.test(l));
  const stat = statStart === -1 ? before : statLines.slice(statStart).join('\n');
  return { stat, patch };
}

export async function status({ cwd } = {}) {
  const repo = await requireGitRepo(cwd);
  if (!repo.ok) return repo;

  const result = await git(['status', '--porcelain=v1', '-b'], repo.cwd);
  if (result.code !== 0) {
    return { ok: false, error: processError(result) };
  }

  const parsed = parsePorcelainStatus(result.stdout);
  return { ok: true, ...parsed };
}

async function diffWorkingTree(repoCwd) {
  const parts = [];

  const unstaged = await git(['diff'], repoCwd);
  if (unstaged.code !== 0) {
    return { ok: false, error: processError(unstaged) };
  }
  if (unstaged.stdout?.trim()) parts.push(unstaged.stdout.trimEnd());

  const statusResult = await git(['status', '--porcelain=v1'], repoCwd);
  if (statusResult.code !== 0) {
    return { ok: false, error: processError(statusResult) };
  }

  const nullDev = process.platform === 'win32' ? 'NUL' : '/dev/null';
  for (const line of (statusResult.stdout ?? '').split('\n')) {
    if (!line.startsWith('?? ')) continue;
    const filePath = line.slice(3).trim();
    if (!filePath) continue;
    const untracked = await git(['diff', '--no-index', '--', nullDev, filePath], repoCwd);
    if (untracked.stdout?.trim()) parts.push(untracked.stdout.trimEnd());
  }

  return { ok: true, patch: parts.join('\n\n') };
}

export async function diff({ cwd, cached, path: filePath, workingTree } = {}) {
  const repo = await requireGitRepo(cwd);
  if (!repo.ok) return repo;

  if (workingTree) {
    return diffWorkingTree(repo.cwd);
  }

  const args = ['diff'];
  if (cached) args.push('--cached');
  if (filePath) args.push('--', String(filePath));

  const result = await git(args, repo.cwd);
  if (result.code !== 0) {
    return { ok: false, error: processError(result) };
  }

  return { ok: true, patch: result.stdout ?? '' };
}

async function partitionStageablePaths(paths, cwd) {
  const listed = await git(['ls-files', '-z', '--', ...paths], cwd);
  const tracked = new Set(
    listed.code === 0
      ? (listed.stdout ?? '').split('\0').filter(Boolean).map((p) => p.replace(/\\/g, '/'))
      : paths.map((p) => p.replace(/\\/g, '/')),
  );

  const stageable = [];
  const skipped = [];
  for (const rel of paths) {
    if (tracked.has(rel.replace(/\\/g, '/'))) {
      stageable.push(rel);
      continue;
    }
    try {
      await fs.access(path.resolve(cwd, rel));
      stageable.push(rel);
    } catch {
      skipped.push(rel);
    }
  }
  return { stageable, skipped };
}

export async function stage({ cwd, paths } = {}) {
  const repo = await requireGitRepo(cwd);
  if (!repo.ok) return repo;

  if (!Array.isArray(paths) || paths.length === 0) {
    return { ok: false, error: 'paths array is required' };
  }

  const requested = paths.map(String);
  const { stageable, skipped } = await partitionStageablePaths(requested, repo.cwd);

  if (stageable.length === 0) {
    return { ok: true, stagedPaths: [], skippedPaths: skipped };
  }

  const result = await git(['add', ...stageable], repo.cwd);
  if (result.code !== 0) {
    return { ok: false, error: processError(result) };
  }

  return { ok: true, stagedPaths: stageable, skippedPaths: skipped };
}

export async function stageAll({ cwd } = {}) {
  const repo = await requireGitRepo(cwd);
  if (!repo.ok) return repo;

  const result = await git(['add', '-A'], repo.cwd);
  if (result.code !== 0) {
    return { ok: false, error: processError(result) };
  }

  return { ok: true };
}

export async function unstage({ cwd, paths } = {}) {
  const repo = await requireGitRepo(cwd);
  if (!repo.ok) return repo;

  if (!Array.isArray(paths) || paths.length === 0) {
    return { ok: false, error: 'paths array is required' };
  }

  const result = await git(['reset', 'HEAD', '--', ...paths.map(String)], repo.cwd);
  if (result.code !== 0) {
    return { ok: false, error: processError(result) };
  }

  return { ok: true };
}

export async function discard({ cwd, paths } = {}) {
  const repo = await requireGitRepo(cwd);
  if (!repo.ok) return repo;

  if (!Array.isArray(paths) || paths.length === 0) {
    return { ok: false, error: 'paths array is required' };
  }

  const result = await git(['checkout', '--', ...paths.map(String)], repo.cwd);
  if (result.code !== 0) {
    return { ok: false, error: processError(result) };
  }

  return { ok: true };
}

export async function commit({ cwd, message } = {}) {
  const repo = await requireGitRepo(cwd);
  if (!repo.ok) return repo;

  if (!message || typeof message !== 'string' || !message.trim()) {
    return { ok: false, error: 'message is required' };
  }

  const cachedQuiet = await git(['diff', '--cached', '--quiet'], repo.cwd);
  if (cachedQuiet.code === 0) {
    const wtStatus = await git(['status', '--porcelain'], repo.cwd);
    if (!(wtStatus.stdout ?? '').trim()) {
      return { ok: false, error: 'nothing to commit, working tree clean' };
    }
    const addAll = await git(['add', '-A'], repo.cwd);
    if (addAll.code !== 0) {
      return { ok: false, error: processError(addAll) };
    }
  }

  const normalized = expandGitmojiShortcodes(message);

  const result = await git(['commit', '-m', normalized], repo.cwd);
  if (result.code !== 0) {
    return { ok: false, error: processError(result) };
  }

  const shaResult = await git(['rev-parse', 'HEAD'], repo.cwd);
  if (shaResult.code !== 0) {
    return { ok: false, error: processError(shaResult) };
  }

  return { ok: true, sha: (shaResult.stdout ?? '').trim() };
}

export async function push({ cwd, setUpstream, branch } = {}) {
  const repo = await requireGitRepo(cwd);
  if (!repo.ok) return repo;

  const args = ['push'];
  if (setUpstream) {
    if (!branch || typeof branch !== 'string' || !branch.trim()) {
      return { ok: false, error: 'branch is required when setUpstream is true' };
    }
    args.push('--set-upstream', 'origin', branch.trim());
  }

  const result = await git(args, repo.cwd);
  if (result.code !== 0) {
    return { ok: false, error: processError(result) };
  }

  return { ok: true, stdout: (result.stdout ?? '').trim() };
}

export async function pull({ cwd } = {}) {
  const repo = await requireGitRepo(cwd);
  if (!repo.ok) return repo;

  const result = await git(['pull'], repo.cwd);
  if (result.code !== 0) {
    return { ok: false, error: processError(result) };
  }

  return { ok: true, stdout: (result.stdout ?? '').trim() };
}

export async function fetch({ cwd } = {}) {
  const repo = await requireGitRepo(cwd);
  if (!repo.ok) return repo;

  const result = await git(['fetch', '--all'], repo.cwd);
  if (result.code !== 0) {
    return { ok: false, error: processError(result) };
  }

  return { ok: true };
}

export async function log({ cwd, count = 10 } = {}) {
  const repo = await requireGitRepo(cwd);
  if (!repo.ok) return repo;

  const n = Math.max(1, Math.min(Number(count) || 10, 200));
  const result = await git(
    [
      'log',
      '--topo-order',
      '--format=%H%x1f%P%x1f%s%x1f%an%x1f%ar%x1f%D',
      '--exclude=refs/stash',
      '--all',
      '-n',
      String(n),
    ],
    repo.cwd,
  );
  if (result.code !== 0) {
    return { ok: false, error: processError(result) };
  }

  const commits = String(result.stdout ?? '')
    .split('\n')
    .map((line) => parseLogLine(line))
    .filter(Boolean);

  return { ok: true, commits };
}

export async function branches({ cwd } = {}) {
  const repo = await requireGitRepo(cwd);
  if (!repo.ok) return repo;

  const rootResult = await git(['rev-parse', '--show-toplevel'], repo.cwd);
  const repoRoot = (rootResult.stdout ?? '').trim();

  const [branchResult, wtResult] = await Promise.all([
    git(['branch', '-a'], repo.cwd),
    git(['worktree', 'list', '--porcelain'], repo.cwd),
  ]);
  if (branchResult.code !== 0) {
    return { ok: false, error: processError(branchResult) };
  }

  const parsed = parseBranchList(branchResult.stdout);
  const lockedElsewhere =
    repoRoot && wtResult.code === 0
      ? parseWorktreeLockedBranches(wtResult.stdout ?? '', repoRoot)
      : new Set();
  parsed.local = filterUserFacingBranches(parsed.local, lockedElsewhere);

  return { ok: true, ...parsed };
}

export async function deleteRemoteBranch({ cwd, branch } = {}) {
  const repo = await requireGitRepo(cwd);
  if (!repo.ok) return repo;
  if (typeof branch !== 'string') return { ok: false, error: 'branch is required' };
  const name = branch.trim().replace(/^(?:refs\/)?remotes\//, '');
  const remotes = await git(['remote'], repo.cwd);
  const remote = (remotes.stdout ?? '').trim().split(/\r?\n/)
    .filter((value) => value && !value.startsWith('-') && name.startsWith(`${value}/`))
    .sort((a, b) => b.length - a.length)[0];
  if (!remote) return { ok: false, error: 'Unknown remote branch' };
  const shortName = name.slice(remote.length + 1);
  if (['main', 'master', 'HEAD'].includes(shortName)) {
    return { ok: false, error: 'Cannot delete a protected remote branch' };
  }
  const valid = await git(['check-ref-format', `refs/heads/${shortName}`], repo.cwd);
  if (valid.code !== 0) return { ok: false, error: 'Invalid remote branch name' };
  const exists = await git(['show-ref', '--verify', '--quiet', `refs/remotes/${name}`], repo.cwd);
  if (exists.code !== 0) return { ok: false, error: 'Remote-tracking branch not found; fetch to refresh branches' };
  const symbolic = await git(['symbolic-ref', '-q', `refs/remotes/${name}`], repo.cwd);
  if (symbolic.code === 0) return { ok: false, error: 'Cannot delete a symbolic remote ref' };
  const result = await git(['push', '--delete', remote, `refs/heads/${shortName}`], repo.cwd);
  return result.code === 0 ? { ok: true } : { ok: false, error: processError(result) };
}

export async function deleteBranch({ cwd, branch, force } = {}) {
  const repo = await requireGitRepo(cwd);
  if (!repo.ok) return repo;

  if (!branch || typeof branch !== 'string' || !branch.trim()) {
    return { ok: false, error: 'branch is required' };
  }

  const name = branch.trim();
  if (name === 'main' || name === 'master') {
    return { ok: false, error: 'Cannot delete the main or master branch' };
  }

  const currentResult = await git(['branch', '--show-current'], repo.cwd);
  if (currentResult.code === 0 && (currentResult.stdout ?? '').trim() === name) {
    return { ok: false, error: 'Cannot delete the current branch' };
  }

  const args = ['branch', force ? '-D' : '-d', name];
  const result = await git(args, repo.cwd);
  if (result.code !== 0) {
    return { ok: false, error: processError(result) };
  }

  return { ok: true };
}

/**
 * @param {string} repoCwd
 * @param {string} name
 * @returns {Promise<boolean>}
 */
async function localBranchExists(repoCwd, name) {
  const result = await git(['show-ref', '--verify', '--quiet', `refs/heads/${name}`], repoCwd);
  return result.code === 0;
}

/**
 * Map a UI/git ref to a remote-tracking name (`origin/foo`) when it exists.
 * Local `feature/foo` must not match this — only `refs/remotes/…`.
 * @param {string} repoCwd
 * @param {string} ref
 * @returns {Promise<{ remoteRef: string, shortName: string } | null>}
 */
async function resolveRemoteTrackingRef(repoCwd, ref) {
  const trimmed = String(ref ?? '').trim();
  if (!trimmed) return null;
  const display = trimmed.startsWith('remotes/') ? trimmed.slice('remotes/'.length) : trimmed;
  const candidates = [`refs/remotes/${display}`];
  if (display !== trimmed) candidates.push(`refs/remotes/${trimmed}`);
  for (const candidate of candidates) {
    const result = await git(['show-ref', '--verify', '--quiet', candidate], repoCwd);
    if (result.code !== 0) continue;
    const remoteRef = candidate.slice('refs/remotes/'.length);
    const slash = remoteRef.indexOf('/');
    const shortName = slash >= 0 ? remoteRef.slice(slash + 1) : remoteRef;
    if (!shortName) return null;
    return { remoteRef, shortName };
  }
  return null;
}

/**
 * Build `git worktree add` args. New branches use `-b`; checkout-existing attaches
 * a local ref or `--track -b` from a remote-tracking ref that has no local yet.
 * @param {string} repoCwd
 * @param {{ checkout: boolean, branchName: string, targetPath: string, baseRef?: string }} input
 * @returns {Promise<{ args: string[], checkoutName: string }>}
 */
async function buildWorktreeAddArgs(repoCwd, input) {
  const { checkout, branchName, targetPath, baseRef } = input;
  if (!checkout) {
    const args = ['worktree', 'add', '-b', branchName, targetPath];
    if (baseRef && String(baseRef).trim()) args.push(String(baseRef).trim());
    return { args, checkoutName: branchName };
  }

  const remote = await resolveRemoteTrackingRef(repoCwd, branchName);
  if (remote) {
    if (await localBranchExists(repoCwd, remote.shortName)) {
      return {
        args: ['worktree', 'add', targetPath, remote.shortName],
        checkoutName: remote.shortName,
      };
    }
    return {
      args: ['worktree', 'add', '--track', '-b', remote.shortName, targetPath, remote.remoteRef],
      checkoutName: remote.shortName,
    };
  }

  return {
    args: ['worktree', 'add', targetPath, branchName],
    checkoutName: branchName,
  };
}

export async function worktreeAdd({
  cwd,
  branch,
  path: worktreePath,
  baseRef,
  checkoutExisting,
} = {}) {
  const repo = await requireGitRepo(cwd);
  if (!repo.ok) return repo;

  if (!branch || typeof branch !== 'string' || !branch.trim()) {
    return { ok: false, error: 'branch is required' };
  }

  const checkout = Boolean(checkoutExisting);
  // Checkout-existing keeps the selected ref as-is so remotes are not slugified.
  const branchName = checkout ? branch.trim() : slugifyGitRefName(branch, 'worktree');
  const rootResult = await git(['rev-parse', '--show-toplevel'], repo.cwd);
  if (rootResult.code !== 0) {
    return { ok: false, error: processError(rootResult) };
  }
  const repoRoot = (rootResult.stdout ?? '').trim();

  const folderSource = checkout
    ? (await resolveRemoteTrackingRef(repo.cwd, branchName))?.shortName ?? branchName
    : branchName;
  const targetPath =
    typeof worktreePath === 'string' && worktreePath.trim()
      ? worktreePath.trim()
      : path.join(repoRoot, '.worktrees', gitRefFolderName(folderSource));

  const { args, checkoutName } = await buildWorktreeAddArgs(repo.cwd, {
    checkout,
    branchName,
    targetPath,
    baseRef,
  });

  let result = await git(args, repo.cwd);
  if (result.code !== 0 && checkout && args.includes('--track')) {
    // --track needs a configured remote; a bare refs/remotes/… ref still works with -b.
    const fallbackArgs = args.filter((part) => part !== '--track');
    result = await git(fallbackArgs, repo.cwd);
  }
  if (result.code !== 0) {
    return { ok: false, error: processError(result) };
  }

  invalidateRegisteredWorktreeCache();
  return { ok: true, path: targetPath, branch: checkoutName };
}

/**
 * @param {string} repoCwd
 * @returns {Promise<string | null>}
 */
async function resolveMainWorktreePath(repoCwd) {
  const result = await git(['worktree', 'list', '--porcelain'], repoCwd);
  if (result.code !== 0) return null;
  for (const rawLine of String(result.stdout ?? '').split('\n')) {
    const line = rawLine.trimEnd();
    if (line.startsWith('worktree ')) {
      return line.slice('worktree '.length).trim();
    }
  }
  return null;
}

export async function worktreeRemove({ cwd, path: worktreePath, force } = {}) {
  const repo = await requireGitRepo(cwd);
  if (!repo.ok) return repo;

  if (!worktreePath || typeof worktreePath !== 'string' || !worktreePath.trim()) {
    return { ok: false, error: 'path is required' };
  }

  const targetPath = worktreePath.trim();
  const mainWorktreePath = await resolveMainWorktreePath(repo.cwd);
  if (
    mainWorktreePath &&
    normalizeWorkspacePathKey(targetPath) === normalizeWorkspacePathKey(mainWorktreePath)
  ) {
    return { ok: false, error: 'Cannot remove the main worktree' };
  }

  const args = ['worktree', 'remove'];
  if (force) args.push('--force');
  args.push(targetPath);

  const gitCwd = mainWorktreePath ?? repo.cwd;
  const result = await git(args, gitCwd);
  if (result.code !== 0) {
    return { ok: false, error: processError(result) };
  }

  invalidateRegisteredWorktreeCache();
  return { ok: true };
}

export async function checkout({ cwd, branch, create, startPoint } = {}) {
  const repo = await requireGitRepo(cwd);
  if (!repo.ok) return repo;

  if (!branch || typeof branch !== 'string' || !branch.trim()) {
    return { ok: false, error: 'branch is required' };
  }

  const name = create ? slugifyGitRefName(branch, 'branch') : branch.trim();
  const args = create
    ? ['checkout', '-b', name]
    : ['checkout', name];
  if (create && startPoint && typeof startPoint === 'string' && startPoint.trim()) {
    args.push(startPoint.trim());
  }
  const result = await git(args, repo.cwd);
  if (result.code !== 0) {
    return { ok: false, error: processError(result) };
  }

  return { ok: true, branch: name };
}

export async function checkoutDetach({ cwd, sha } = {}) {
  const repo = await requireGitRepo(cwd);
  if (!repo.ok) return repo;

  if (!sha || typeof sha !== 'string' || !sha.trim()) {
    return { ok: false, error: 'sha is required' };
  }

  const result = await git(['checkout', '--detach', sha.trim()], repo.cwd);
  if (result.code !== 0) {
    return { ok: false, error: processError(result) };
  }

  return { ok: true };
}

export async function createTag({ cwd, name, sha } = {}) {
  const repo = await requireGitRepo(cwd);
  if (!repo.ok) return repo;

  if (!name || typeof name !== 'string' || !name.trim()) {
    return { ok: false, error: 'name is required' };
  }
  if (!sha || typeof sha !== 'string' || !sha.trim()) {
    return { ok: false, error: 'sha is required' };
  }

  const result = await git(['tag', name.trim(), sha.trim()], repo.cwd);
  if (result.code !== 0) {
    return { ok: false, error: processError(result) };
  }

  return { ok: true };
}

export async function remoteUrl({ cwd } = {}) {
  const repo = await requireGitRepo(cwd);
  if (!repo.ok) return repo;

  const result = await git(['remote', 'get-url', 'origin'], repo.cwd);
  if (result.code !== 0) {
    return { ok: false, error: processError(result) };
  }

  const url = (result.stdout ?? '').trim();
  if (!url) {
    return { ok: false, error: 'No origin remote configured' };
  }

  return { ok: true, url };
}

export async function show({ cwd, sha } = {}) {
  const repo = await requireGitRepo(cwd);
  if (!repo.ok) return repo;

  if (!sha || typeof sha !== 'string' || !sha.trim()) {
    return { ok: false, error: 'sha is required' };
  }

  const result = await git(['show', '--stat', '--patch', sha.trim()], repo.cwd);
  if (result.code !== 0) {
    return { ok: false, error: processError(result) };
  }

  const { stat, patch } = splitShowOutput(result.stdout);
  return { ok: true, patch, stat, stdout: result.stdout };
}

function isGitConflictOutput(text) {
  const lower = String(text ?? '').toLowerCase();
  return (
    lower.includes('conflict') ||
    lower.includes('fix conflicts') ||
    lower.includes('unmerged paths')
  );
}

export async function merge({ cwd, branch, noFf, abort } = {}) {
  const repo = await requireGitRepo(cwd);
  if (!repo.ok) return repo;

  if (abort) {
    const result = await git(['merge', '--abort'], repo.cwd);
    if (result.code !== 0) {
      return { ok: false, error: processError(result) };
    }
    return { ok: true, stdout: (result.stdout ?? '').trim() };
  }

  if (!branch || typeof branch !== 'string' || !branch.trim()) {
    return { ok: false, error: 'branch is required' };
  }

  const args = ['merge', branch.trim()];
  if (noFf) args.push('--no-ff');

  const result = await git(args, repo.cwd);
  if (result.code !== 0) {
    const err = processError(result);
    return { ok: false, error: err, conflict: isGitConflictOutput(err) };
  }

  return { ok: true, stdout: (result.stdout ?? '').trim() };
}

export async function rebase({ cwd, onto, abort, continue: cont } = {}) {
  const repo = await requireGitRepo(cwd);
  if (!repo.ok) return repo;

  const args = ['rebase'];
  if (abort) {
    args.push('--abort');
  } else if (cont) {
    args.push('--continue');
  } else {
    if (!onto || typeof onto !== 'string' || !onto.trim()) {
      return { ok: false, error: 'onto is required' };
    }
    args.push(onto.trim());
  }

  const result = await git(args, repo.cwd);
  if (result.code !== 0) {
    const err = processError(result);
    return { ok: false, error: err, conflict: isGitConflictOutput(err) };
  }

  return { ok: true, stdout: (result.stdout ?? '').trim() };
}

export async function stashList({ cwd } = {}) {
  const repo = await requireGitRepo(cwd);
  if (!repo.ok) return repo;

  const result = await git(['stash', 'list'], repo.cwd);
  if (result.code !== 0) {
    return { ok: false, error: processError(result) };
  }

  const entries = String(result.stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  return { ok: true, stashes: entries };
}

export async function stashPush({ cwd, message, paths } = {}) {
  const repo = await requireGitRepo(cwd);
  if (!repo.ok) return repo;

  const args = ['stash', 'push'];
  if (message && String(message).trim()) {
    args.push('-m', String(message).trim());
  }
  if (Array.isArray(paths) && paths.length > 0) {
    args.push('--', ...paths.map((p) => String(p)));
  }

  const result = await git(args, repo.cwd);
  if (result.code !== 0) {
    return { ok: false, error: processError(result) };
  }

  return { ok: true, stdout: (result.stdout ?? '').trim() };
}

export async function stashPop({ cwd, index } = {}) {
  const repo = await requireGitRepo(cwd);
  if (!repo.ok) return repo;

  const ref = typeof index === 'number' && index >= 0 ? `stash@{${index}}` : undefined;
  const args = ref ? ['stash', 'pop', ref] : ['stash', 'pop'];

  const result = await git(args, repo.cwd);
  if (result.code !== 0) {
    const err = processError(result);
    return { ok: false, error: err, conflict: isGitConflictOutput(err) };
  }

  return { ok: true, stdout: (result.stdout ?? '').trim() };
}

export async function stashApply({ cwd, index } = {}) {
  const repo = await requireGitRepo(cwd);
  if (!repo.ok) return repo;

  const ref = typeof index === 'number' && index >= 0 ? `stash@{${index}}` : undefined;
  const args = ref ? ['stash', 'apply', ref] : ['stash', 'apply'];

  const result = await git(args, repo.cwd);
  if (result.code !== 0) {
    const err = processError(result);
    return { ok: false, error: err, conflict: isGitConflictOutput(err) };
  }

  return { ok: true, stdout: (result.stdout ?? '').trim() };
}

export async function stashDrop({ cwd, index } = {}) {
  const repo = await requireGitRepo(cwd);
  if (!repo.ok) return repo;

  const ref = typeof index === 'number' && index >= 0 ? `stash@{${index}}` : undefined;
  const args = ref ? ['stash', 'drop', ref] : ['stash', 'drop'];

  const result = await git(args, repo.cwd);
  if (result.code !== 0) {
    return { ok: false, error: processError(result) };
  }

  return { ok: true };
}

export async function cherryPick({ cwd, sha, abort, continue: cont } = {}) {
  const repo = await requireGitRepo(cwd);
  if (!repo.ok) return repo;

  const args = ['cherry-pick'];
  if (abort) {
    args.push('--abort');
  } else if (cont) {
    args.push('--continue');
  } else {
    if (!sha || typeof sha !== 'string' || !sha.trim()) {
      return { ok: false, error: 'sha is required' };
    }
    args.push(sha.trim());
  }

  const result = await git(args, repo.cwd);
  if (result.code !== 0) {
    const err = processError(result);
    return { ok: false, error: err, conflict: isGitConflictOutput(err) };
  }

  return { ok: true, stdout: (result.stdout ?? '').trim() };
}

/**
 * @param {string} text
 */
export function parseNameStatus(text) {
  const files = [];
  for (const rawLine of String(text ?? '').split('\n')) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    const parts = line.split('\t');
    const statusRaw = (parts[0] ?? '').trim();
    if (!statusRaw) continue;
    const status = statusRaw[0] ?? statusRaw;
    const filePath =
      parts.length >= 3 ? String(parts[2] ?? '').trim() : String(parts[1] ?? '').trim();
    if (!filePath) continue;
    files.push({ status, path: filePath });
  }
  return files;
}

/**
 * @param {{ cwd?: string, message?: string }} [input]
 */
export async function snapshotCreate({ cwd, message } = {}) {
  const repo = await requireGitRepo(cwd);
  if (!repo.ok) return repo;

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-git-snap-'));
  const indexPath = path.join(tmpDir, 'index');
  const env = { GIT_INDEX_FILE: indexPath };

  try {
    const headResult = await git(['rev-parse', 'HEAD'], repo.cwd);
    const hasHead = headResult.code === 0;
    const headSha = hasHead ? (headResult.stdout ?? '').trim() : undefined;
    if (hasHead && !/^[0-9a-f]{40}$/i.test(headSha ?? '')) {
      return { ok: false, error: 'Could not resolve HEAD' };
    }

    if (hasHead) {
      const readTree = await git(['read-tree', 'HEAD'], repo.cwd, env);
      if (readTree.code !== 0) {
        return { ok: false, error: processError(readTree) };
      }
    }

    const add = await git(['add', '-A'], repo.cwd, env);
    if (add.code !== 0) {
      return { ok: false, error: processError(add) };
    }

    const writeTree = await git(['write-tree'], repo.cwd, env);
    if (writeTree.code !== 0) {
      return { ok: false, error: processError(writeTree) };
    }
    const treeSha = (writeTree.stdout ?? '').trim();
    if (!/^[0-9a-f]{40}$/i.test(treeSha)) {
      return { ok: false, error: 'write-tree did not return a tree sha' };
    }

    const msg =
      message && String(message).trim() ? String(message).trim() : 'minnow snapshot';
    const commitArgs = ['commit-tree', treeSha];
    if (hasHead && headSha) {
      commitArgs.push('-p', headSha);
    }
    commitArgs.push('-m', msg);
    const commitTree = await git(commitArgs, repo.cwd);
    if (commitTree.code !== 0) {
      return { ok: false, error: processError(commitTree) };
    }
    const sha = (commitTree.stdout ?? '').trim();
    if (!/^[0-9a-f]{40}$/i.test(sha)) {
      return { ok: false, error: 'commit-tree did not return a commit sha' };
    }

    return {
      ok: true,
      sha,
      ...(headSha ? { headSha } : {}),
      treeSha,
    };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * @param {{ cwd?: string, sha: string }} input
 */
export async function snapshotRestore({ cwd, sha } = {}) {
  const repo = await requireGitRepo(cwd);
  if (!repo.ok) return repo;

  const target = typeof sha === 'string' ? sha.trim() : '';
  if (!target) {
    return { ok: false, error: 'sha is required' };
  }

  const commitParse = await git(['rev-parse', '--verify', `${target}^{commit}`], repo.cwd);
  if (commitParse.code !== 0) {
    return { ok: false, error: processError(commitParse) || `invalid snapshot sha: ${target}` };
  }
  const resolved = (commitParse.stdout ?? '').trim();

  const treeParse = await git(['rev-parse', '--verify', `${resolved}^{tree}`], repo.cwd);
  if (treeParse.code !== 0) {
    return { ok: false, error: processError(treeParse) };
  }
  const treeSha = (treeParse.stdout ?? '').trim();

  const safety = await snapshotCreate({
    cwd: repo.cwd,
    message: 'minnow undo safety',
  });
  if (!safety.ok) {
    return { ok: false, error: safety.error || 'safety snapshot failed' };
  }

  const headBefore = await git(['rev-parse', 'HEAD'], repo.cwd);
  const headBeforeSha =
    headBefore.code === 0 ? (headBefore.stdout ?? '').trim() : undefined;

  const readTree = await git(['read-tree', '--reset', '-u', treeSha], repo.cwd);
  if (readTree.code !== 0) {
    return { ok: false, error: processError(readTree), safetySha: safety.sha };
  }

  const clean = await git(['clean', '-fd'], repo.cwd);
  if (clean.code !== 0) {
    return { ok: false, error: processError(clean), safetySha: safety.sha };
  }

  const headAfter = await git(['rev-parse', 'HEAD'], repo.cwd);
  const headAfterSha =
    headAfter.code === 0 ? (headAfter.stdout ?? '').trim() : undefined;
  if (headBeforeSha && headAfterSha && headBeforeSha !== headAfterSha) {
    return {
      ok: false,
      error: 'HEAD moved unexpectedly during snapshot restore',
      safetySha: safety.sha,
    };
  }

  return {
    ok: true,
    sha: resolved,
    safetySha: safety.sha,
    ...(headAfterSha ? { headSha: headAfterSha } : {}),
    treeSha,
  };
}

/**
 * @param {{ cwd?: string, fromSha: string, toSha?: string }} input
 */
export async function snapshotDiff({ cwd, fromSha, toSha } = {}) {
  const repo = await requireGitRepo(cwd);
  if (!repo.ok) return repo;

  const from = typeof fromSha === 'string' ? fromSha.trim() : '';
  if (!from) {
    return { ok: false, error: 'fromSha is required' };
  }

  const to = typeof toSha === 'string' ? toSha.trim() : '';
  const args = to
    ? ['diff', '--name-status', from, to]
    : ['diff', '--name-status', from];

  const result = await git(args, repo.cwd);
  if (result.code !== 0 && result.code !== 1) {
    return { ok: false, error: processError(result) };
  }

  const files = parseNameStatus(result.stdout ?? '');

  if (!to) {
    const others = await git(['ls-files', '--others', '--exclude-standard'], repo.cwd);
    if (others.code === 0) {
      for (const raw of String(others.stdout ?? '').split('\n')) {
        const filePath = raw.trim();
        if (!filePath) continue;
        if (!files.some((f) => f.path === filePath)) {
          files.push({ status: '?', path: filePath });
        }
      }
    }
  }

  return { ok: true, files };
}
