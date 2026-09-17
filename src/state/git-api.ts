/**
 * Client wrappers for /api/git server ops (MIN-198 Git Support).
 */

import { isLocalServerAvailable } from '../tools/config.ts';
import { reportBackgroundError } from '../boot/report-background-error.ts';

export interface GitFileEntry {
  path: string;
  status: string;
}

export interface GitCommitEntry {
  hash: string;
  parents: string[];
  subject: string;
  author: string;
  relativeTime: string;
  refs: string[];
}

export interface GitOpResult {
  additions?: number;
  deletions?: number;
  ok: boolean;
  error?: string;
  branch?: string;
  ahead?: number;
  behind?: number;
  staged?: GitFileEntry[];
  unstaged?: GitFileEntry[];
  untracked?: GitFileEntry[];
  patch?: string;
  sha?: string;
  /** `stage`: pathspecs actually handed to `git add`. */
  stagedPaths?: string[];
  /** `stage`: pathspecs dropped because they are neither tracked nor on disk (MIN-651). */
  skippedPaths?: string[];
  /** HEAD tip when a snapshot was created/restored (MIN-409). */
  headSha?: string;
  treeSha?: string;
  /** Pre-restore safety snapshot sha from snapshotRestore. */
  safetySha?: string;
  /** Name-status paths from snapshotDiff. */
  files?: GitFileEntry[];
  stdout?: string;
  commits?: GitCommitEntry[];
  current?: string;
  local?: string[];
  lockedLocal?: string[];
  remote?: string[];
  stat?: string;
  path?: string;
  conflict?: boolean;
  stashes?: string[];
  url?: string;
}

// ── Transport ────────────────────────────────────────────────────────────────

