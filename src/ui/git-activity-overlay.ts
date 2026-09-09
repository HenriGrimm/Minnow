/**
 * Floating git activity overlay: bouncing progress while an op runs, then a
 * parsed error popover with Send to chat. Success uses the existing toast.
 */

import { parseGitError, splitGitErrorDetails } from '../lib/git-error-parse';
import {
  sendGitErrorToChat,
  type GitErrorChatContext,
  type GitErrorChatKind,
} from './git-error-to-chat';
import {
  registerChromePopover,
  unregisterChromePopover,
} from './preview-electron-visibility';
import { showToast } from './toast';

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
let errorMode = false;
let chromePopoverRegistered = false;
let escapeHandler: ((event: KeyboardEvent) => void) | null = null;

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
  errorMode = false;
  el.classList.remove('mn-git-activity--error');
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
  if (stack.length === 0 || errorMode) return;
  paintProgress(topLabel());
}

function registerErrorChrome(): void {
  if (chromePopoverRegistered) return;
  registerChromePopover();
  chromePopoverRegistered = true;
}

function unregisterErrorChrome(): void {
  if (!chromePopoverRegistered) return;
  unregisterChromePopover();
  chromePopoverRegistered = false;
}

function detachEscape(): void {
  if (!escapeHandler) return;
  document.removeEventListener('keydown', escapeHandler, true);
  escapeHandler = null;
}

function attachEscape(): void {
  detachEscape();
  escapeHandler = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    hideGitActivityOverlay();
  };
  document.addEventListener('keydown', escapeHandler, true);
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

function paintError(options: GitActivityErrorOptions): void {
  const parsed = parseGitError(options.error);
  const chatKind = options.chatKind ?? 'generic';
  const chatCtx: GitErrorChatContext = {
    ...options.ctx,
    title: parsed.title,
    summary: parsed.summary,
  };
  const { preview, rest } = splitGitErrorDetails(parsed.details);

  const el = ensureOverlay();
  errorMode = true;
  el.classList.add('mn-git-activity--error');
  el.setAttribute('role', 'alertdialog');
  el.setAttribute('aria-modal', 'false');
  el.setAttribute('aria-live', 'assertive');
  el.setAttribute('aria-labelledby', 'mnGitActivityErrorTitle');
  el.setAttribute('aria-describedby', 'mnGitActivityErrorSummary');

  const body = document.createElement('div');
  body.className = 'mn-git-activity__body';

  const eyebrow = document.createElement('p');
  eyebrow.className = 'mn-git-activity__eyebrow';
  eyebrow.textContent = 'Git error';

  const title = document.createElement('h2');
  title.className = 'mn-git-activity__title';
  title.id = 'mnGitActivityErrorTitle';
  title.textContent = parsed.title;

  const summary = document.createElement('p');
  summary.className = 'mn-git-activity__summary';
  summary.id = 'mnGitActivityErrorSummary';
  summary.textContent = parsed.summary;

  const details = document.createElement('details');
  details.className = 'mn-git-activity__details';
  const toggle = document.createElement('summary');
  toggle.className = 'mn-git-activity__details-toggle';
  toggle.textContent = 'Details';
  const pre = document.createElement('pre');
  pre.className = 'mn-git-activity__pre';
  pre.textContent = preview;
  details.append(toggle, pre);
  if (rest) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'mn-git-activity__more';
    more.textContent = 'Show more';
    more.addEventListener('click', () => {
      pre.textContent = parsed.details;
      more.remove();
      details.open = true;
    });
    details.appendChild(more);
  }

  body.append(eyebrow, title, summary, details);

  const actions = document.createElement('div');
  actions.className = 'mn-git-activity__actions';

  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'mn-git-activity__button';
  dismiss.textContent = 'Dismiss';
  dismiss.addEventListener('click', () => hideGitActivityOverlay());

  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'mn-git-activity__button';
  copy.textContent = 'Copy';
  copy.addEventListener('click', () => {
    void copyText(parsed.details).then((ok) => {
      copy.textContent = ok ? 'Copied' : 'Copy failed';
    });
  });

  const send = document.createElement('button');
  send.type = 'button';
  send.className = 'mn-git-activity__button mn-git-activity__button--primary';
  send.textContent = 'Send to chat';
  send.title = 'Start a new chat and ask the agent to fix this';
  send.setAttribute('aria-label', 'Send git error to chat');
  send.addEventListener('click', () => {
    hideGitActivityOverlay();
    void sendGitErrorToChat(chatKind, parsed.details, chatCtx);
  });

  actions.append(dismiss, copy, send);
  el.replaceChildren(body, actions);
  visible = true;
  setVisible(el, true);
  registerErrorChrome();
  attachEscape();
  dismiss.focus();
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

  const replacingError = errorMode;
  if (errorMode) {
    detachEscape();
    unregisterErrorChrome();
    errorMode = false;
  }

  const delay = options?.delayMs ?? GIT_ACTIVITY_SHOW_DELAY_MS;
  if (replacingError) {
    clearShowTimer();
    paintProgress(topLabel());
  } else if (stack.length === 1) {
    clearShowTimer();
    if (delay <= 0) {
      showProgressIfNeeded();
    } else {
      showTimer = window.setTimeout(() => {
        showTimer = undefined;
        showProgressIfNeeded();
      }, delay);
    }
  } else if (visible && !errorMode) {
    paintProgress(topLabel());
  }

  return { id };
}

/** Update the label of an in-flight activity (commit → push). */
export function updateGitActivity(handle: GitActivityHandle, label: string): void {
  const item = stack.find((row) => row.id === handle.id);
  if (!item) return;
  item.label = label.trim() || item.label;
  if (visible && !errorMode && stack[stack.length - 1]?.id === handle.id) {
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
    if (visible && !errorMode) paintProgress(topLabel());
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

/** Open the parsed error popover without a matching begin handle (Issues sync, etc.). */
export function showGitErrorPopover(options: GitActivityErrorOptions): void {
  const error = options.error.trim();
  if (!error || error.toLowerCase() === 'cancelled') {
    hideGitActivityOverlay();
    return;
  }
  clearShowTimer();
  clearHideTimer();
  paintError(options);
}

/** Dismiss progress or the error popover. */
export function hideGitActivityOverlay(): void {
  clearShowTimer();
  detachEscape();
  unregisterErrorChrome();
  errorMode = false;
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
  detachEscape();
  unregisterErrorChrome();
  errorMode = false;
  visible = false;
  stack.length = 0;
  nextId = 1;
  overlayEl?.remove();
  overlayEl = null;
}
