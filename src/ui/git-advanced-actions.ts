import { appAlert, appConfirm, appPrompt } from './app-dialog';
/**
 * Advanced git action dialogs: merge, rebase, stash, cherry-pick (Git Center lightbox).
 */

import {
  gitCherryPick,
  gitMerge,
  gitRebase,
  gitStashApply,
  gitStashDrop,
  gitStashList,
  gitStashPop,
  gitStashPush,
  type GitOpResult,
} from '../state/git-api';
import { inferGitUiLabel, runGitUiOp, showGitUiFailure } from './git-ui-op';
import { showToast } from './toast';
import {
  appendGitErrorSendToChatButton,
  type GitErrorChatContext,
} from './git-error-to-chat';

export interface AdvancedGitContext {
  cwd?: string;
  onSuccess: () => void;
  onConflict?: (message: string, kind: 'merge' | 'rebase' | 'cherry-pick' | 'stash') => void;
  /** Branch context for Send to chat seeds. */
  branch?: string;
}

function gitErrorChatContext(ctx: AdvancedGitContext): GitErrorChatContext {
  return { cwd: ctx.cwd, branch: ctx.branch };
}

// ── Alerts ───────────────────────────────────────────────────────────────────

/** Show inline conflict alert with abort/continue actions. */
export function renderConflictAlert(
  host: HTMLElement,
  kind: 'merge' | 'rebase' | 'cherry-pick' | 'stash',
  message: string,
  ctx: AdvancedGitContext,
): void {
  host.replaceChildren();
  const alert = document.createElement('div');
  alert.className = 'git-center-conflict';
  alert.setAttribute('role', 'alert');
  const title = document.createElement('p');
  title.className = 'git-center-conflict__title';
  title.textContent = `${kind === 'stash' ? 'Stash apply' : kind.charAt(0).toUpperCase() + kind.slice(1)} conflict`;
  const body = document.createElement('pre');
  body.className = 'git-center-conflict__body';
  body.textContent = message;
  const actions = document.createElement('div');
  actions.className = 'git-center-conflict__actions';
  if (kind !== 'stash') {
    const abortBtn = document.createElement('button');
    abortBtn.type = 'button';
    abortBtn.className = 'git-panel-action-btn';
    abortBtn.textContent = 'Abort';
    abortBtn.addEventListener('click', () => {
      void runAdvancedOp(
        () => {
          if (kind === 'merge') return gitMerge({ abort: true, cwd: ctx.cwd });
          if (kind === 'rebase') return gitRebase({ abort: true, cwd: ctx.cwd });
          return gitCherryPick({ abort: true, cwd: ctx.cwd });
        },
        ctx,
        host,
        kind,
      );
    });
    actions.appendChild(abortBtn);
    if (kind === 'rebase' || kind === 'cherry-pick') {
      const contBtn = document.createElement('button');
      contBtn.type = 'button';
      contBtn.className = 'git-panel-action-btn git-panel-action-btn--primary';
      contBtn.textContent = 'Continue';
      contBtn.addEventListener('click', () => {
        void runAdvancedOp(
          () => {
            if (kind === 'rebase') return gitRebase({ continue: true, cwd: ctx.cwd });
            return gitCherryPick({ continue: true, cwd: ctx.cwd });
          },
          ctx,
          host,
          kind,
        );
      });
      actions.appendChild(contBtn);
    }
  }
  if (kind === 'merge') {
    appendGitErrorSendToChatButton(actions, 'merge', message, gitErrorChatContext(ctx));
  }
  alert.append(title, body, actions);
  host.appendChild(alert);
}

