/** Serialized rebase-then-merge step. */

import {
  abortMerge,
  mergeIntoIntegration,
  readIntegrationRef,
  rebaseOntoIntegration,
  restoreIntegration,
  verifyIntegrationMerge,
} from '../worktree/worktree-ops.js';
import {
  attemptBranch,
  previousWorktreeForTask,
  refreshIntegrationDepsAfterMerge,
  slotIdFromWorktreePath,
  taskCommitTitle,
} from './worktree-lifecycle.js';
import { readMergeReceipt, writeMergeReceipt } from './merge-receipt.js';
import { boardRevisionRepos, readBoardRepos } from '../worktree/board-repos.js';
import { withBoardRecovery } from './checkpoint.js';
import { boardExists } from './journal.js';

/**
 * Git ops the queue calls.
 * @typedef {object} MergeQueueOps
 * @property {(input: { boardId: string, ref?: string }) => Promise<string | null>} readIntegrationRef
 * @property {(input: { boardId: string }) => Promise<{ ok: boolean, output?: string }>} abortMerge
 * @property {(input: { boardId: string, slotId: string }) => Promise<{ ok: true, sha: string } | { ok: false, conflicts: string[], error?: string }>} rebaseOntoIntegration
 * @property {(input: { boardId: string, fromBranch: string, message?: string }) => Promise<{ ok: boolean, conflict?: boolean, conflictedFiles?: string[], error?: string, output?: string }>} mergeIntoIntegration
 * @property {(input: { boardId: string, fromBranch: string }) => Promise<{ ok: boolean, verified?: boolean, reasons?: string[], error?: string }>} verifyIntegrationMerge
 * @property {(input: { boardId: string, sha: string }) => Promise<{ ok: boolean, sha?: string, error?: string, output?: string }>} restoreIntegration
 * @property {(input: { boardId: string, sinceSha?: string }) => Promise<unknown>} refreshIntegrationDepsAfterMerge
 */

/** @type {MergeQueueOps} */
const builtinOps = {
  readIntegrationRef,
  abortMerge,
  rebaseOntoIntegration,
  mergeIntoIntegration,
  verifyIntegrationMerge,
  restoreIntegration,
  refreshIntegrationDepsAfterMerge,
};

/**
 * @param {Partial<MergeQueueOps> | undefined} overlay
 * @returns {MergeQueueOps}
 */
function resolveOps(overlay) {
  if (!overlay) return builtinOps;
  return { ...builtinOps, ...overlay };
}

/**
 * @param {{
 *   attemptId: string,
 *   taskId: string | null,
 *   files: string[],
 *   beforeSha?: string,
 *   summary?: string,
 * }} input
 * @returns {import('./engine.js').AttemptEnd}
 */
function conflictedEnd(input) {
  /** @type {import('./engine.js').AttemptEnd} */
  const end = {
    attemptId: input.attemptId,
    taskId: input.taskId,
    role: 'merge',
    outcome: 'conflicted',
    files: input.files,
  };
  if (input.beforeSha) end.beforeSha = input.beforeSha;
  if (input.summary) end.summary = input.summary;
  return end;
}

/**
 * End a merge that failed operationally rather than on conflicting content.
 *
 * Kept apart from {@link conflictedEnd} because the two want opposite handling:
 * a conflict is worth re-seeding a builder on a rebase, while a missing worktree
 * or a failed verification will reproduce identically no matter how many times
 * the work is redone.
 *
 * @param {{
 *   attemptId: string,
 *   taskId: string | null,
 *   reason: string,
 *   beforeSha?: string | null,
 *   summary?: string,
 * }} input
 * @returns {import('./engine.js').AttemptEnd}
 */
function operationalEnd(input) {
  /** @type {import('./engine.js').AttemptEnd} */
  const end = {
    attemptId: input.attemptId,
    taskId: input.taskId,
    role: 'merge',
    outcome: 'merge_failed',
    files: [],
    reason: input.reason,
  };
  if (input.beforeSha) end.beforeSha = input.beforeSha;
  if (input.summary) end.summary = input.summary;
  return end;
}

/**
 * Did verification fail because conflict markers survived, or for some other reason?
 * @param {{ reasons?: string[] } | null | undefined} verified
 * @returns {boolean}
 */
function verifyFoundConflictMarkers(verified) {
  const reasons = Array.isArray(verified?.reasons) ? verified.reasons : [];
  return reasons.some((reason) => /conflict markers remain in:/i.test(String(reason)));
}

/**
 * Turn verify-failure reasons into a file list the rebase seed can quote.
 * @param {{ reasons?: string[], error?: string } | null | undefined} verified
 * @returns {string[]}
 */
