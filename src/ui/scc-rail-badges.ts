import { gitStashList, type GitOpResult } from '../state/git-api';
import { prList, runList, type ForgeStatus } from '../state/forge-api';
import { getWorkspacePath } from '../state/workspace';
import { filterUserFacingWorktrees, parseWorktreeListPorcelain } from '../lib/worktree-list-parse';
import { listWorktrees } from '../state/worktree-service';
import { rollupChecksRailState } from './scc-checks';
import type { SccBadge, SccSectionId } from './scc-shared';

export type ApplySccRailBadge = (section: SccSectionId, badge: SccBadge | null) => void;

function changesBadgeFromStatus(status: GitOpResult): SccBadge | null {
  if (!status.ok) return null;
  const staged = status.staged ?? [];
  const unstaged = status.unstaged ?? [];
  const untracked = status.untracked ?? [];
  const total = staged.length + unstaged.length + untracked.length;
  return total > 0 ? { kind: 'count', value: total } : null;
}

/** Git-backed sections: changes, branches, stashes, worktrees. */
export async function refreshGitRailBadges(
  apply: ApplySccRailBadge,
  options: {
    cwd?: string;
    status: GitOpResult;
    branchCount: number;
  },
): Promise<void> {
  apply('changes', changesBadgeFromStatus(options.status));
  apply(
    'branches',
    options.branchCount > 0 ? { kind: 'count', value: options.branchCount } : null,
  );

  const cwd = options.cwd;
  const [stashResult, worktreeResult] = await Promise.all([gitStashList(cwd), listWorktrees()]);

  if (stashResult.ok) {
    const count = stashResult.stashes?.length ?? 0;
    apply('stashes', count > 0 ? { kind: 'count', value: count } : null);
  }

  const workspace = getWorkspacePath().trim();
  const parsed =
    worktreeResult.ok && worktreeResult.output
      ? parseWorktreeListPorcelain(worktreeResult.output)
      : [];
  const worktrees =
    parsed.length > 0
      ? filterUserFacingWorktrees(parsed, workspace)
      : workspace
        ? [{ path: workspace, head: '', branch: undefined, detached: false }]
        : [];
  apply('worktrees', worktrees.length > 1 ? { kind: 'count', value: worktrees.length } : null);
}

/** Forge-backed sections: pulls and checks. */
export async function refreshForgeRailBadges(
  apply: ApplySccRailBadge,
  options: {
    cwd?: string;
    branch: string;
    forge: ForgeStatus | null;
  },
): Promise<void> {
  if (!options.forge?.supported) {
    apply('pulls', null);
    apply('checks', null);
    return;
  }

  const cwd = options.cwd;
  const branch = options.branch;

  const [prResult, runResult] = await Promise.all([
    prList({ cwd, state: 'open' }),
    runList({ cwd, branch: branch ? branch : undefined, limit: 25 }),
  ]);

  if (prResult.ok) {
    const openCount = (prResult.prs ?? []).filter((pr) => pr.state === 'open').length;
    apply('pulls', openCount > 0 ? { kind: 'count', value: openCount } : null);
  }

  if (runResult.ok) {
    const runs = runResult.runs ?? [];
    apply('checks', runs.length ? { kind: 'state', value: rollupChecksRailState(runs) } : null);
  }
}
