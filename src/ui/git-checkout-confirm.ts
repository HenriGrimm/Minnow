import { appChoice, appConfirm } from './app-dialog';
/**
 * The one checkout flow every switch entry point shares: shared-folder guard,
 * dirty-file choice, routing to a worktree that already has the target, and
 * recovery actions for the error card.
 */

import { actionApi } from '../state/actions-api';
import {
  gitCheckoutPlan,
  gitCheckoutSwitch,
  gitFetch,
  gitStatus,
  type GitCheckoutSwitchInput,
  type GitOpResult,
} from '../state/git-api';
import type { NotifyAction } from './toast';

const CANCELLED: GitOpResult = { ok: false, error: 'cancelled' };

function worktreeLeaf(path: string): string {
  return path.replace(/\\/g, '/').split('/').filter(Boolean).pop() || path;
}

/** `PR #12` or the branch name, for dialog copy. */
export function checkoutTargetLabel(input: Pick<GitCheckoutSwitchInput, 'branch' | 'pullRequest'>): string {
  return input.pullRequest ? `PR #${input.pullRequest.number}` : input.branch;
}

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

/** Local chats that would follow this folder's branch. */
export interface SharedFolderGuard {
  otherChats: number;
  /** Check the target out in its own worktree and point this chat at it; absent when unsupported. */
  switchInNewWorktree?: () => Promise<GitOpResult>;
}

/** Shared workspace folder: the default is an isolated worktree, not moving every chat. */
export async function chooseSharedFolderSwitch(target: string, otherChats: number, canIsolate = true): Promise<'worktree' | 'here' | null> {
  const others = `${otherChats} other ${otherChats === 1 ? 'chat uses' : 'chats use'}`;
  const choice = await appChoice({
    title: `Switch to ${target}?`,
    message: `${others} the workspace folder. Switching it changes their files too.${canIsolate ? ` A new worktree keeps ${target} to this chat.` : ''}`,
    buttons: [
      ...(canIsolate ? [{ id: 'worktree', label: 'Switch in a new worktree' }] : []),
      { id: 'here', label: 'Switch workspace anyway' },
      { id: 'cancel', label: 'Cancel' },
    ],
    cancelId: 'cancel',
    defaultFocusId: canIsolate ? 'worktree' : 'cancel',
  });
  return choice?.id === 'worktree' || choice?.id === 'here' ? choice.id : null;
}

export interface CheckoutFlowOptions {
  /** False once the caller's surface or checkout moved on; the flow then cancels. */
  isCurrent?: () => boolean;
  /** Route to the checkout that already has the target (panel/SCC cwd, or chat attach). */
  openWorktree?: (path: string) => void | Promise<void>;
  /** Button wording for openWorktree. */
  openWorktreeLabel?: string;
  /** Present for a Local chat whose folder other chats share. */
  shared?: SharedFolderGuard;
}

/** Shares the checkout picker's guarded server operation and saved-stash behavior. */
export async function runCheckoutFlow(input: GitCheckoutSwitchInput, options: CheckoutFlowOptions = {}): Promise<GitOpResult> {
  const isCurrent = options.isCurrent ?? (() => true);
  const label = checkoutTargetLabel(input);
  if (!isCurrent()) return CANCELLED;

  if (options.shared) {
    const gate = await confirmSharedFolder(input, options.shared, isCurrent);
    if (gate !== 'proceed') return gate;
  }

  let result = await gitCheckoutSwitch(input);
  if (result.needsChoice) {
    if (!isCurrent()) return CANCELLED;
    const dirtyHandling = await chooseDirtyCheckout(label, result);
    if (!dirtyHandling || !isCurrent()) return CANCELLED;
    result = await gitCheckoutSwitch({ ...input, expectedBranch: result.branch, dirtyHandling });
  }

  if (result.code === 'in_worktree' && result.worktreePath && options.openWorktree) {
    if (!isCurrent()) return CANCELLED;
    const action = options.openWorktreeLabel ?? 'Open worktree';
    const choice = await appChoice({
      title: `${label} is open in another worktree`,
      message: `${label} is checked out in ${worktreeLeaf(result.worktreePath)} (${result.worktreePath}). Git keeps a branch in one worktree at a time.`,
      buttons: [{ id: 'open', label: action }, { id: 'cancel', label: 'Cancel' }],
      cancelId: 'cancel',
      defaultFocusId: 'open',
    });
    if (choice?.id !== 'open' || !isCurrent()) return CANCELLED;
    await options.openWorktree(result.worktreePath);
    return { ok: true, branch: result.worktreeBranch, worktreePath: result.worktreePath, location: 'worktree' };
  }
  return result;
}

