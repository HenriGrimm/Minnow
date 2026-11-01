import '../styles/git-recovery.css';
import { parseGitError } from '../lib/git-error-parse';
import type { GitOpResult } from '../state/git-api';
import { createIcon } from './icon';
import { createButton, createIconButton, setButtonBusy } from './components/button';
import { createField, createSelect } from './components/field';
import { openPopover, type PopoverHandle } from './components/popover';
import { worktreePathsEqual as panelPathsEqual } from '../lib/worktree-list-parse';
import { getGitErrorCurrentChat, sendGitErrorToChat, type GitErrorChatContext, type GitErrorChatKind } from './git-error-to-chat';

export interface GitRecoveryFailure {
  error: string;
  kind: GitErrorChatKind;
  ctx: GitErrorChatContext;
}

interface RecoveryPopoverOptions extends GitRecoveryFailure {
  anchor: HTMLElement;
  onOpenFile?: (path: string, cwd?: string) => void;
  onSent?: (chatId: string) => void;
}

let activePopover: PopoverHandle | null = null;

export function closeGitRecoveryPopover(): void {
  activePopover?.close();
  activePopover = null;
}

function textElement(tag: string, className: string, text: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

export function describeGitRecovery({ error, kind, ctx }: GitRecoveryFailure): { title: string; summary: string } {
  const parsed = parseGitError(error);
  const count = ctx.conflictedFiles?.length ?? 0;
  if (kind === 'pr' && parsed.kind === 'conflict' && !ctx.operation) return {
    title: 'Pull request has merge conflicts',
    summary: 'GitHub cannot merge these branches automatically. Resolve the conflicts on the source branch, then recheck the pull request.',
  };
  if (!count && !ctx.operation) return parsed;
  const operation = ctx.operation === 'rebase' ? 'Rebase' : ctx.operation === 'cherry-pick' ? 'Cherry-pick' : kind === 'pull' ? 'Pull' : 'Merge';
  if (!count) return { title: `${operation} ready for review`, summary: 'The conflicted paths are resolved. Review the staged changes before finishing the operation.' };
  return {
    title: ctx.operation ? `${operation} paused by conflicts` : 'Merge conflicts',
    summary: `${count} ${count === 1 ? 'file has' : 'files have'} overlapping changes. Resolve them before ${ctx.operation ? 'continuing the operation' : 'trying again'}.`,
  };
}

/** Shared Minnow popover, also used when GitHub reports conflicts before a merge. */
export function openGitRecoveryPopover(options: RecoveryPopoverOptions): PopoverHandle {
  closeGitRecoveryPopover();
  const ctx = { ...options.ctx, conflictedFiles: options.ctx.conflictedFiles?.slice(), reviewBeforeFinish: true };
  const copy = describeGitRecovery({ ...options, ctx });
  const content = document.createElement('div');
  content.className = 'git-recovery-popover__content';
  const heading = document.createElement('div');
  heading.className = 'git-recovery-popover__heading';
  heading.append(createIcon('gitMerge'), textElement('h2', 'git-recovery-popover__title', copy.title));
  const close = createIconButton({ icon: 'close', label: 'Close recovery details', tooltip: false, size: 'sm', onClick: () => handle.close() });
  heading.append(close);
  content.append(heading, textElement('p', 'git-recovery-popover__summary', copy.summary));
  const branch = [ctx.sourceBranch, ctx.targetBranch].filter(Boolean).join(' → ') || ctx.branch;
  if (branch) content.append(textElement('p', 'git-recovery-popover__branch', branch));
  if (ctx.operation) content.append(textElement('p', 'git-recovery-popover__note', 'The operation is paused in this checkout. Your local work is preserved.'));
  if (ctx.conflictedFiles?.length) {
    const files = document.createElement('div');
    files.className = 'git-recovery-popover__files';
    for (const path of ctx.conflictedFiles) {
      files.append(options.onOpenFile ? createButton({
        label: path, icon: 'fileText', size: 'sm', variant: 'ghost', className: 'git-recovery-popover__file',
        onClick: () => { handle.close(); options.onOpenFile?.(path, ctx.cwd); },
      }) : textElement('p', 'git-recovery-popover__path', path));
    }
    content.append(files);
  }
  const details = document.createElement('details');
  details.className = 'git-recovery-popover__details';
  details.append(textElement('summary', '', 'Technical details'), textElement('pre', '', options.error));
  content.append(details);
  const destination = createSelect({
    ariaLabel: 'Destination chat', size: 'sm', value: 'new',
    options: [{ label: 'New Build chat', value: 'new' }],
  });
  const target = createField({ label: 'Send to', control: destination, hint: 'A Build chat in this checkout.' });
  content.append(target.root);
  const error = textElement('p', 'git-recovery-popover__error', '');
  error.setAttribute('role', 'alert');
  error.hidden = true;
  let currentChatId: string | undefined;
  const send = createButton({
    label: 'Send to chat', icon: 'appChat', variant: 'primary', block: true, disabled: true,
    onClick: () => {
      setButtonBusy(send, true);
      error.hidden = true;
      void sendGitErrorToChat(options.kind, options.error, { ...ctx, title: copy.title, summary: copy.summary },
        destination.value === 'current' ? currentChatId : undefined).then(chatId => {
        options.onSent?.(chatId);
        handle.close();
      }, reason => {
        error.textContent = reason instanceof Error ? reason.message : 'Could not send to chat. Try again.';
        error.hidden = false;
        handle.reposition();
      }).finally(() => setButtonBusy(send, false));
    },
  });
  content.append(error, send, textElement('p', 'git-recovery-popover__note', 'Includes the checkout, branches, conflicted files, and error details.'));
  const handle = openPopover({
    anchor: options.anchor, content, placement: 'bottom-end', className: 'git-recovery-popover',
    ariaLabel: copy.title, initialFocus: close,
    onClose: () => { if (activePopover === handle) activePopover = null; },
  });
  activePopover = handle;
  void getGitErrorCurrentChat(ctx).then(chat => {
    if (!handle.isOpen()) return;
    if (chat) {
      currentChatId = chat.id;
      const option = document.createElement('option');
      option.value = 'current';
      option.textContent = 'Current Build chat';
      destination.insertBefore(option, destination.options[0] ?? null);
      destination.value = 'current';
      target.setHint(`${chat.name} · same checkout`);
    }
    destination.addEventListener('change', () => target.setHint(destination.value === 'current' ? `${chat?.name} · same checkout` : 'New Build chat · same checkout'));
  }).catch(() => {}).finally(() => { if (handle.isOpen()) { send.disabled = false; handle.reposition(); } });
  details.addEventListener('toggle', () => handle.reposition());
  return handle;
}

export function createGitRecoveryNotice(options: {
  onOpenFile: (path: string, cwd?: string) => void;
  onReview: () => void;
}) {
  const root = document.createElement('div');
  root.className = 'git-recovery-notice';
  root.hidden = true;
  root.setAttribute('role', 'status');
  root.setAttribute('aria-live', 'polite');
  const title = textElement('strong', 'git-recovery-notice__title', '');
  const summary = textElement('p', 'git-recovery-notice__summary', '');
  const text = document.createElement('div');
  text.className = 'git-recovery-notice__text';
  text.append(title, summary);
  let failure: GitRecoveryFailure | null = null;
  let sentChatId: string | undefined;
  let key = '';
  const action = createButton({ label: 'Resolve', size: 'sm', variant: 'ghost', onClick: () => {
    if (!failure) return;
    if (failure.ctx.operation === 'merge' && !failure.ctx.conflictedFiles?.length) { options.onReview(); return; }
    if (activePopover?.isOpen() && action.getAttribute('aria-expanded') === 'true') { closeGitRecoveryPopover(); return; }
    open();
  } });
  const linkedChat = createButton({ label: 'Open chat', icon: 'appChat', size: 'sm', variant: 'ghost', onClick: () => {
    if (!sentChatId) return;
    const id = sentChatId;
    void Promise.all([import('./sidebar'), import('../os/router')]).then(async ([{ switchChat }, { navigateToCodeChat }]) => {
      navigateToCodeChat();
      await switchChat(id);
    }).catch(reason => {
      void import('./toast').then(({ showToast }) => showToast(reason instanceof Error ? reason.message : 'Could not open chat', 'error'));
    });
  } });
  linkedChat.hidden = true;
  const actions = document.createElement('div');
  actions.className = 'git-recovery-notice__actions';
  actions.append(action, linkedChat);
  root.append(createIcon('gitMerge'), text, actions);
  function open(): void {
    if (!failure) return;
    const captured = failure;
    openGitRecoveryPopover({ ...captured, anchor: action, onOpenFile: options.onOpenFile, onSent: chatId => {
      if (failure !== captured) return;
      sentChatId = chatId;
      summary.textContent = 'Sent to chat. Conflict status updates from this checkout.';
      linkedChat.hidden = false;
    } });
  }
  function render(): void {
    if (!failure) { root.hidden = true; return; }
    const copy = describeGitRecovery(failure);
    title.textContent = copy.title;
    summary.textContent = sentChatId ? 'Sent to chat. Conflict status updates from this checkout.' : copy.summary;
    action.querySelector('.mn-btn__label')!.textContent = failure.ctx.operation === 'merge' && !failure.ctx.conflictedFiles?.length ? 'Review' : failure.ctx.conflictedFiles?.length || parseGitError(failure.error).kind === 'conflict' ? 'Resolve' : 'Details';
    root.hidden = false;
    linkedChat.hidden = !sentChatId;
  }
  function clear(): void {
    closeGitRecoveryPopover();
    failure = null;
    sentChatId = undefined;
    linkedChat.hidden = true;
    key = '';
    root.hidden = true;
  }
  return {
    root,
    open,
    clear,
    close: closeGitRecoveryPopover,
    showFailure(value: GitRecoveryFailure, showPopover = true): void {
      closeGitRecoveryPopover();
      failure = value;
      sentChatId = undefined;
      render();
      if (showPopover) open();
    },
    sync(status: GitOpResult, ctx: GitErrorChatContext): void {
      if (failure && (!panelPathsEqual(failure.ctx.cwd ?? '', ctx.cwd ?? '') || failure.ctx.branch !== ctx.branch)) clear();
      const paths = status.conflicted?.map(file => file.path) ?? [];
      const nextKey = JSON.stringify([ctx.cwd, ctx.branch, paths, status.operation]);
      if (nextKey === key) return;
      key = nextKey;
      if (paths.length || status.operation) {
        const previous = failure;
        failure = {
          error: previous?.error ?? (paths.length ? 'Git reports merge conflicts in this checkout.' : `A ${status.operation} is in progress.`),
          kind: previous?.kind ?? (status.operation === 'rebase' ? 'rebase' : 'merge'),
          ctx: { ...ctx, conflictedFiles: paths, operation: status.operation, reviewBeforeFinish: true },
        };
        closeGitRecoveryPopover();
        render();
      } else if (failure?.ctx.operation || failure?.ctx.conflictedFiles?.length) {
        clear();
      }
    },
  };
}
