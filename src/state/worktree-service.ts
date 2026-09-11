/**
 * Client wrappers for the /api/worktree server ops (MIN-275 board task isolation).
 * All calls are best-effort: when the local server is unavailable the helpers return
 * a non-ok result so callers fall back to the shared workspace (no isolation) rather
 * than blocking task execution. Reusable by MIN-276.
 */

import { isLocalServerAvailable } from '../tools/config.ts';
import { reportBackgroundError } from '../boot/report-background-error.ts';
import { parseWorktreeListPorcelain } from '../lib/worktree-list-parse.ts';
import { noteRegisteredWorktreePaths } from '../lib/worktree-allowlist-client.ts';

/** One git worktree entry parsed from `git worktree list --porcelain`. */
export interface WorktreeListEntry {
  path: string;
  head: string;
  branch?: string;
  detached: boolean;
  bare?: boolean;
}

export interface WorktreeOpResult {
  ok: boolean;
  path?: string;
  branch?: string;
  /** Parsed worktrees when `op` is `list`. */
  worktrees?: WorktreeListEntry[];
  created?: boolean;
  committed?: boolean;
  dirty?: boolean;
  files?: string[];
  inProgress?: boolean;
  merged?: boolean;
  conflict?: boolean;
  conflictedFiles?: string[];
  integrationSha?: string;
  verified?: boolean;
  reasons?: string[];
  sha?: string;
  output?: string;
  error?: string;
  ran?: string[];
  failed?: string[];
  skipped?: string;
  url?: string;
  pushed?: boolean;
  /** Worktrees removed by cleanup op. */
  removed?: number;
  dirtyWorktrees?: Array<{ slot: string; path: string }>;
  retainedWorktrees?: Array<{ path: string; reason: string }>;
  removedBranches?: string[];
  retainedBranches?: Array<{ branch: string; reason: string }>;
  keptIntegration?: boolean;
  additions?: number;
  deletions?: number;
  fileCount?: number;
  hasRemote?: boolean;
  hasGh?: boolean;
  alreadyLanded?: boolean;
  /** Stats came from the uncommitted workspace checkout (no integration branch). */
  dirtyWorkspace?: boolean;
  untrackedCount?: number;
  currentBranch?: string | null;
}

// ── Transport ────────────────────────────────────────────────────────────────

