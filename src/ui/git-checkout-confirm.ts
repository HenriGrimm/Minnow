import { appChoice, appConfirm } from './app-dialog';
/**
 * Confirm checkout when the working tree has uncommitted changes.
 */

import { gitCheckoutSwitch, gitStatus, type GitCheckoutSwitchInput, type GitOpResult } from '../state/git-api';

export async function chooseDirtyCheckout(branch: string, state: Pick<GitOpResult, 'branch' | 'fileCount'>): Promise<'bring' | 'leave' | null> {
  const source = state.branch === 'HEAD' ? 'detached HEAD' : state.branch;
  const count = state.fileCount ?? 0;
  const choice = await appChoice({
    title: `Switch to ${branch}?`,
    message: `You have ${count} uncommitted ${count === 1 ? 'file' : 'files'} on ${source}. ${state.branch === 'HEAD'
      ? `Bring your changes to ${branch} or cancel to keep working here.`
      : `Bring your changes to ${branch} or save them in a stash on ${source}.`}`,
    buttons: [
      { id: 'bring', label: 'Bring my changes' },
      ...(state.branch === 'HEAD' ? [] : [{ id: 'leave', label: `Leave changes on ${source}` }]),
      { id: 'cancel', label: 'Cancel' },
    ],
    cancelId: 'cancel',
    defaultFocusId: 'cancel',
  });
  return choice?.id === 'bring' || choice?.id === 'leave' ? choice.id : null;
}

/** Shares the checkout picker's guarded server operation and saved-stash behavior. */
export async function checkoutBranchWithChoice(
  input: GitCheckoutSwitchInput,
  isCurrent: () => boolean = () => true,
): Promise<GitOpResult> {
  if (!isCurrent()) return { ok: false, error: 'cancelled' };
  const result = await gitCheckoutSwitch(input);
  if (!result.needsChoice) return result;
  if (!isCurrent()) return { ok: false, error: 'cancelled' };
  const dirtyHandling = await chooseDirtyCheckout(input.branch, result);
  if (!dirtyHandling || !isCurrent()) return { ok: false, error: 'cancelled' };
  return gitCheckoutSwitch({ ...input, expectedBranch: result.branch, dirtyHandling });
}

/** Returns true when checkout should proceed (clean tree or user confirmed). */
export async function confirmDirtyCheckout(cwd?: string): Promise<boolean> {
  const status = await gitStatus(cwd);
  if (!status.ok) return true;

  const dirty =
    (status.staged?.length ?? 0) +
      (status.unstaged?.length ?? 0) +
      (status.untracked?.length ?? 0) >
    0;

  if (!dirty) return true;
  return await appConfirm('Working tree has uncommitted changes. Checkout anyway?');
}