function filesFromVerify(verified) {
  const reasons = Array.isArray(verified?.reasons) ? verified.reasons : [];
  /** @type {string[]} */
  const files = [];
  for (const reason of reasons) {
    const match = String(reason).match(/conflict markers remain in:\s*(.*)$/i);
    if (match) {
      files.push(
        ...match[1]
          .split(',')
          .map((part) => part.trim())
          .filter(Boolean),
      );
    }
  }
  if (files.length > 0) return files;
  if (reasons.length > 0) return reasons;
  if (typeof verified?.error === 'string' && verified.error) return [verified.error];
  return ['(merge verification failed)'];
}

/**
 * Abort a half-applied integration merge so journal and git can agree.
 * @param {{ boardId: string, ops?: Partial<MergeQueueOps> }} input
 * @returns {Promise<{ recovered: boolean, beforeSha?: string | null }>}
 */
export async function recoverHalfAppliedMerge(input) {
  const { boardId } = input;
  const ops = resolveOps(input.ops);

  const mergeHead = await ops.readIntegrationRef({ boardId, ref: 'MERGE_HEAD' });
  if (!mergeHead) return { recovered: false };

  const orig = await ops.readIntegrationRef({ boardId, ref: 'ORIG_HEAD' });
  await ops.abortMerge({ boardId });

  const still = await ops.readIntegrationRef({ boardId, ref: 'MERGE_HEAD' });
  if (still && orig) {
    await ops.restoreIntegration({ boardId, sha: orig });
  }
  return { recovered: true, beforeSha: orig ?? null };
}

/**
 * Rebase the owning task onto integration, then merge.
 * @param {{
 *   boardId: string,
 *   taskId: string | null,
 *   attemptId: string,
 *   state: import('./core/types').BoardState,
 *   ops?: Partial<MergeQueueOps>,
 * }} input
 * @returns {Promise<import('./engine.js').AttemptEnd>}
 */
export async function runMerge(input) {
  const run = async () => {
    await input.prepare?.();
    return runQueuedMerge(input);
  };
  if (await readBoardRepos(input.boardId)) {
    return withBoardRecovery(input.boardId, async () => {
      if (!await boardExists(input.boardId)) throw new Error('Board was deleted before the merge started.');
      return run();
    });
  }
  return run();
}

