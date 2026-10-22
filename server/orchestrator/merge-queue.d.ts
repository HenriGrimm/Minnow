import type { BoardState } from './core/types';

/** Overlay for tests; production callers omit this. */
export interface MergeQueueOps {
  readIntegrationRef(input: { boardId: string; ref?: string }): Promise<string | null>;
  abortMerge(input: { boardId: string }): Promise<{ ok: boolean; output?: string }>;
  rebaseOntoIntegration(input: {
    boardId: string;
    slotId: string;
  }): Promise<{ ok: true; sha: string } | { ok: false; conflicts: string[]; error?: string }>;
  mergeIntoIntegration(input: {
    boardId: string;
    fromBranch: string;
    message?: string;
  }): Promise<{
    ok: boolean;
    conflict?: boolean;
    conflictedFiles?: string[];
    error?: string;
    output?: string;
  }>;
  verifyIntegrationMerge(input: {
    boardId: string;
    fromBranch: string;
  }): Promise<{ ok: boolean; verified?: boolean; reasons?: string[]; error?: string }>;
  restoreIntegration(input: {
    boardId: string;
    sha: string;
  }): Promise<{ ok: boolean; sha?: string; error?: string; output?: string }>;
  refreshIntegrationDepsAfterMerge(input: {
    boardId: string;
    sinceSha?: string;
  }): Promise<unknown>;
}

export interface MergeAttemptEnd {
  attemptId: string;
  taskId: string | null;
  role: 'merge';
  outcome: 'pass' | 'conflicted' | 'rebased' | 'merge_failed';
  sha?: string;
  files?: string[];
  /** Integration tip before this merge — optional field on the journal event. */
  beforeSha?: string;
  summary?: string;
}

export function recoverHalfAppliedMerge(input: {
  boardId: string;
  ops?: Partial<MergeQueueOps>;
}): Promise<{ recovered: boolean; beforeSha?: string | null }>;

/**
 * Rebase the owning task onto integration, then merge.
 */
export function runMerge(input: {
  boardId: string;
  taskId: string | null;
  attemptId: string;
  state: BoardState;
  ops?: Partial<MergeQueueOps>;
}): Promise<MergeAttemptEnd>;
