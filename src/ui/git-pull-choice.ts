import { gitPull, type GitOpResult } from '../state/git-api';
import { appChoice } from './app-dialog';

export async function pullWithStrategyChoice(
  cwd?: string,
  repoLabel?: string,
  isCurrent: () => boolean = () => true,
): Promise<GitOpResult> {
  const cancelled = { ok: false, error: 'cancelled' };
  if (!isCurrent()) return cancelled;
  const first = await gitPull(cwd);
  const target = first.pullTarget;
  if (first.ok || !target) return first;

  if (!isCurrent()) return cancelled;
  const choice = await appChoice({
    title: repoLabel ? `Choose how to pull · ${repoLabel}` : 'Choose how to pull',
    message: `${target.branch} and ${target.upstream} each have commits the other doesn’t.\n\nMerge keeps the existing commits and adds a merge commit. Rebase replays your local commits on top of the upstream branch and changes their commit IDs.\n\nThis choice applies only to this pull.`,
    buttons: [
      { id: 'cancel', label: 'Cancel' },
      { id: 'rebase', label: 'Rebase once' },
      { id: 'merge', label: 'Merge once', primary: true },
    ],
    defaultFocusId: 'cancel',
  });
  if ((choice.id !== 'merge' && choice.id !== 'rebase') || !isCurrent()) return cancelled;
  return gitPull(target.cwd, { strategy: choice.id, expectedTarget: target });
}
