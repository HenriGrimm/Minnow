import '../styles/git-checkout-picker.css';
import { reportBackgroundError } from '../boot/report-background-error';
import { isChatTurnInProgress } from '../chat/chat-turn-guard';
import { parseWorktreeListPorcelain } from '../lib/worktree-list-parse';
import { applyChatRunTargetChoice, isChatWorktreeSetupPending, resolveChatWorktreeRoot } from '../state/chat-worktree';
import { gitBranches, gitCheckoutRestoreChanges, gitCheckoutSavedChanges, gitCheckoutSwitch } from '../state/git-api';
import { scheduleSaveSessions, sessionState, touchChat } from '../state/sessions';
import { listWorktrees } from '../state/worktree-service';
import type { Chat } from '../types';
import { isComposerRecoveryBlocked } from './composer-send';
import { syncComposerRunTargetFromActiveChat } from './composer-run-target';
import { createGitCheckoutPicker, type CheckoutPickerState } from './git-checkout-picker';
import { panelPathsEqual } from './panel-worktree-cwd';
import { refreshSidebarGitFacts } from './sidebar-git-state';

interface ThreadCheckoutOptions {
  host: HTMLElement;
  chat: Chat;
  workspace: string;
  signal: AbortSignal;
  isCurrent(): boolean;
  onChanged(branch: string): void;
  reposition(): void;
}

export async function mountThreadCheckout(options: ThreadCheckoutOptions): Promise<void> {
  const { host, chat, workspace, signal, reposition } = options;
  const cwd = () => resolveChatWorktreeRoot(chat) ?? workspace;
  const isCurrent = () => !signal.aborted && options.isCurrent();
  const notice = document.createElement('p');
  notice.className = 'graphite-thread-card__notice';
  notice.setAttribute('role', 'status');
  notice.textContent = 'Loading checkouts…';
  host.append(notice);
  let state: CheckoutPickerState;
  const fixedBranch = () => chat.chatCommandVersion === 1 && chat.workspacePreparation &&
    chat.workspacePreparation.status !== 'local';

  function check(expectedCwd: string, changeBranch = false): void {
    if (!isCurrent() || !panelPathsEqual(cwd(), expectedCwd)) throw new Error('The active checkout changed.');
    if (isChatTurnInProgress(chat.id) || isChatWorktreeSetupPending(chat.id) || isComposerRecoveryBlocked()) {
      throw new Error('Finish the current chat activity before changing checkouts.');
    }
    if (chat.boardTaskId || chat.agentConversation || (changeBranch && fixedBranch())) {
      throw new Error('This conversation is bound to its current checkout.');
    }
    if (changeBranch && sessionState?.chats.some(other => other.id !== chat.id &&
      panelPathsEqual(resolveChatWorktreeRoot(other) ?? other.workspacePath ?? workspace, expectedCwd) &&
      isChatTurnInProgress(other.id))) {
      throw new Error('Another conversation is running in this checkout.');
    }
  }

  async function load(path: string): Promise<CheckoutPickerState> {
    const [branches, listed, saved] = await Promise.all([
      gitBranches(path, signal), listWorktrees(workspace), gitCheckoutSavedChanges(path),
    ]);
    if (!branches.ok) {
      throw new Error(branches.error === 'server_off' ? 'The local server is unavailable.' : branches.error || 'Could not load branches.');
    }
    return {
      cwd: path, workspace, branch: branches.current ?? '',
      branches: [...new Set([...(branches.local ?? []), ...(branches.lockedLocal ?? []), branches.current].filter((branch): branch is string => Boolean(branch)))],
      remoteBranches: branches.remote,
      worktrees: listed.worktrees ?? parseWorktreeListPorcelain(listed.output ?? ''),
      savedChanges: saved.savedChanges ?? [],
    };
  }

  try {
    state = await load(cwd());
  } catch (error) {
    if (isCurrent()) {
      notice.textContent = error instanceof Error ? error.message : 'Could not load checkouts.';
      reposition();
    }
    return;
  }
  if (!isCurrent() || !panelPathsEqual(state.cwd, cwd())) return;

  const picker = createGitCheckoutPicker({
    inline: true,
    onSwitch: async input => {
      check(input.cwd ?? state.cwd, true);
      const result = await gitCheckoutSwitch(input);
      if (result.ok) {
        const branch = result.branch ?? input.branch;
        if (panelPathsEqual(cwd(), input.cwd ?? state.cwd) && chat.chatCommandVersion !== 1) {
          chat.gitBranch = branch;
          touchChat(chat);
          scheduleSaveSessions();
        }
        changed(input.cwd ?? state.cwd, branch);
        if (isCurrent()) {
          const refreshed = await load(cwd()).catch(() => ({
            ...state, branch,
            worktrees: state.worktrees.map(wt => panelPathsEqual(wt.path, state.cwd) ? { ...wt, branch, detached: false } : wt),
          }));
          update(refreshed);
        }
      }
      return result;
    },
    onWorktree: async path => {
      if (panelPathsEqual(path, state.cwd)) return;
      check(state.cwd);
      const local = panelPathsEqual(path, workspace);
      if (chat.chatCommandVersion === 1 && (!local || !fixedBranch())) {
        throw new Error('This server-owned conversation uses a server-managed checkout.');
      }
      const next = await load(path);
      check(state.cwd);
      const result = await applyChatRunTargetChoice(chat, local ? { kind: 'local' } : { kind: 'attach', path, branch: next.branch });
      if (!result.ok) throw new Error(result.error || 'Could not select the worktree.');
      if (!local && !next.branch) delete chat.gitBranch;
      touchChat(chat);
      scheduleSaveSessions();
      changed(path, next.branch);
      update(next);
    },
    onRestore: async input => {
      check(input.cwd);
      const result = await gitCheckoutRestoreChanges(input);
      if (result.ok) {
        changed(input.cwd, input.expectedBranch);
        const saved = await gitCheckoutSavedChanges(input.cwd);
        if (saved.ok) update({ ...state, savedChanges: saved.savedChanges ?? [] });
      }
      return result;
    },
  });
  signal.addEventListener('abort', () => picker.dispose(), { once: true });
  host.replaceChildren(picker.root);
  picker.update(state);
  picker.focusSearch();
  reposition();

  function update(next: CheckoutPickerState): void {
    if (!isCurrent() || !panelPathsEqual(next.cwd, cwd())) return;
    state = next;
    picker.update(state);
    reposition();
  }

  function changed(path: string, branch: string): void {
    refreshSidebarGitFacts(path, true);
    // Sync the active chat's composer and file tree even if the picker was dismissed mid-request.
    if (options.isCurrent() && panelPathsEqual(cwd(), path)) {
      syncComposerRunTargetFromActiveChat();
      void import('./git-panel').then(git => {
        if (!options.isCurrent()) return;
        git.clearPanelCwdUserOverride();
        git.syncPanelFromActiveChat({ forceFileTree: true });
        return git.refreshGitPanel();
      }).catch(error => reportBackgroundError('thread-checkout-refresh', error));
      options.onChanged(branch);
    }
  }
}
