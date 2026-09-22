import type { BoardState, Desired } from './core/types';

export const INTEGRATION_SLOT: 'integration';
export const WORKTREE_DISCARDED_TYPE: 'worktree.discarded';
export const BOARD_GIT_INITIALIZED_TYPE: 'board.git.initialized';
export const ORPHAN_RECONCILE_BULK_THRESHOLD: 8;

export function setOrphanBulkThresholdForTests(value?: number | null): void;

export function integrationBranch(boardId: string): string;
export function attemptBranch(boardId: string, slotId: string): string;
export function slotIdForTask(state: BoardState | null | undefined, taskId: string): string;
export function parseWorktreePorcelain(porcelain: string): string[];
export function pathsEqual(a: string, b: string): boolean;
export function liveWorktreePaths(state: BoardState | null | undefined): Set<string>;
export function previousWorktreeForTask(
  state: BoardState | null | undefined,
  taskId: string,
): string | null;
export function slotIdFromWorktreePath(boardId: string, worktreePath: string): string | null;
export function shouldKeepWorktree(
  state: BoardState,
  desired: Desired,
  outcome: string,
  options?: { interruption?: boolean },
): boolean;
export function wantsReuse(desired: Desired): boolean;

export function ensureBoardWorkspaceGit(): Promise<
  | {
      ok: true;
      event: {
        createdRepo: boolean;
        gitignoreCreated: boolean;
        committed: boolean;
        commitSha?: string;
      } | null;
    }
  | { ok: false; error: string }
>;

export function ensureBoardIntegration(boardId: string): Promise<{
  ok: boolean;
  path?: string;
  branch?: string;
  error?: string;
  output?: string;
  deps?: {
    ok: boolean;
    linked?: string[];
    repaired?: string[];
    failed?: Array<{ dir: string; reason: string }>;
  };
  gitInitialized?: Record<string, unknown>;
}>;

export function allocateAttemptWorktree(input: {
  boardId: string;
  taskId: string;
  attemptId: string;
  desired: Desired;
  state: BoardState;
}): Promise<{
  ok: boolean;
  path?: string;
  slotId?: string;
  created?: boolean;
  discarded: Record<string, unknown>[];
  gitInitialized?: Record<string, unknown>;
  error?: string;
}>;

export function commitAttemptWorktree(input: {
  boardId: string;
  slotId: string;
  message?: string;
}): Promise<{ ok: boolean; committed?: boolean; error?: string; output?: string }>;

export function releaseWorktree(input: {
  boardId: string;
  slotId: string;
  taskId?: string | null;
  attemptId?: string;
  worktree?: string;
}): Promise<{
  ok: boolean;
  discarded: Record<string, unknown> | null;
  error?: string;
}>;

export function reconcileOrphanWorktrees(input: {
  boardId: string;
  livePaths: Set<string> | Iterable<string>;
}): Promise<{
  removed: string[];
  discarded: Record<string, unknown>[];
}>;

export function refreshIntegrationDepsAfterMerge(input: {
  boardId: string;
  sinceSha?: string;
}): Promise<{ ok: boolean; ran?: string[]; failed?: unknown; error?: string; output?: string }>;

export function resetEnsuredBoards(): void;
