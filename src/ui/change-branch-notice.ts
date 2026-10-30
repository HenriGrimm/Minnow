import type { Chat } from '../types';
import { worktreePathsEqual } from '../lib/worktree-list-parse';
import { gitBranches, gitCheckoutSwitch, type GitCheckoutSwitchInput } from '../state/git-api';
import { getWorkspacePath } from '../state/workspace';
import { appChoice, appConfirm } from './app-dialog';
import { createIcon } from './icon';
import '../styles/change-branch-notice.css';

export interface ChangeCheckout {
  workspacePath?: string;
  gitBranch?: string;
}

export function changeCheckoutRoot(checkout: ChangeCheckout, chat: Chat): string {
  return checkout.workspacePath || chat.worktreeRoot || chat.workspacePath || getWorkspacePath();
}

/** Only chats using this shared checkout can be disrupted. Isolated chats are excluded. */
export function runningChatsInCheckout(chats: readonly Chat[], cwd: string, running: (id: string) => boolean): Chat[] {
  return chats.filter(chat => {
    const workspace = chat.workspacePath || getWorkspacePath();
    if (chat.worktreeRoot && !worktreePathsEqual(chat.worktreeRoot, workspace)) return false;
    return worktreePathsEqual(workspace, cwd) && running(chat.id);
  });
}

/** Reuses checkout's dirty-file choice and checks active chats immediately before switching. */
export async function switchToChangeBranch(checkout: Required<ChangeCheckout>): Promise<boolean> {
  const cwd = checkout.workspacePath;
  const branch = checkout.gitBranch;
  if (!branch || branch === 'HEAD') return false;
  const current = await gitBranches(cwd);
  if (!current.ok) throw new Error(current.error || 'Could not read the current branch');
  if (current.current === branch) return true;
  const warned = new Set<string>();
  const warn = async () => {
    const { refreshRemoteChatTurns } = await import('../chat/turn-ownership');
    await refreshRemoteChatTurns(AbortSignal.timeout(5_000));
    const { sessionState } = await import('../state/sessions');
    const { isChatStreaming } = await import('../chat/streaming-state');
    const chats = runningChatsInCheckout(sessionState?.chats ?? [], cwd, isChatStreaming);
    if (!chats.some(chat => !warned.has(chat.id))) return true;
    const proceed = await appConfirm(
      `${chats.length} ${chats.length === 1 ? 'chat is' : 'chats are'} running in this checkout. Switching to ${branch} changes the files they are using and may disrupt their work.\n\nYou can wait for them to finish or switch anyway.`, {
      title: 'Chats are still running',
      confirmLabel: 'Switch anyway', cancelLabel: 'Keep current branch',
    });
    if (proceed) chats.forEach(chat => warned.add(chat.id));
    return proceed;
  };
  if (!(await warn())) return false;
  const input: GitCheckoutSwitchInput = { cwd, branch, expectedBranch: current.current || 'HEAD' };
  let result = await gitCheckoutSwitch(input);
  if (result.needsChoice) {
    const choice = await appChoice({
      title: `Switch to ${branch}?`,
      message: `You have ${result.fileCount ?? 0} uncommitted files on ${result.branch}. Choose where to keep them.`,
      buttons: [
        { id: 'leave', label: `Leave changes on ${result.branch}` },
        { id: 'bring', label: 'Bring my changes' },
        { id: 'cancel', label: 'Cancel' },
      ],
      cancelId: 'cancel', defaultFocusId: 'cancel',
    });
    if (!choice || (choice.id !== 'bring' && choice.id !== 'leave')) return false;
    if (!(await warn())) return false;
    result = await gitCheckoutSwitch({ ...input, expectedBranch: result.branch, dirtyHandling: choice.id });
  }
  if (!result.ok) throw new Error(result.error || 'Could not switch branches');
  const { sessionState, touchChat, scheduleSaveSessions } = await import('../state/sessions');
  for (const chat of sessionState?.chats ?? []) {
    const root = chat.worktreeRoot || chat.workspacePath || getWorkspacePath();
    if (!worktreePathsEqual(root, cwd)) continue;
    chat.gitBranch = branch;
    touchChat(chat);
  }
  scheduleSaveSessions();
  // Checkout has already succeeded. A failing chrome refresh must not report a failed switch.
  const refreshes = await Promise.allSettled([
    import('./file-tree-refresh-bridge').then(async m => {
      m.invalidateFileTreeCacheViaBridge();
      await m.refreshFileTreeViaBridge();
    }),
    import('./git-panel').then(m => m.refreshGitPanel()),
    import('./composer-run-target').then(m => m.syncComposerRunTargetFromActiveChat()),
  ]);
  for (const result of refreshes) {
    if (result.status === 'rejected') {
      const { reportBackgroundError } = await import('../boot/report-background-error');
      reportBackgroundError('change-branch-refresh', result.reason);
    }
  }
  return true;
}

/** Inline provenance stays visible beside the recorded diff, including when files no longer exist. */
export function createChangeBranchNotice(checkouts: ChangeCheckout[], chat: Chat): HTMLElement {
  const root = document.createElement('div');
  root.className = 'change-branch-notice';
  root.setAttribute('aria-live', 'polite');
  const refreshes: Array<() => Promise<void>> = [];
  root.addEventListener('minnow:refresh-change-branches', () => { for (const refresh of refreshes) void refresh(); });
  const unique = new Map<string, ChangeCheckout>();
  for (const checkout of checkouts) unique.set(JSON.stringify([changeCheckoutRoot(checkout, chat), checkout.gitBranch]), checkout);
  for (const checkout of unique.values()) {
    const row = document.createElement('div');
    row.className = 'change-branch-notice__row';
    const text = document.createElement('span');
    const branch = checkout.gitBranch;
    text.textContent = branch ? `Changes recorded on ${branch === 'HEAD' ? 'detached HEAD' : branch}. Checking current branch…`
      : 'The branch for these older changes was not recorded.';
    row.append(createIcon('gitBranch', { size: 14 }), text);
    root.append(row);
    if (!branch || branch === 'HEAD') {
      if (branch === 'HEAD') text.textContent = 'Changes recorded on detached HEAD.';
      continue;
    }
    const cwd = changeCheckoutRoot(checkout, chat);
    row.title = cwd;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'change-branch-notice__switch';
    button.textContent = `Switch to ${branch}`;
    button.hidden = true;
    let revision = 0;
    const refresh = async () => {
      const request = ++revision;
      const current = await gitBranches(cwd);
      if (request !== revision) return;
      const mismatch = current.ok && current.current !== branch;
      text.textContent = !current.ok ? `Changes recorded on ${branch}. Could not verify the current branch.`
        : mismatch ? `These changes were made on ${branch}. This checkout is on ${current.current || 'detached HEAD'}.`
        : `Changes recorded on ${branch}. This checkout is on the same branch.`;
      row.classList.toggle('change-branch-notice__row--different', Boolean(mismatch));
      button.hidden = current.ok && !mismatch;
    };
    refreshes.push(refresh);
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        if (await switchToChangeBranch({ workspacePath: cwd, gitBranch: branch })) {
          await Promise.all(refreshes.map(refresh => refresh()));
        }
      } catch (error) {
        text.textContent = error instanceof Error ? error.message : 'Could not switch branches';
      } finally { button.disabled = false; }
    });
    row.append(button);
    void refresh();
  }
  return root;
}