async function postGit(
  op: string,
  args: Record<string, unknown> = {},
): Promise<GitOpResult> {
  if (!isLocalServerAvailable()) {
    return { ok: false, error: 'server_off' };
  }
  try {
    const res = await fetch('/api/git', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op, ...args }),
    });
    if (!res.ok) {
      const payload = await res.json().catch(() => null) as { error?: unknown } | null;
      return {
        ok: false,
        error: typeof payload?.error === 'string' && payload.error.trim()
          ? payload.error
          : `HTTP ${res.status}`,
      };
    }
    return (await res.json()) as GitOpResult;
  } catch (err) {
    // A failed Git request is not a health check: other project/chat requests
    // can still succeed. Only server detection should change availability.
    reportBackgroundError('git-op', err);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Working tree ─────────────────────────────────────────────────────────────

export function gitStatus(cwd?: string): Promise<GitOpResult> {
  return postGit('status', cwd ? { cwd } : {});
}

export function gitDiff(input?: {
  cwd?: string;
  cached?: boolean;
  path?: string;
  /** Unstaged + untracked diffs for commit message generation */
  workingTree?: boolean;
}): Promise<GitOpResult> {
  return postGit('diff', input ?? {});
}

export function gitStage(input: {
  paths: string[];
  cwd?: string;
}): Promise<GitOpResult> {
  return postGit('stage', input);
}

export function gitStageAll(cwd?: string): Promise<GitOpResult> {
  return postGit('stageAll', cwd ? { cwd } : {});
}

export function gitUnstage(input: {
  paths: string[];
  cwd?: string;
}): Promise<GitOpResult> {
  return postGit('unstage', input);
}

export function gitDiscard(input: {
  paths: string[];
  cwd?: string;
}): Promise<GitOpResult> {
  return postGit('discard', input);
}

export function gitCommit(input: {
  message: string;
  cwd?: string;
}): Promise<GitOpResult> {
  return postGit('commit', input);
}

export function gitPush(input?: {
  cwd?: string;
  setUpstream?: boolean;
  branch?: string;
}): Promise<GitOpResult> {
  return postGit('push', input ?? {});
}

export function gitPull(cwd?: string): Promise<GitOpResult> {
  return postGit('pull', cwd ? { cwd } : {});
}

export function gitFetch(cwd?: string): Promise<GitOpResult> {
  return postGit('fetch', cwd ? { cwd } : {});
}

export function gitLog(input?: {
  cwd?: string;
  count?: number;
}): Promise<GitOpResult> {
  return postGit('log', input ?? {});
}

// ── Branches ─────────────────────────────────────────────────────────────────

export function gitBranches(cwd?: string): Promise<GitOpResult> {
  return postGit('branches', cwd ? { cwd } : {});
}

export function gitCheckout(input: {
  branch: string;
  create?: boolean;
  startPoint?: string;
  cwd?: string;
}): Promise<GitOpResult> {
  return postGit('checkout', input);
}

export function gitCheckoutDetach(input: {
  sha: string;
  cwd?: string;
}): Promise<GitOpResult> {
  return postGit('checkoutDetach', input);
}

export function gitCreateTag(input: {
  name: string;
  sha: string;
  cwd?: string;
}): Promise<GitOpResult> {
  return postGit('createTag', input);
}

export function gitRemoteUrl(cwd?: string): Promise<GitOpResult> {
  return postGit('remoteUrl', cwd ? { cwd } : {});
}

export function gitDeleteRemoteBranch(input: { branch: string; cwd?: string }): Promise<GitOpResult> {
  return postGit('deleteRemoteBranch', input);
}

export function gitDiffSummary(cwd: string): Promise<GitOpResult> {
  return postGit('diffSummary', { cwd });
}

export function gitDeleteBranch(input: {
  branch: string;
  force?: boolean;
  cwd?: string;
}): Promise<GitOpResult> {
  return postGit('deleteBranch', input);
}

export function gitWorktreeAdd(input: {
  branch: string;
  path?: string;
  baseRef?: string;
  checkoutExisting?: boolean;
  cwd?: string;
}): Promise<GitOpResult> {
  return postGit('worktreeAdd', input);
}

export function gitWorktreeRemove(input: {
  path: string;
  force?: boolean;
  cwd?: string;
}): Promise<GitOpResult> {
  return postGit('worktreeRemove', input);
}

export function gitShow(input: {
  sha: string;
  cwd?: string;
}): Promise<GitOpResult> {
  return postGit('show', input);
}

export function gitMerge(input: {
  branch?: string;
  noFf?: boolean;
  abort?: boolean;
  cwd?: string;
}): Promise<GitOpResult> {
  return postGit('merge', input);
}

export function gitRebase(input: {
  onto?: string;
  abort?: boolean;
  continue?: boolean;
  cwd?: string;
}): Promise<GitOpResult> {
  return postGit('rebase', input);
}

// ── Stash ────────────────────────────────────────────────────────────────────

export function gitStashList(cwd?: string): Promise<GitOpResult> {
  return postGit('stashList', cwd ? { cwd } : {});
}

export function gitStashPush(input?: {
  cwd?: string;
  message?: string;
  paths?: string[];
}): Promise<GitOpResult> {
  return postGit('stashPush', input ?? {});
}

export function gitStashPop(input?: {
  cwd?: string;
  index?: number;
}): Promise<GitOpResult> {
  return postGit('stashPop', input ?? {});
}

export function gitStashApply(input?: {
  cwd?: string;
  index?: number;
}): Promise<GitOpResult> {
  return postGit('stashApply', input ?? {});
}

export function gitStashDrop(input?: {
  cwd?: string;
  index?: number;
}): Promise<GitOpResult> {
  return postGit('stashDrop', input ?? {});
}

export function gitCherryPick(input: {
  sha?: string;
  abort?: boolean;
  continue?: boolean;
  cwd?: string;
}): Promise<GitOpResult> {
  return postGit('cherryPick', input);
}

/**
 * Capture a dangling commit of the working tree (temp index; HEAD/index untouched).
 * MIN-409 agent undo snapshots.
 */
export function gitSnapshotCreate(input?: {
  cwd?: string;
  message?: string;
}): Promise<GitOpResult> {
  return postGit('snapshotCreate', input ?? {});
}

/**
 * Restore working tree to a snapshot commit without moving HEAD.
 * Takes a safety snapshot first and returns its sha as `safetySha`.
 */
export function gitSnapshotRestore(input: {
  cwd?: string;
  sha: string;
}): Promise<GitOpResult> {
  return postGit('snapshotRestore', input);
}

/**
 * Diff two snapshot commits, or a commit vs the current working tree when `toSha` is omitted.
 */
export function gitSnapshotDiff(input: {
  cwd?: string;
  fromSha: string;
  toSha?: string;
}): Promise<GitOpResult> {
  return postGit('snapshotDiff', input);
}
