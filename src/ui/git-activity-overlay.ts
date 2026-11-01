/**
 * Floating git activity overlay: bouncing progress while an op runs. Success
 * and parsed errors (with Send to chat) go out as shared notification cards.
 */

import { parseGitError } from '../lib/git-error-parse';
import {
  sendGitErrorToChat,
  type GitErrorChatContext,
  type GitErrorChatKind,
} from './git-error-to-chat';
import { notify, showToast, type NotifyHandle } from './toast';

/** Wait this long before showing progress so instant ops do not flash. */
export const GIT_ACTIVITY_SHOW_DELAY_MS = 180;

export interface GitActivityHandle {
  id: number;
}

export interface BeginGitActivityOptions {
  delayMs?: number;
}

export interface GitActivityErrorOptions {
  error: string;
  chatKind?: GitErrorChatKind;
  ctx?: GitErrorChatContext;
}

const ROOT_CLASS = 'mn-git-activity';

interface StackItem {
  id: number;
  label: string;
}

let nextId = 1;
const stack: StackItem[] = [];
let overlayEl: HTMLElement | null = null;
let showTimer: number | undefined;
let hideTimer: number | undefined;
let visible = false;

function clearShowTimer(): void {
  if (showTimer === undefined) return;
  window.clearTimeout(showTimer);
  showTimer = undefined;
}

function clearHideTimer(): void {
  if (hideTimer === undefined) return;
  window.clearTimeout(hideTimer);
  hideTimer = undefined;
}

function ensureOverlay(): HTMLElement {
  if (overlayEl?.isConnected) return overlayEl;
  const el = document.createElement('div');
  el.className = ROOT_CLASS;
  el.id = 'mnGitActivityOverlay';
  document.body.appendChild(el);
  overlayEl = el;
  return el;
}

function setVisible(el: HTMLElement, on: boolean): void {
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => el.classList.toggle('mn-git-activity--visible', on));
  } else {
    el.classList.toggle('mn-git-activity--visible', on);
  }
}

function paintProgress(label: string): void {
  const el = ensureOverlay();
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.removeAttribute('aria-modal');

  const body = document.createElement('div');
  body.className = 'mn-git-activity__body';
  const labelEl = document.createElement('p');
  labelEl.className = 'mn-git-activity__label';
  labelEl.textContent = label;
  body.appendChild(labelEl);

  const bar = document.createElement('div');
  bar.className = 'mn-git-activity__bar';
  bar.setAttribute('aria-hidden', 'true');
  const fill = document.createElement('span');
  fill.className = 'mn-git-activity__bar-fill';
  bar.appendChild(fill);

  el.replaceChildren(body, bar);
  visible = true;
  setVisible(el, true);
}

function topLabel(): string {
  return stack[stack.length - 1]?.label ?? 'Working…';
}

function showProgressIfNeeded(): void {
  if (stack.length === 0) return;
  paintProgress(topLabel());
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

let errorCard: NotifyHandle | null = null;

function dismissErrorCard(): void {
  errorCard?.dismiss();
  errorCard = null;
}

function showErrorCard(options: GitActivityErrorOptions): void {
  const parsed = parseGitError(options.error);
  const chatKind = options.chatKind ?? 'generic';
  const chatCtx: GitErrorChatContext = {
    ...options.ctx,
    title: parsed.title,
    summary: parsed.summary,
  };
  const context = [chatKind === 'generic' ? '' : chatKind, options.ctx?.branch ?? ''].filter(Boolean).join(' · ');
  dismissErrorCard();
  errorCard = notify({
    tone: 'error',
    icon: 'gitBranch',
    source: 'Source Control',
    context: context || undefined,
    title: parsed.title,
    message: parsed.summary,
    detail: parsed.details,
    dedupeKey: `git-error:${chatKind}:${parsed.title}:${parsed.details}`,
    open: () => {
      void import('../os/router').then(({ launchApp }) => launchApp('source-control'));
    },
    openLabel: 'Open Source Control',
    actions: [
      {
        label: 'Send to chat',
        variant: 'primary',
        ariaLabel: 'Send git error to chat',
        run: async () => {
          await sendGitErrorToChat(chatKind, parsed.details, chatCtx);
        },
      },
      {
        label: 'Copy',
        keepOpen: { doneLabel: 'Copied' },
        run: async () => {
          if (!(await copyText(parsed.details))) throw new Error('Could not copy to the clipboard.');
        },
      },
    ],
  });
}

function removeFromStack(id: number): void {
  const index = stack.findIndex((item) => item.id === id);
  if (index >= 0) stack.splice(index, 1);
}

/** Start (or nest) a git activity with a bouncing progress label. */
export function beginGitActivity(
  label: string,
  options?: BeginGitActivityOptions,
): GitActivityHandle {
  clearHideTimer();
  const id = nextId++;
  stack.push({ id, label: label.trim() || 'Working…' });

  const delay = options?.delayMs ?? GIT_ACTIVITY_SHOW_DELAY_MS;
  if (stack.length === 1) {
    clearShowTimer();
    if (delay <= 0) {
      showProgressIfNeeded();
    } else {
      showTimer = window.setTimeout(() => {
        showTimer = undefined;
        showProgressIfNeeded();
      }, delay);
    }
  } else if (visible) {
    paintProgress(topLabel());
  }

  return { id };
}

/** Update the label of an in-flight activity (commit → push). */
export function updateGitActivity(handle: GitActivityHandle, label: string): void {
  const item = stack.find((row) => row.id === handle.id);
  if (!item) return;
  item.label = label.trim() || item.label;
  if (visible && stack[stack.length - 1]?.id === handle.id) {
    paintProgress(item.label);
  }
}

function finishHandle(handle: GitActivityHandle): void {
  removeFromStack(handle.id);
  if (stack.length === 0) {
    clearShowTimer();
  }
}

/** Hide progress after success. Optionally shows the existing success toast. */
export function finishGitActivitySuccess(
  handle: GitActivityHandle,
  successMessage?: string,
): void {
  finishHandle(handle);
  if (stack.length > 0) {
    if (visible) paintProgress(topLabel());
    return;
  }
  hideGitActivityOverlay();
  const text = successMessage?.trim();
  if (text) showToast(text, 'success');
}

/** Morph progress into the parsed error popover, or open it if progress never appeared. */
export function finishGitActivityError(
  handle: GitActivityHandle,
  options: GitActivityErrorOptions,
): void {
  finishHandle(handle);
  clearShowTimer();
  stack.length = 0;
  showGitErrorPopover(options);
}

/** Show the parsed git error card without a matching begin handle (Issues sync, etc.). */
export function showGitErrorPopover(options: GitActivityErrorOptions): void {
  hideGitActivityOverlay();
  const error = options.error.trim();
  if (!error || error.toLowerCase() === 'cancelled') return;
  showErrorCard(options);
}

/** Dismiss the progress card. */
export function hideGitActivityOverlay(): void {
  clearShowTimer();
  visible = false;
  stack.length = 0;
  const el = overlayEl;
  if (!el) return;
  el.classList.remove('mn-git-activity--visible');
  clearHideTimer();
  hideTimer = window.setTimeout(() => {
    hideTimer = undefined;
    el.remove();
    if (overlayEl === el) overlayEl = null;
  }, 200);
}

/** Test helper — drop DOM and timers between cases. */
export function resetGitActivityOverlayForTests(): void {
  clearShowTimer();
  clearHideTimer();
  dismissErrorCard();
  visible = false;
  stack.length = 0;
  nextId = 1;
  overlayEl?.remove();
  overlayEl = null;
}
