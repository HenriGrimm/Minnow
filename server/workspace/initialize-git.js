/**
 * Programmatic git init for board onboarding (MIN-615).
 * Board kickoff already collected consent; do not send this work through the
 * /git-setup LLM skill (it re-asks via ask_question and can loop).
 */

import { runWorktreeSetupProcess } from '../worktree/setup-process.js';
import { isGitRepository } from '../tools/git-change-stats.js';
import { ensureBaselineGitignore } from './baseline-gitignore.js';
import { getEffectiveWorkspaceRoot } from '../runtime/path-access.js';

const GIT_TIMEOUT_MS = 120_000;
/** Conventional message for the first commit on a freshly initialized workspace. */
export const INITIAL_COMMIT_MESSAGE = 'chore: initial commit';
/** Used only when the workspace has no git user.name / user.email. */
const FALLBACK_NAME = 'Minnow';
const FALLBACK_EMAIL = 'minnow@localhost';

/** Combine stdout/stderr for a failed git process. */
function processError(result) {
  const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
  return text || `git exited with code ${result.code}`;
}

/** Run git in cwd with the workspace init timeout. */
function git(args, cwd, signal) {
  signal?.throwIfAborted();
  return runWorktreeSetupProcess('git', args, { cwd, timeout: GIT_TIMEOUT_MS, signal });
}

/**
 * `git init -b main`, falling back to `git init` + symbolic-ref for older git.
 * @param {string} cwd
 * @returns {Promise<{ ok: true } | { ok: false; error: string }>}
 */
async function initRepo(cwd, signal) {
  const withBranch = await git(['init', '-b', 'main'], cwd, signal);
  if (withBranch.code === 0) return { ok: true };

  const fallback = await git(['init'], cwd, signal);
  if (fallback.code !== 0) {
    return { ok: false, error: processError(fallback) };
  }
  await git(['symbolic-ref', 'HEAD', 'refs/heads/main'], cwd, signal);
  return { ok: true };
}

/** Why a multi-repo folder is not initialized as one repository. */
export function multiRepoInitError(ids) {
  return `This folder holds several git repositories (${ids.join(', ')}). Minnow will not turn the parent folder into another repository; work in one of them instead.`;
}

/** True when the repo has at least one commit. */
async function hasHead(cwd, signal) {
  const result = await git(['rev-parse', '--verify', 'HEAD'], cwd, signal);
  return result.code === 0;
}

/**
 * Extra `git -c user.name=… -c user.email=…` args when identity is unset.
 * Leaves the user's global/local config alone when both name and email exist.
 * @param {string} cwd
 * @returns {Promise<{ args: string[]; usedFallback: boolean }>}
 */
async function commitIdentity(cwd, signal) {
  const name = await git(['config', '--get', 'user.name'], cwd, signal);
  const email = await git(['config', '--get', 'user.email'], cwd, signal);
  if ((name.stdout ?? '').trim() && (email.stdout ?? '').trim()) {
    return { args: [], usedFallback: false };
  }
  return {
    args: ['-c', `user.name=${FALLBACK_NAME}`, '-c', `user.email=${FALLBACK_EMAIL}`],
    usedFallback: true,
  };
}

/**
 * Initialize git in the workspace: init, baseline .gitignore, initial commit.
 * Idempotent: existing repos skip init; existing HEAD skips the commit.
 *
 * @param {string} [workspaceRoot]
 * @returns {Promise<{
 *   ok: true;
 *   alreadyRepo: boolean;
 *   createdRepo: boolean;
 *   gitignoreCreated: boolean;
 *   committed: boolean;
 *   commitSha?: string;
 *   usedFallbackIdentity: boolean;
 * } | { ok: false; error: string }>}
 */
export async function initializeWorkspaceGit(workspaceRoot, { signal } = {}) {
  signal?.throwIfAborted();
  const root = workspaceRoot?.trim() || getEffectiveWorkspaceRoot();
  if (!root) {
    return { ok: false, error: 'Workspace root is not set' };
  }

  const probe = signal ? await git(['rev-parse', '--is-inside-work-tree'], root, signal) : null;
  const alreadyRepo = probe ? probe.code === 0 && probe.stdout.trim() === 'true' : await isGitRepository(root);
  let createdRepo = false;
  if (!alreadyRepo) {
    // A folder of repos (`frontend/` + `backend/`) must never become one repo:
    // `git add -A` would commit the children as embedded repositories.
    const { discoverWorkspaceRepos, invalidateWorkspaceRepos } = await import('./repos.js');
    invalidateWorkspaceRepos(root);
    const children = await discoverWorkspaceRepos(root, { refresh: true });
    signal?.throwIfAborted();
    if (children.length) {
      return { ok: false, error: multiRepoInitError(children.map((repo) => repo.id)) };
    }
    const init = await initRepo(root, signal);
    if (!init.ok) return init;
    createdRepo = true;
  }

  signal?.throwIfAborted();
  const gitignore = await ensureBaselineGitignore(root);
  if (!gitignore.ok) {
    return { ok: false, error: gitignore.error ?? 'Failed to write .gitignore' };
  }

  if (await hasHead(root, signal)) {
    return {
      ok: true,
      alreadyRepo,
      createdRepo,
      gitignoreCreated: Boolean(gitignore.created),
      committed: false,
      usedFallbackIdentity: false,
    };
  }

  const add = await git(['add', '-A'], root, signal);
  if (add.code !== 0) {
    return { ok: false, error: processError(add) };
  }

  const status = await git(['status', '--porcelain'], root, signal);
  const empty = !(status.stdout ?? '').trim();
  const identity = await commitIdentity(root, signal);
  const commitArgs = [
    ...identity.args,
    '-c',
    'commit.gpgsign=false',
    'commit',
    ...(empty ? ['--allow-empty'] : []),
    '-m',
    INITIAL_COMMIT_MESSAGE,
  ];
  const commit = await git(commitArgs, root, signal);
  if (commit.code !== 0) {
    return { ok: false, error: processError(commit) };
  }

  const shaResult = await git(['rev-parse', 'HEAD'], root, signal);
  const commitSha = (shaResult.stdout ?? '').trim() || undefined;

  return {
    ok: true,
    alreadyRepo,
    createdRepo,
    gitignoreCreated: Boolean(gitignore.created),
    committed: true,
    commitSha,
    usedFallbackIdentity: identity.usedFallback,
  };
}