async function postWorktree(
  op: string,
  args: Record<string, unknown>,
): Promise<WorktreeOpResult> {
  if (!isLocalServerAvailable()) {
    return { ok: false, error: 'server_off' };
  }
  try {
    const res = await fetch('/api/worktree', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op, ...args }),
    });
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}` };
    }
    return (await res.json()) as WorktreeOpResult;
  } catch (err) {
    reportBackgroundError('worktree-op', err);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Board ops ────────────────────────────────────────────────────────────────

/** Ensure the board integration branch + its worktree exist. */
export function ensureIntegration(input: {
  boardId: string;
  branch: string;
  baseRef?: string;
}): Promise<WorktreeOpResult> {
  return postWorktree('ensure_integration', input);
}

/** Create (or attach) a task/wave worktree on its branch off the integration branch. */
export function createWorktree(input: {
  boardId: string;
  slotId: string;
  branch: string;
  baseRef?: string;
}): Promise<WorktreeOpResult> {
  return postWorktree('create', input);
}

/** Merge a task/wave branch into the board integration branch (inside its worktree). */
export function mergeIntoIntegration(input: {
  boardId: string;
  fromBranch: string;
  message?: string;
}): Promise<WorktreeOpResult> {
  return postWorktree('merge', input);
}

/** Stage and commit all changes in a task worktree slot (no empty commit). */
export function commitWorktree(input: {
  boardId: string;
  slotId: string;
  message?: string;
}): Promise<WorktreeOpResult> {
  return postWorktree('commit', input);
}

/** True when a task worktree slot has uncommitted changes. */
export function checkWorktreeDirty(input: {
  boardId: string;
  slotId: string;
}): Promise<WorktreeOpResult> {
  return postWorktree('check_dirty', input);
}

/** True when fromBranch is already merged into integration. */
export function checkMerged(input: {
  boardId: string;
  fromBranch: string;
}): Promise<WorktreeOpResult> {
  return postWorktree('check_merged', input);
}

/** Abort an in-progress merge in the integration worktree. */
export function abortMerge(input: { boardId: string }): Promise<WorktreeOpResult> {
  return postWorktree('abort_merge', input);
}

/** True when MERGE_HEAD is set in the integration worktree (merge in progress). */
export function checkMergeInProgress(input: { boardId: string }): Promise<WorktreeOpResult> {
  return postWorktree('merge_in_progress', input);
}

/** Reset integration worktree to a pre-merge tip (abort merge + hard reset + clean). */
export function restoreIntegration(input: {
  boardId: string;
  sha: string;
}): Promise<WorktreeOpResult> {
  return postWorktree('restore_integration', input);
}

/** Structural post-merge verification (ancestry, markers, clean tree). */
export function verifyIntegrationMerge(input: {
  boardId: string;
  fromBranch: string;
}): Promise<WorktreeOpResult> {
  return postWorktree('verify_integration', input);
}

/** Install deps in integration when a merge changed manifests or lockfiles. */
export function refreshIntegrationDeps(input: {
  boardId: string;
  sinceSha?: string;
}): Promise<WorktreeOpResult> {
  return postWorktree('refresh_integration_deps', input);
}

/** Remove a single worktree slot. */
export function removeWorktree(input: {
  boardId: string;
  slotId: string;
}): Promise<WorktreeOpResult> {
  return postWorktree('remove', input);
}

/** Remove all worktrees for a board (on completion / delete). */
export function cleanupBoardWorktrees(input: {
  boardId: string;
  /** When true, also removes the integration worktree (after landing in workspace). */
  includeIntegration?: boolean;
  /** Refuse to delete worktrees with uncommitted changes. */
  protectDirty?: boolean;
  /** Inspect worktrees without removing anything. */
  checkOnly?: boolean;
}): Promise<WorktreeOpResult> {
  return postWorktree('cleanup', input);
}

/** Remove merged local board branches, including after worktrees were cleared. */
export function cleanupBoardBranches(input: { boardId: string }): Promise<WorktreeOpResult> {
  return postWorktree('cleanup_branches', input);
}

/** Numstat diff for the integration branch vs its base ref. */
export function integrationStats(input: {
  boardId: string;
  baseRef?: string;
}): Promise<WorktreeOpResult> {
  return postWorktree('integration_stats', input);
}

/**
 * Numstat diff for landing integration work into the workspace checkout. With no
 * branch the server reports the uncommitted workspace diff instead (isolation off).
 */
export function workspaceLandingStats(input: {
  branch?: string;
}): Promise<WorktreeOpResult> {
  return postWorktree('workspace_landing_stats', input);
}

/** Merge the integration branch into the workspace's current branch. */
export function mergeIntegrationIntoWorkspace(input: {
  branch: string;
  message?: string;
}): Promise<WorktreeOpResult> {
  return postWorktree('merge_integration_into_workspace', input);
}

/** Open a GitHub PR for the workspace's current branch via gh. */
export function openWorkspacePr(input: {
  title?: string;
  body?: string;
}): Promise<WorktreeOpResult> {
  return postWorktree('open_workspace_pr', input);
}

/** Stage and commit all changes in the integration worktree. */
export function commitIntegration(input: {
  boardId: string;
  message?: string;
}): Promise<WorktreeOpResult> {
  return postWorktree('commit_integration', input);
}

/** Push the integration branch to origin. */
export function pushIntegration(input: {
  boardId: string;
  branch: string;
}): Promise<WorktreeOpResult> {
  return postWorktree('push_integration', input);
}

/** Open a GitHub PR for the integration branch via gh. */
export function openIntegrationPr(input: {
  boardId: string;
  branch: string;
  title?: string;
  body?: string;
}): Promise<WorktreeOpResult> {
  return postWorktree('open_pr', input);
}

// ── List chats ───────────────────────────────────────────────────────────────

/** List all git worktrees for the active repo (`git worktree list --porcelain`). */
export async function listWorktrees(): Promise<WorktreeOpResult> {
  const result = await postWorktree('list', {});
  if (result.ok) {
    const paths =
      result.worktrees?.map((wt) => wt.path) ??
      (result.output ? parseWorktreeListPorcelain(result.output).map((wt) => wt.path) : []);
    if (paths.length) noteRegisteredWorktreePaths(paths);
  }
  return result;
}

/** Create a managed per-chat worktree (MIN-276). */
export function createChatWorktree(input: {
  chatId: string;
  branch: string;
  baseRef?: string;
  checkoutExisting?: boolean;
}): Promise<WorktreeOpResult> {
  return postWorktree('create_chat', input);
}

/** Remove a managed per-chat worktree slot. */
export function removeChatWorktree(input: { chatId: string }): Promise<WorktreeOpResult> {
  return postWorktree('remove_chat', input);
}