/**
 * Ask before moving a folder other chats share. Resolves `proceed` to switch
 * here, or the outcome of cancelling / switching in a new worktree.
 */
export async function confirmSharedFolder(
  input: GitCheckoutSwitchInput,
  shared: SharedFolderGuard,
  isCurrent: () => boolean = () => true,
): Promise<'proceed' | GitOpResult> {
  if (shared.otherChats <= 0) return 'proceed';
  // Only a switch in this folder affects the other chats; elsewhere/current skip the prompt.
  // `current` still runs the switch (a PR checkout pulls its latest commits).
  const plan = input.create ? undefined : await gitCheckoutPlan({ cwd: input.cwd, branch: input.branch, pullRequest: input.pullRequest });
  if (!isCurrent()) return CANCELLED;
  if (plan?.ok && plan.location !== 'here') return 'proceed';
  const choice = await chooseSharedFolderSwitch(checkoutTargetLabel(input), shared.otherChats, Boolean(shared.switchInNewWorktree));
  if (!choice || !isCurrent()) return CANCELLED;
  if (choice === 'worktree' && shared.switchInNewWorktree) return shared.switchInNewWorktree();
  return 'proceed';
}

/** Back-compat wrapper used by Source Control. */
export function checkoutBranchWithChoice(
  input: GitCheckoutSwitchInput,
  isCurrent: () => boolean = () => true,
  options: Omit<CheckoutFlowOptions, 'isCurrent'> = {},
): Promise<GitOpResult> {
  return runCheckoutFlow(input, { ...options, isCurrent });
}

/** Error-card actions for a failed checkout result. */
export function checkoutRecoveryActions(
  result: { code?: string; worktreePath?: string; busyRunId?: string },
  options: { cwd?: string; openWorktree?: (path: string) => void | Promise<void>; openWorktreeLabel?: string },
): NotifyAction[] {
  const actions: NotifyAction[] = [];
  if (result.code === 'in_worktree' && result.worktreePath && options.openWorktree) {
    const path = result.worktreePath;
    actions.push({ label: options.openWorktreeLabel ?? 'Open worktree', variant: 'primary', run: async () => { await options.openWorktree!(path); } });
  }
  if (result.code === 'busy' && result.busyRunId && options.cwd) {
    const id = result.busyRunId;
    const cwd = options.cwd;
    actions.push({
      label: 'Stop action', variant: 'danger', run: async () => {
        const stopped = await actionApi('localRunCancel', { cwd, id });
        if (!stopped.ok) throw new Error(stopped.error || 'Could not stop the action.');
      },
    });
  }
  if (result.code === 'missing_ref') {
    const cwd = options.cwd;
    actions.push({
      label: 'Fetch remotes', variant: 'primary', run: async () => {
        const fetched = await gitFetch(cwd);
        if (!fetched.ok) throw new Error(fetched.error || 'Could not fetch.');
      },
    });
  }
  return actions;
}

/**
 * Detached-HEAD checkout has no stash-aware server flow; confirm dirty trees.
 * An unreadable status asks too rather than proceeding silently.
 */
export async function confirmDirtyCheckout(cwd?: string): Promise<boolean> {
  const status = await gitStatus(cwd);
  if (!status.ok) {
    return appConfirm('Could not read this checkout\'s status. Git refuses a checkout that would overwrite changes. Continue?', {
      title: 'Check out commit', confirmLabel: 'Continue',
    });
  }
  const count = (status.staged?.length ?? 0) + (status.unstaged?.length ?? 0) + (status.untracked?.length ?? 0);
  if (!count) return true;
  return appConfirm(`You have ${count} uncommitted ${count === 1 ? 'file' : 'files'}. Git carries them to the commit, or refuses if they conflict.`, {
    title: 'Check out commit', confirmLabel: 'Check out',
  });
}