async function runQueuedMerge(input) {
  const { boardId, taskId, attemptId, state } = input;
  const ops = resolveOps(input.ops);

  if (!taskId) {
    return operationalEnd({
      attemptId,
      taskId: null,
      reason: 'missing-task-id',
      summary: 'merge requires a taskId',
    });
  }

  await recoverHalfAppliedMerge({ boardId, ops });

  let beforeSha = await ops.readIntegrationRef({ boardId, ref: 'HEAD' });
  if (!beforeSha) {
    return operationalEnd({
      attemptId,
      taskId,
      reason: 'integration-head-unresolved',
      summary: 'integration HEAD could not be resolved',
    });
  }

  const worktree = previousWorktreeForTask(state, taskId);
  if (!worktree) {
    return operationalEnd({
      attemptId,
      taskId,
      reason: 'worktree-missing',
      beforeSha,
      summary: 'no builder/tester worktree recorded for this task',
    });
  }
  const slotId = slotIdFromWorktreePath(boardId, worktree);
  if (!slotId) {
    return operationalEnd({
      attemptId,
      taskId,
      reason: 'worktree-not-a-slot',
      beforeSha,
      summary: 'worktree path is not a slot of this board',
    });
  }

  const fromBranch = attemptBranch(boardId, slotId);
  const multi = Boolean(boardRevisionRepos(beforeSha));
  let testedId = null;
  if (state.recoveryVersion) {
    const tested = [...(state.tasks.get(taskId)?.attempts ?? [])].reverse().find((attempt) => attempt.role === 'tester' && attempt.outcome === 'pass' && !attempt.retired);
    const branchSha = await ops.readIntegrationRef({ boardId, ref: fromBranch });
    if (!branchSha) return operationalEnd({ attemptId, taskId, reason: 'task-branch-unresolved', beforeSha, summary: 'The task branch could not be resolved. Retained work and checkpoints have not been discarded.' });
    const waived = state.tasks.get(taskId)?.attempts.some((attempt) => !attempt.ended && attempt.role === 'merge' && attempt.evidence?.mergeAndSkip === true);
    if (!waived && (!tested?.evidence?.verifiedSha || !branchSha || tested.evidence.verifiedSha !== branchSha)) return { attemptId, taskId, role: 'merge', outcome: 'rebased', sha: branchSha, beforeSha };
    testedId = tested?.attemptId ?? null;
    const receipt = await readMergeReceipt(boardId, taskId);
    if (multi && receipt?.fromBranch === fromBranch && receipt.testedId === testedId && receipt.afterSha === branchSha) {
      const old = boardRevisionRepos(receipt.beforeSha);
      const live = boardRevisionRepos(beforeSha);
      const next = boardRevisionRepos(branchSha);
      if (old && live && next && old.size === live.size && [...live].every(([id, sha]) => sha === old.get(id) || sha === next.get(id))) {
        beforeSha = receipt.beforeSha;
      } else {
        return operationalEnd({ attemptId, taskId, reason: 'merge-recovery-diverged', beforeSha,
          summary: 'An interrupted merge and the current repository tips disagree. Reconcile the integration checkouts before retrying.' });
      }
    }
    const already = await ops.verifyIntegrationMerge({ boardId, fromBranch });
    if (already.ok && already.verified === true) {
      await ops.refreshIntegrationDepsAfterMerge({ boardId, sinceSha: receipt?.beforeSha ?? beforeSha });
      const sha = multi ? await ops.readIntegrationRef({ boardId, ref: 'HEAD' }) : beforeSha;
      return { attemptId, taskId, role: 'merge', outcome: 'pass', sha,
        beforeSha: !multi && receipt?.testedId === tested?.attemptId ? receipt.beforeSha : beforeSha };
    }
    if (!multi) await writeMergeReceipt(boardId, taskId, { beforeSha, testedId, fromBranch });
  }

  const rebased = await ops.rebaseOntoIntegration({ boardId, slotId });
  if (!rebased.ok) {
    const conflicts = Array.isArray(rebased.conflicts) ? rebased.conflicts : [];
    // Only a non-empty conflict list means content actually collided; anything
    // else is the rebase command itself failing, which a retry won't mend.
    if (conflicts.length === 0) {
      return operationalEnd({
        attemptId,
        taskId,
        reason: 'rebase-failed',
        beforeSha,
        summary: rebased.error || 'rebase failed without reporting conflicts',
      });
    }
    return conflictedEnd({
      attemptId,
      taskId,
      files: conflicts,
      beforeSha,
      summary: rebased.error || 'rebase conflicted',
    });
  }

  if (state.recoveryVersion) {
    const tested = [...(state.tasks.get(taskId)?.attempts ?? [])].reverse().find((attempt) => attempt.role === 'tester' && attempt.outcome === 'pass' && !attempt.retired);
    const waived = state.tasks.get(taskId)?.attempts.some((attempt) => !attempt.ended && attempt.role === 'merge' && attempt.evidence?.mergeAndSkip === true);
    if (!waived && (!tested?.evidence?.verifiedSha || tested.evidence.verifiedSha !== rebased.sha)) {
      return { attemptId, taskId, role: 'merge', outcome: 'rebased', sha: rebased.sha, beforeSha };
    }
  }
  if (multi) await writeMergeReceipt(boardId, taskId, { beforeSha, testedId, fromBranch, afterSha: rebased.sha });
  const merged = await ops.mergeIntoIntegration({
    boardId,
    fromBranch,
    message: taskCommitTitle(state, taskId),
  });
  if (!merged.ok) {
    const files = Array.isArray(merged.conflictedFiles) ? merged.conflictedFiles : [];
    await ops.abortMerge({ boardId });
    const still = await ops.readIntegrationRef({ boardId, ref: 'MERGE_HEAD' });
    if (still || multi) {
      const restored = await ops.restoreIntegration({ boardId, sha: beforeSha });
      if (multi && !restored.ok) return operationalEnd({ attemptId, taskId, beforeSha,
        reason: 'merge-rollback-failed', summary: restored.error || 'Could not roll back the partial merge.' });
    }
    return conflictedEnd({
      attemptId,
      taskId,
      files,
      beforeSha,
      summary: merged.error || merged.output || 'merge conflicted',
    });
  }

  const verified = await ops.verifyIntegrationMerge({ boardId, fromBranch });
  if (!verified.ok || verified.verified === false) {
    await ops.restoreIntegration({ boardId, sha: beforeSha });
    const summary =
      (verified.reasons || []).join('; ') || verified.error || 'merge verification failed';
    // Surviving conflict markers are a genuine conflict a rebase can resolve.
    // Every other verification failure is environmental.
    if (!verifyFoundConflictMarkers(verified)) {
      return operationalEnd({
        attemptId,
        taskId,
        reason: 'verify-failed',
        beforeSha,
        summary,
      });
    }
    return conflictedEnd({
      attemptId,
      taskId,
      files: filesFromVerify(verified),
      beforeSha,
      summary,
    });
  }

  const sha = (await ops.readIntegrationRef({ boardId, ref: 'HEAD' })) || rebased.sha;

  try {
    await ops.refreshIntegrationDepsAfterMerge({ boardId, sinceSha: beforeSha });
  } catch (err) {
    console.warn(
      `[orchestrator] ${boardId}: refreshIntegrationDepsAfterMerge failed after merging ${taskId}:`,
      err instanceof Error ? err.message : err,
    );
  }

  /** @type {import('./engine.js').AttemptEnd} */
  const end = {
    attemptId,
    taskId,
    role: 'merge',
    outcome: 'pass',
    sha,
    beforeSha,
  };
  return end;
}
