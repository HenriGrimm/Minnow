/**
 * Shared UI runner for git / GitHub actions: bouncing progress, success toast,
 * parsed error popover with Send to chat.
 */

import {
  beginGitActivity,
  finishGitActivityError,
  finishGitActivitySuccess,
  showGitErrorPopover,
  type BeginGitActivityOptions,
} from './git-activity-overlay';
import type { GitErrorChatContext, GitErrorChatKind } from './git-error-to-chat';

export interface GitUiOpResult {
  ok: boolean;
  error?: string;
  conflict?: boolean;
}

export interface RunGitUiOpOptions extends BeginGitActivityOptions {
  /** Progress label shown after the delay (`Pushing…`). Inferred when omitted. */
  label?: string;
  successMessage?: string;
  chatKind?: GitErrorChatKind;
  ctx?: GitErrorChatContext;
  /** Caller will toast success itself. */
  skipSuccessToast?: boolean;
}

function isCancelled(error: string | undefined): boolean {
  return (error ?? '').trim().toLowerCase() === 'cancelled';
}

/** Progress label from a success toast or chat kind. */
export function inferGitUiLabel(successMessage?: string, chatKind?: GitErrorChatKind): string {
  if (chatKind === 'commit') return 'Committing…';
  if (chatKind === 'merge') return 'Merging…';
  if (chatKind === 'push') return 'Pushing…';
  if (chatKind === 'pull') return 'Pulling…';
  if (chatKind === 'fetch') return 'Fetching…';
  if (chatKind === 'checkout') return 'Switching branch…';
  if (chatKind === 'rebase') return 'Rebasing…';
  if (chatKind === 'pr') return 'Working with pull request…';
  if (chatKind === 'github') return 'Syncing with GitHub…';
  const message = successMessage ?? '';
  if (/^Fetched/i.test(message)) return 'Fetching…';
  if (/^Pulled/i.test(message)) return 'Pulling…';
  if (/^Pushed|^Committed and pushed/i.test(message)) return 'Pushing…';
  if (/^Committed/i.test(message)) return 'Committing…';
  if (/Merged /i.test(message)) return 'Merging…';
  if (/Switched|Checked out|Created and checked out/i.test(message)) return 'Switching branch…';
  if (/Staged|Unstaged|Discarded/i.test(message)) return 'Updating files…';
  if (/Cherry-pick/i.test(message)) return 'Cherry-picking…';
  if (/stash|Stash|Popped|Applied stash|Dropped stash/i.test(message)) return 'Updating stash…';
  if (/Worktree|worktree/i.test(message)) return 'Updating worktree…';
  if (/Deleted /i.test(message)) return 'Deleting…';
  if (/Tagged /i.test(message)) return 'Tagging…';
  return 'Working…';
}

/** Send-to-chat kind from a success toast when the caller did not set one. */
export function inferGitUiChatKind(
  successMessage?: string,
  explicit?: GitErrorChatKind,
): GitErrorChatKind {
  if (explicit) return explicit;
  const message = successMessage ?? '';
  if (/^Fetched/i.test(message)) return 'fetch';
  if (/^Pulled/i.test(message)) return 'pull';
  if (/^Pushed|^Committed and pushed/i.test(message)) return 'push';
  if (/^Committed/i.test(message)) return 'commit';
  if (/Merged /i.test(message)) return 'merge';
  if (/Switched|Checked out|Created and checked out/i.test(message)) return 'checkout';
  return 'generic';
}

/** Run a git/forge op with progress overlay and parsed failure popover. */
export async function runGitUiOp<T extends GitUiOpResult>(
  fn: () => Promise<T>,
  options: RunGitUiOpOptions,
): Promise<T> {
  const handle = beginGitActivity(
    options.label || inferGitUiLabel(options.successMessage, options.chatKind),
    { delayMs: options.delayMs },
  );
  try {
    const result = await fn();
    if (!result.ok) {
      if (isCancelled(result.error)) {
        finishGitActivitySuccess(handle);
        return result;
      }
      finishGitActivityError(handle, {
        error: result.error ?? 'Git operation failed',
        chatKind: inferGitUiChatKind(options.successMessage, options.chatKind),
        ctx: options.ctx,
      });
      return result;
    }
    finishGitActivitySuccess(
      handle,
      options.skipSuccessToast ? undefined : options.successMessage,
    );
    return result;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    finishGitActivityError(handle, {
      error,
      chatKind: inferGitUiChatKind(options.successMessage, options.chatKind),
      ctx: options.ctx,
    });
    throw err;
  }
}

/** Show a parsed git/GitHub error popover without an in-flight activity. */
export function showGitUiFailure(
  error: string | undefined,
  options?: { chatKind?: GitErrorChatKind; ctx?: GitErrorChatContext },
): void {
  const text = (error ?? '').trim() || 'Git operation failed';
  if (isCancelled(text)) return;
  showGitErrorPopover({
    error: text,
    chatKind: options?.chatKind ?? 'generic',
    ctx: options?.ctx,
  });
}

/** Build the usual cwd/branch seed context for Send to chat. */
export function gitUiCtx(cwd?: string, branch?: string): GitErrorChatContext {
  return {
    cwd: cwd?.trim() || undefined,
    branch: branch?.trim() || undefined,
  };
}
