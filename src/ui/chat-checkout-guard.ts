/**
 * Local chats share their workspace folder's HEAD. Switching it from one chat
 * moves every other Local chat too, so the shared flow offers an isolated
 * worktree first (documentation/plans/source-control-ux-overhaul.md, step 5).
 */

import { isChatArchived } from '../state/session-workspace-scope';
import { applyChatRunTargetChoice, resolveChatWorktreeRoot } from '../state/chat-worktree';
import { scheduleSaveSessions, sessionState, touchChat } from '../state/sessions';
import type { GitCheckoutSwitchInput, GitOpResult } from '../state/git-api';
import type { Chat } from '../types';
import type { SharedFolderGuard } from './git-checkout-confirm';
import { panelPathsEqual } from './panel-worktree-cwd';

/** Other live chats whose tools run in `cwd` (Local chats on the same folder). */
export function otherChatsInCheckout(chat: Pick<Chat, 'id'>, cwd: string, workspace: string): Chat[] {
  return (sessionState?.chats ?? []).filter((other) => {
    if (other.id === chat.id || isChatArchived(other) || other.boardTaskId || other.background) return false;
    const folder = resolveChatWorktreeRoot(other) ?? other.workspacePath?.trim() ?? workspace;
    return Boolean(folder) && panelPathsEqual(folder, cwd);
  });
}

/**
 * Guard for a switch in `cwd` requested from `chat`; undefined when nothing
 * else shares that folder (or the chat already has its own worktree).
 */
export function sharedFolderGuard(
  chat: Chat,
  cwd: string,
  workspace: string,
  input: Pick<GitCheckoutSwitchInput, 'branch' | 'create' | 'startPoint' | 'pullRequest'>,
  onAttached?: (path: string, branch: string) => void,
): SharedFolderGuard | undefined {
  if (resolveChatWorktreeRoot(chat)) return undefined;
  const others = otherChatsInCheckout(chat, cwd, workspace);
  if (!others.length) return undefined;
  // Server-owned conversations prepare checkouts through their own route, and a
  // fork PR head has no branch a worktree could attach to.
  const canIsolate = chat.chatCommandVersion !== 1 && !input.pullRequest?.crossRepository;
  return {
    otherChats: others.length,
    ...(canIsolate ? { switchInNewWorktree: () => switchInNewWorktree(chat, input, onAttached) } : {}),
  };
}

async function switchInNewWorktree(
  chat: Chat,
  input: Pick<GitCheckoutSwitchInput, 'branch' | 'create' | 'startPoint' | 'pullRequest'>,
  onAttached?: (path: string, branch: string) => void,
): Promise<GitOpResult> {
  // A remote row arrives as create + `origin/x`; check that ref out with tracking.
  const remote = Boolean(input.create && input.startPoint && input.startPoint.includes('/'));
  const fresh = Boolean(input.create && !remote);
  const name = remote ? input.startPoint! : input.pullRequest?.headRef || input.branch;
  const result = await applyChatRunTargetChoice(chat, {
    kind: 'create',
    name: fresh ? input.branch : name,
    startPoint: fresh ? input.startPoint || 'HEAD' : 'HEAD',
    checkoutExisting: !fresh,
  });
  if (!result.ok) return { ok: false, error: result.error || 'Could not create a worktree for this chat.' };
  touchChat(chat);
  scheduleSaveSessions();
  const path = chat.worktreeRoot ?? '';
  const branch = chat.gitBranch ?? input.branch;
  onAttached?.(path, branch);
  return { ok: true, branch, worktreePath: path, location: 'worktree' };
}

/** Live chats whose own worktree is `path` (not Local chats on the workspace). */
export function chatsBoundToWorktree(path: string): Chat[] {
  return (sessionState?.chats ?? []).filter((chat) => {
    if (isChatArchived(chat)) return false;
    const root = resolveChatWorktreeRoot(chat);
    return Boolean(root && panelPathsEqual(root, path));
  });
}

/**
 * After a worktree is removed, its chats return to Local explicitly instead
 * of pointing at a missing folder. Returns the names of chats that could not.
 */
export async function detachChatsFromRemovedWorktree(chats: Chat[]): Promise<string[]> {
  const failed: string[] = [];
  for (const chat of chats) {
    const result = await applyChatRunTargetChoice(chat, { kind: 'local' }).catch((error: unknown) => ({
      ok: false, error: error instanceof Error ? error.message : String(error),
    }));
    if (result.ok) touchChat(chat);
    else failed.push(chat.name || 'Untitled chat');
  }
  if (chats.length) scheduleSaveSessions();
  return failed;
}
