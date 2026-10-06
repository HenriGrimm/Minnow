import { gitBranchTree, gitPush, type GitBranchTreeResult, type GitOpResult } from '../state/git-api';
import { appConfirm } from './app-dialog';

interface PushDeps {
  branchTree: (cwd?: string) => Promise<GitBranchTreeResult>;
  push: typeof gitPush;
  confirm: typeof appConfirm;
}

const defaults: PushDeps = { branchTree: gitBranchTree, push: gitPush, confirm: appConfirm };

/** Prompt before publishing a local branch that has no live upstream. */
export async function pushWithPublishPrompt(
  cwd?: string,
  deps: PushDeps = defaults,
): Promise<GitOpResult> {
  const tree = await deps.branchTree(cwd);
  if (!tree.ok) return { ok: false, error: tree.error ?? 'Could not inspect the current branch' };
  const branch = tree.current?.trim() ?? '';
  const current = tree.branches?.find((entry) => entry.name === branch);
  if (!branch || !current || (current.upstream && !current.upstreamGone)) {
    return deps.push({ cwd });
  }
  const confirmed = await deps.confirm(`${branch} has no remote branch to push to. Create origin/${branch} and set it as the upstream?`, {
    title: 'Publish branch',
    confirmLabel: 'Create remote branch',
  });
  if (!confirmed) return { ok: false, error: 'cancelled' };
  return deps.push({ cwd, setUpstream: true, branch });
}
