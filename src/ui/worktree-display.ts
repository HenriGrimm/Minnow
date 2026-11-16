/**
 * Renderer-side worktree titles (MIN-14): {@link worktreeTitle} plus what only
 * the UI knows — which chat owns a checkout and what branch it is on now.
 */

import { isPlaceholderChatName } from '../chat/titles/placeholder';
import {
  worktreeTitle,
  type WorktreeTitleSource,
} from '../lib/worktree-title';
import { getWorkspacePath } from '../state/workspace';
import { chatsBoundToWorktree } from './chat-checkout-guard';
import { getLiveCheckoutBranch } from './sidebar-git-state';

/** Title of the chat that owns `path`: the managing chat first, else the most recent. */
export function worktreeChatTitle(path: string | undefined): string | undefined {
  if (!path?.trim()) return undefined;
  const named = chatsBoundToWorktree(path).filter(
    (chat) => chat.name?.trim() && !isPlaceholderChatName(chat.name),
  );
  if (!named.length) return undefined;
  const owner = named.find((chat) => chat.chatWorktreeManaged)
    ?? [...named].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0]!;
  return owner.name.trim();
}

export interface DisplayWorktreeTitleOptions {
  principalPath?: string;
  workspaceRoot?: string;
  /** Skip the owning-chat lookup (e.g. inside that chat's own composer). */
  ignoreChatTitle?: boolean;
}

/** User-facing title for a checkout, filling in the live branch and owning chat. */
export function displayWorktreeTitle(
  wt: WorktreeTitleSource,
  options: DisplayWorktreeTitleOptions = {},
): string {
  const path = wt.path?.trim() ?? '';
  const branch = wt.branch?.trim() || (path ? getLiveCheckoutBranch(path) ?? undefined : undefined);
  return worktreeTitle({ ...wt, branch }, {
    workspaceRoot: options.workspaceRoot ?? getWorkspacePath().trim(),
    principalPath: options.principalPath,
    chatTitle: options.ignoreChatTitle ? undefined : worktreeChatTitle(path),
  });
}
