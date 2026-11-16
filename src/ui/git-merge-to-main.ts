import { runCheckoutFlow } from './git-checkout-confirm';
import {
  resolveTrunkBranchName,
  shouldShowMergeToMain,
  trunkBranchExists,
} from '../lib/git-trunk-branch';
import { gitBranches, gitMerge, type GitOpResult } from '../state/git-api';

export interface MergeToMainContext {
  /** Branch checked out in the panel (source of the merge). */
  sourceBranch: string;
  /** Main workspace root where trunk is checked out for the merge. */
  mainWorkspaceCwd: string;
  /** Whether the panel cwd is the main workspace worktree. */
  onMainWorktree: boolean;
  localBranches: readonly string[];
  remoteBranches?: readonly string[];
  lockedLocalBranches?: readonly string[];
}

/** Resolve trunk name and whether the merge-to-main button should be visible. */
export function mergeToMainButtonVisible(ctx: MergeToMainContext): boolean {
  const lockedLocal = ctx.lockedLocalBranches ?? [];
  const remote = ctx.remoteBranches ?? [];
  const trunk = resolveTrunkBranchName(ctx.localBranches, remote, lockedLocal);
  return shouldShowMergeToMain({
    currentBranch: ctx.sourceBranch,
    trunkBranch: trunk,
    onMainWorktree: ctx.onMainWorktree,
  });
}

/** Checkout trunk on the main workspace (when needed) and merge the source branch. */
export async function runMergeToMain(ctx: MergeToMainContext): Promise<GitOpResult> {
  const sourceBranch = ctx.sourceBranch.trim();
  const mainCwd = ctx.mainWorkspaceCwd.trim();

  if (!sourceBranch) {
    return { ok: false, error: 'Nothing to merge into main' };
  }
  if (!mainCwd) {
    return { ok: false, error: 'No workspace open' };
  }

  const branchesAtMain = await gitBranches(mainCwd);
  if (!branchesAtMain.ok) {
    return { ok: false, error: branchesAtMain.error ?? 'Could not read branches' };
  }

  const localAtMain = branchesAtMain.local ?? [];
  const remoteAtMain = branchesAtMain.remote ?? [];
  const lockedAtMain = branchesAtMain.lockedLocal ?? [];
  const trunk = resolveTrunkBranchName(localAtMain, remoteAtMain, lockedAtMain);

  if (sourceBranch === trunk) {
    return { ok: false, error: 'Nothing to merge into main' };
  }
  if (!trunkBranchExists(trunk, localAtMain, remoteAtMain, lockedAtMain)) {
    return { ok: false, error: 'Could not find main or master branch' };
  }

  const currentAtMain = (branchesAtMain.current ?? '').trim();
  if (currentAtMain !== trunk) {
    // Same guarded flow as every other switch: dirty-file choice, never a silent carry.
    const checkout = await runCheckoutFlow({ branch: trunk, cwd: mainCwd, expectedBranch: currentAtMain || undefined });
    if (!checkout.ok) {
      return checkout;
    }
  }

  return gitMerge({ branch: sourceBranch, cwd: mainCwd });
}
