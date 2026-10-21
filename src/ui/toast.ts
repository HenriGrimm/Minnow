import { iconHtml } from './icon';

export type ToastVariant = 'success' | 'error';

const DEFAULT_DURATION_MS = 5000;
const PREVIEW_LENGTH = 160;
interface ToastEntry {
  el: HTMLElement;
  count: number;
  repeat: HTMLElement;
  announce: HTMLElement;
  restart: () => void;
  dispose: () => void;
}
const toasts = new Map<string, ToastEntry>();
let nextId = 0;

/** Dismissible feedback. Errors persist; ordinary feedback pauses while being read. */
export function showToast(
  message: string,
  variant: ToastVariant = 'success',
  durationMs = DEFAULT_DURATION_MS,
): void {
  const text = message.trim();
  if (!text || typeof document === 'undefined' || !document.body) return;
  const view = document.defaultView;
  if (!view) return;
  for (const [key, entry] of toasts) {
    if (!entry.el.isConnected) {
      entry.dispose();
      toasts.delete(key);
    }
  }
  const key = JSON.stringify([variant, text]);
  const existing = toasts.get(key);
  if (existing) {
    existing.count += 1;
    existing.repeat.hidden = false;
    existing.repeat.textContent = `×${existing.count}`;
    existing.repeat.setAttribute('aria-label', `Repeated ${existing.count} times`);
    existing.announce.textContent = `${text} (repeated ${existing.count} times)`;
    existing.restart();
    return;
  }

  let stack = document.querySelector<HTMLElement>('.mn-toast-stack');
  if (!stack) {
    stack = document.createElement('section');
    stack.className = 'mn-toast-stack';
    stack.setAttribute('aria-label', 'Notifications');
    document.body.appendChild(stack);
  }
  const el = document.createElement('div');
  el.className = `mn-toast mn-toast--${variant}`;
  el.setAttribute('role', 'group');
  el.setAttribute('aria-label', variant === 'error' ? 'Error notification' : 'Notification');
  const announce = document.createElement('span');
  announce.className = 'mn-toast__announcement';
  announce.setAttribute('role', variant === 'error' ? 'alert' : 'status');
  announce.setAttribute('aria-live', variant === 'error' ? 'assertive' : 'polite');
  announce.setAttribute('aria-atomic', 'true');

  const status = document.createElement('span');
  status.className = 'mn-toast__icon';
  status.setAttribute('aria-hidden', 'true');
  status.innerHTML = iconHtml(variant === 'error' ? 'close' : 'check', { size: 16 });
  const body = document.createElement('div');
  body.className = 'mn-toast__body';
  const heading = document.createElement('div');
  heading.className = 'mn-toast__heading';
  // The live region announces the message; visual status is already on the group.
  heading.setAttribute('aria-hidden', 'true');
  const title = document.createElement('span');
  title.className = 'mn-toast__title';
  title.textContent = variant === 'error' ? 'Something went wrong' : 'Success';
  const content = document.createElement('div');
  content.className = 'mn-toast__message';
  content.id = `mn-toast-message-${++nextId}`;
  const long = text.length > PREVIEW_LENGTH || text.includes('\n');
  const preview = text.slice(0, PREVIEW_LENGTH).split('\n')[0];
  content.textContent = long ? `${preview}…` : text;
  const repeat = document.createElement('span');
  repeat.className = 'mn-toast__count';
  repeat.hidden = true;
  heading.append(title, repeat);
  body.append(heading, content);

  let timer: number | undefined;
  let hovered = false;
  let expanded = false;
  const stopTimer = () => {
    if (timer !== undefined) view.clearTimeout(timer);
    timer = undefined;
  };
  const previousFocus = document.activeElement as HTMLElement | null;
  const dismiss = () => {
    const hadFocus = el.contains(document.activeElement);
    stopTimer();
    toasts.delete(key);
    el.remove();
    if (hadFocus) {
      const next = stack?.querySelector<HTMLButtonElement>('.mn-toast__dismiss');
      if (next) next.focus();
      else if (previousFocus?.isConnected) previousFocus.focus();
    }
    if (!stack?.childElementCount) stack?.remove();
  };
  const restart = () => {
    stopTimer();
    if (!el.isConnected || variant === 'error' || hovered || expanded || el.contains(document.activeElement)) return;
    timer = view.setTimeout(dismiss, Math.max(0, durationMs));
  };
  if (long) {
    const expand = document.createElement('button');
    expand.type = 'button';
    expand.className = 'mn-toast__expand';
    expand.textContent = 'Show more';
    expand.setAttribute('aria-expanded', 'false');
    expand.setAttribute('aria-controls', content.id);
    expand.addEventListener('click', () => {
      expanded = !expanded;
      content.textContent = expanded ? text : `${preview}…`;
      expand.textContent = expanded ? 'Show less' : 'Show more';
      expand.setAttribute('aria-expanded', String(expanded));
      restart();
    });
    body.appendChild(expand);
  }
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'mn-toast__dismiss';
  close.setAttribute('aria-label', 'Dismiss notification');
  close.innerHTML = iconHtml('close', { size: 14 });
  close.addEventListener('click', dismiss);
  el.append(announce, status, body, close);
  stack.appendChild(el);
  el.addEventListener('mouseenter', () => { hovered = true; stopTimer(); });
  el.addEventListener('mouseleave', () => { hovered = false; restart(); });
  el.addEventListener('focusin', stopTimer);
  el.addEventListener('focusout', () => { queueMicrotask(restart); });
  toasts.set(key, { el, count: 1, repeat, announce, restart, dispose: stopTimer });
  // Populate a mounted live region, rather than inserting an already-filled one.
  const reveal = () => {
    if (!el.isConnected) return;
    el.classList.add('mn-toast--visible');
    if (!announce.textContent) announce.textContent = text;
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(reveal);
  else view.setTimeout(reveal, 0);
  restart();
}