/** Inline merge failure (non-conflict) with Send to chat. */
export function renderMergeErrorAlert(
  host: HTMLElement,
  message: string,
  ctx: AdvancedGitContext,
): void {
  host.replaceChildren();
  const alert = document.createElement('div');
  alert.className = 'git-center-conflict';
  alert.setAttribute('role', 'alert');
  const title = document.createElement('p');
  title.className = 'git-center-conflict__title';
  title.textContent = 'Merge failed';
  const body = document.createElement('pre');
  body.className = 'git-center-conflict__body';
  body.textContent = message;
  const actions = document.createElement('div');
  actions.className = 'git-center-conflict__actions';
  appendGitErrorSendToChatButton(actions, 'merge', message, gitErrorChatContext(ctx));
  alert.append(title, body, actions);
  host.appendChild(alert);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function runAdvancedOp(
  fn: () => Promise<GitOpResult>,
  ctx: AdvancedGitContext,
  conflictHost: HTMLElement,
  conflictKind: 'merge' | 'rebase' | 'cherry-pick' | 'stash' = 'rebase',
): Promise<void> {
  const result = await runGitUiOp(fn, {
    label: inferGitUiLabel(undefined, conflictKind === 'rebase' ? 'rebase' : conflictKind === 'merge' ? 'merge' : 'generic'),
    successMessage: 'Operation completed',
    chatKind: conflictKind === 'rebase' ? 'rebase' : conflictKind === 'merge' ? 'merge' : 'generic',
    ctx: gitErrorChatContext(ctx),
  });
  if (!result.ok) {
    const err = result.error ?? 'Operation failed';
    if (result.conflict) {
      renderConflictAlert(conflictHost, conflictKind, err, ctx);
      ctx.onConflict?.(err, conflictKind);
    }
    return;
  }
  conflictHost.replaceChildren();
  ctx.onSuccess();
}

async function pickBranch(branches: string[], prompt: string): Promise<string | null> {
  const value = await appPrompt(prompt, branches[0] ?? '');
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed || null;
}

// ── Dialogs ──────────────────────────────────────────────────────────────────

/** Open merge target picker and run merge. */
export async function openMergeDialog(
  branches: string[],
  ctx: AdvancedGitContext,
  conflictHost: HTMLElement,
): Promise<void> {
  const branch = await pickBranch(branches, 'Merge branch into current:');
  if (!branch) return;
  const noFf = await appConfirm('Use --no-ff (always create merge commit)?');
  const result = await runGitUiOp(
    () => gitMerge({ branch, noFf, cwd: ctx.cwd }),
    {
      label: 'Merging…',
      successMessage: `Merged ${branch}`,
      chatKind: 'merge',
      ctx: gitErrorChatContext(ctx),
    },
  );
  if (!result.ok) {
    const err = result.error ?? 'Merge failed';
    if (result.conflict) {
      renderConflictAlert(conflictHost, 'merge', err, ctx);
      ctx.onConflict?.(err, 'merge');
      return;
    }
    renderMergeErrorAlert(conflictHost, err, ctx);
    return;
  }
  ctx.onSuccess();
}

/** Open rebase onto picker. */
export async function openRebaseDialog(
  branches: string[],
  ctx: AdvancedGitContext,
  conflictHost: HTMLElement,
): Promise<void> {
  const onto = await pickBranch(branches, 'Rebase current branch onto:');
  if (!onto) return;
  const result = await runGitUiOp(() => gitRebase({ onto, cwd: ctx.cwd }), {
    label: 'Rebasing…',
    successMessage: `Rebased onto ${onto}`,
    chatKind: 'rebase',
    ctx: gitErrorChatContext(ctx),
  });
  if (!result.ok) {
    const err = result.error ?? 'Rebase failed';
    if (result.conflict) {
      renderConflictAlert(conflictHost, 'rebase', err, ctx);
      ctx.onConflict?.(err, 'rebase');
    }
    return;
  }
  ctx.onSuccess();
}

/** Stash push with optional message. */
export async function openStashPushDialog(ctx: AdvancedGitContext): Promise<void> {
  const message = await appPrompt('Stash message (optional):', '');
  if (message === null) return;
  const result = await runGitUiOp(
    () => gitStashPush({ message: message.trim() || undefined, cwd: ctx.cwd }),
    {
      label: 'Stashing…',
      successMessage: 'Changes stashed',
      ctx: gitErrorChatContext(ctx),
    },
  );
  if (!result.ok) return;
  ctx.onSuccess();
}

/** Stash list menu: pop, apply, or drop. */
export async function openStashMenuDialog(
  ctx: AdvancedGitContext,
  conflictHost: HTMLElement,
): Promise<void> {
  const list = await gitStashList(ctx.cwd);
  if (!list.ok) {
    showGitUiFailure(list.error ?? 'Could not list stashes', {
      ctx: gitErrorChatContext(ctx),
    });
    return;
  }
  const stashes = list.stashes ?? [];
  if (stashes.length === 0) {
    showToast('No stashes', 'success');
    return;
  }
  const menu = stashes.map((s, i) => `${i}: ${s}`).join('\n');
  const pick = await appPrompt(`Stash index and action (pop/apply/drop):\n${menu}\n\nEnter e.g. "0 pop":`, '0 pop');
  if (!pick) return;
  const match = pick.trim().match(/^(\d+)\s+(pop|apply|drop)$/i);
  if (!match) {
    showToast('Use format: 0 pop', 'error');
    return;
  }
  const index = Number(match[1]);
  const action = match[2].toLowerCase();
  let result: GitOpResult;
  if (action === 'pop') result = await runGitUiOp(() => gitStashPop({ index, cwd: ctx.cwd }), {
    label: 'Applying stash…',
    successMessage: `Stash ${action} completed`,
    ctx: gitErrorChatContext(ctx),
  });
  else if (action === 'apply') result = await runGitUiOp(() => gitStashApply({ index, cwd: ctx.cwd }), {
    label: 'Applying stash…',
    successMessage: `Stash ${action} completed`,
    ctx: gitErrorChatContext(ctx),
  });
  else result = await runGitUiOp(() => gitStashDrop({ index, cwd: ctx.cwd }), {
    label: 'Dropping stash…',
    successMessage: `Stash ${action} completed`,
    ctx: gitErrorChatContext(ctx),
  });
  if (!result.ok) {
    const err = result.error ?? 'Stash operation failed';
    if (result.conflict) {
      renderConflictAlert(conflictHost, 'stash', err, ctx);
      ctx.onConflict?.(err, 'stash');
    }
    return;
  }
  ctx.onSuccess();
}

/** Cherry-pick a commit SHA. */
export async function openCherryPickDialog(
  ctx: AdvancedGitContext,
  conflictHost: HTMLElement,
  presetSha?: string,
): Promise<void> {
  const sha = presetSha ?? await appPrompt('Cherry-pick commit SHA:', '');
  if (!sha?.trim()) return;
  const result = await runGitUiOp(() => gitCherryPick({ sha: sha.trim(), cwd: ctx.cwd }), {
    label: 'Cherry-picking…',
    successMessage: 'Cherry-pick completed',
    ctx: gitErrorChatContext(ctx),
  });
  if (!result.ok) {
    const err = result.error ?? 'Cherry-pick failed';
    if (result.conflict) {
      renderConflictAlert(conflictHost, 'cherry-pick', err, ctx);
      ctx.onConflict?.(err, 'cherry-pick');
    }
    return;
  }
  ctx.onSuccess();
}
