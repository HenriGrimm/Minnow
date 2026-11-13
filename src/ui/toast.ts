/**
 * The one notification card. Every transient notice — plain feedback, git
 * errors, saved memories, agent alerts, device requests — renders here, in a
 * single bottom-right stack (bottom-left while the browser is visible).
 * Activity (the bell) keeps the durable record;
 * a card is only a short-lived view.
 */

import { iconHtml, type IconName } from './icon';
import { markPreviewOccluder } from './preview-occlusion';
import { findSettingsLink } from './settings-link';

export type ToastVariant = 'success' | 'error';
export type NotifyTone = 'success' | 'error' | 'attention' | 'info';

export interface NotifyAction {
  label: string;
  variant?: 'primary' | 'danger';
  ariaLabel?: string;
  /** Leave the card up after a successful run, relabelling the button (e.g. "Copied"). */
  keepOpen?: { doneLabel: string };
  /**
   * Runs on click. Resolve to nothing to close the card, to options to swap
   * it for a confirmation in place, or to `false` / throw to keep it open
   * with an inline error.
   */
  run: (handle: NotifyHandle) => void | false | NotifyOptions | Promise<void | false | NotifyOptions>;
}

export interface NotifyOptions {
  tone?: NotifyTone;
  icon?: IconName;
  /** App or subsystem that raised it, e.g. "Source Control". */
  source?: string;
  /** Chat name, branch, issue id… shown after the source. */
  context?: string;
  title?: string;
  message?: string;
  /** Raw output (git stderr, HTTP log) behind a Details toggle. */
  detail?: string;
  /** Extra controls a kind needs (e.g. a device picker). */
  content?: HTMLElement;
  /** Clicking the card body goes to whatever sent it. */
  open?: () => void;
  openLabel?: string;
  actions?: NotifyAction[];
  /** Time on screen; `null` waits for the user. Defaults by tone. */
  durationMs?: number | null;
  /** Same key → one card with a ×N count. */
  dedupeKey?: string;
  onDismiss?: () => void;
}

export interface NotifyHandle {
  readonly element: HTMLElement;
  readonly isOpen: boolean;
  dismiss(): void;
  /** Swap the card's content (e.g. for a confirmation) without moving it. */
  replace(next: NotifyOptions): void;
}

const QUIET_MS = 4000;
const STANDARD_MS = 6000;
const INFO_MS = 5000;
const ERROR_MS = 10_000;
const MAX_VISIBLE = 3;
const PREVIEW_LENGTH = 160;
const AGE_REFRESH_MS = 15_000;

const TONE_ICONS: Record<NotifyTone, IconName> = {
  success: 'check',
  error: 'statusFail',
  attention: 'warning',
  info: 'bell',
};

interface Entry {
  key: string;
  opts: NotifyOptions;
  el: HTMLElement;
  announce: HTMLElement;
  count: number;
  createdAt: number;
  total: number | null;
  remaining: number;
  startedAt: number;
  timer: number | undefined;
  hovered: boolean;
  expanded: boolean;
  busy: boolean;
  closed: boolean;
  previousFocus: HTMLElement | null;
  handle: NotifyHandle;
  /** Repaint the current options (count/age refresh). */
  paint: () => void;
}

const entries = new Map<string, Entry>();
let nextId = 0;
let stackExpanded = false;
let ageTimer: number | undefined;

function defaultDuration(opts: NotifyOptions): number | null {
  if (opts.durationMs !== undefined) return opts.durationMs === null ? null : Math.max(0, opts.durationMs);
  switch (opts.tone ?? 'success') {
    case 'error': return ERROR_MS;
    case 'attention': return null;
    case 'info': return INFO_MS;
    default: return isCompact(opts) ? QUIET_MS : STANDARD_MS;
  }
}

function isCompact(opts: NotifyOptions): boolean {
  return !opts.title && !opts.source && !opts.detail && !opts.content && !(opts.actions?.length);
}

function isLong(text: string): boolean {
  return text.length > PREVIEW_LENGTH || text.includes('\n');
}

function preview(text: string): string {
  return `${text.slice(0, PREVIEW_LENGTH).split('\n')[0]}…`;
}

function formatAge(createdAt: number, now = Date.now()): string {
  const sec = Math.max(0, Math.floor((now - createdAt) / 1000));
  if (sec < 10) return 'now';
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  return min < 60 ? `${min}m` : `${Math.floor(min / 60)}h`;
}

function announcementText(opts: NotifyOptions): string {
  return [opts.title, opts.message].map((part) => part?.trim()).filter(Boolean).join('. ');
}

function getStack(create: boolean): HTMLElement | null {
  let stack = document.querySelector<HTMLElement>('.mn-toast-stack');
  if (!stack && create) {
    stack = document.createElement('section');
    stack.className = 'mn-toast-stack';
    stack.setAttribute('aria-label', 'Notifications');
    // Clicking a card must not close an open Settings or workspace overlay.
    stack.dataset.aboveShellOverlay = '';
    (document.getElementById('mobileShell') ?? document.body).appendChild(stack);
  }
  return stack;
}

function cards(stack: HTMLElement): HTMLElement[] {
  return [...stack.querySelectorAll<HTMLElement>(':scope > .mn-toast')];
}

/**
 * Show the newest few; fold older cards behind a "+N more" pill. Cards that
 * wait on the user fold last, so routine notices cannot bury a question.
 */
function layoutStack(): void {
  const stack = getStack(false);
  if (!stack) return;
  const all = cards(stack);
  if (all.length <= MAX_VISIBLE) stackExpanded = false;
  const hiddenCount = stackExpanded ? 0 : Math.max(0, all.length - MAX_VISIBLE);
  const waits = new Set([...entries.values()].filter((entry) => entry.total === null).map((entry) => entry.el));
  const focused = all.find((card) => card.contains(document.activeElement));
  const candidates = all.filter((card) => card !== focused);
  const foldOrder = [...candidates.filter((card) => !waits.has(card)), ...candidates.filter((card) => waits.has(card))];
  const folded = new Set(foldOrder.slice(0, hiddenCount));
  for (const card of all) card.hidden = folded.has(card);
  let more = stack.querySelector<HTMLButtonElement>(':scope > .mn-toast-more');
  if (hiddenCount > 0) {
    if (!more) {
      more = document.createElement('button');
      more.type = 'button';
      more.className = 'mn-toast-more';
      markPreviewOccluder(more, 'notification');
      more.addEventListener('click', () => {
        const wasFocused = document.activeElement === more;
        const next = cards(stack).find((card) => card.hidden);
        stackExpanded = true;
        layoutStack();
        if (wasFocused) next?.querySelector<HTMLButtonElement>('.mn-toast__dismiss')?.focus();
      });
      stack.prepend(more);
    }
    more.textContent = `+${hiddenCount} more`;
    more.setAttribute('aria-label', `Show ${hiddenCount} more notifications`);
  } else {
    more?.remove();
  }
  for (const entry of entries.values()) restartTimer(entry);
  if (!all.length) {
    stack.remove();
    stopAgeTimer();
  }
}

function stopAgeTimer(): void {
  if (ageTimer === undefined) return;
  document.defaultView?.clearInterval(ageTimer);
  ageTimer = undefined;
}

function startAgeTimer(): void {
  const view = document.defaultView;
  if (ageTimer !== undefined || !view) return;
  ageTimer = view.setInterval(() => {
    for (const entry of entries.values()) {
      const age = entry.el.querySelector('.mn-toast__age');
      if (age) age.textContent = formatAge(entry.createdAt);
    }
  }, AGE_REFRESH_MS);
}

function stopTimer(entry: Entry): void {
  const view = document.defaultView;
  if (entry.timer !== undefined) {
    view?.clearTimeout(entry.timer);
    entry.remaining = Math.max(0, entry.remaining - (Date.now() - entry.startedAt));
  }
  entry.timer = undefined;
}

function paintTimerBar(entry: Entry, running: boolean): void {
  const fill = entry.el.querySelector<HTMLElement>('.mn-toast__timer-fill');
  if (!fill || !entry.total) return;
  fill.style.transition = 'none';
  fill.style.transform = `scaleX(${entry.remaining / entry.total})`;
  if (!running) return;
  void fill.offsetWidth;
  fill.style.transition = `transform ${entry.remaining}ms linear`;
  fill.style.transform = 'scaleX(0)';
}

function restartTimer(entry: Entry): void {
  stopTimer(entry);
  const view = document.defaultView;
  const blocked = entry.total === null
    || entry.hovered
    || entry.expanded
    || entry.busy
    || entry.el.hidden
    || entry.el.contains(document.activeElement);
  if (!view || entry.closed || !entry.el.isConnected || blocked) {
    paintTimerBar(entry, false);
    return;
  }
  entry.startedAt = Date.now();
  entry.timer = view.setTimeout(() => closeEntry(entry, false), entry.remaining);
  paintTimerBar(entry, true);
}

function closeEntry(entry: Entry, byUser: boolean): void {
  if (entry.closed) return;
  entry.closed = true;
  const stack = getStack(false);
  const hadFocus = entry.el.contains(document.activeElement);
  stopTimer(entry);
  entries.delete(entry.key);
  entry.el.remove();
  layoutStack();
  if (hadFocus) {
    const next = stack?.querySelector<HTMLButtonElement>('.mn-toast:not([hidden]) .mn-toast__dismiss');
    if (next) next.focus();
    else if (entry.previousFocus?.isConnected) entry.previousFocus.focus();
  }
  if (byUser) entry.opts.onDismiss?.();
}

function button(className: string, label: string): HTMLButtonElement {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = className;
  node.textContent = label;
  return node;
}

/** First text line plus its ×N repeat badge. */
function withCount(text: HTMLElement, count: HTMLElement): HTMLElement {
  const line = document.createElement('span');
  line.className = 'mn-toast__line';
  line.append(text, count);
  return line;
}

function renderEntry(entry: Entry): void {
  const { opts, el } = entry;
  const tone = opts.tone ?? 'success';
  const compact = isCompact(opts);
  const shown = el.classList.contains('mn-toast--visible');
  el.className = `mn-toast mn-toast--${tone}${compact ? ' mn-toast--compact' : ''}${shown ? ' mn-toast--visible' : ''}`;
  // Each card (not the click-through stack) is what paints over the preview pane.
  markPreviewOccluder(el, 'notification');
  el.setAttribute('aria-label', opts.source ? `${opts.source} notification` : tone === 'error' ? 'Error notification' : 'Notification');
  const assertive = tone === 'error' || tone === 'attention';
  entry.announce.setAttribute('role', assertive ? 'alert' : 'status');
  entry.announce.setAttribute('aria-live', assertive ? 'assertive' : 'polite');

  const icon = document.createElement('span');
  icon.className = 'mn-toast__icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = iconHtml(opts.icon ?? TONE_ICONS[tone], { size: 14 });

  const main = document.createElement('div');
  main.className = 'mn-toast__main';

  const head: HTMLElement = opts.open ? button('mn-toast__open', '') : document.createElement('div');
  if (!opts.open) head.className = 'mn-toast__head';
  if (opts.open) {
    const label = opts.openLabel ?? 'Open';
    const announcement = announcementText(opts).replace(/\.$/, '');
    const destination = label.startsWith('Open ') ? label.slice(5) : '';
    const instruction = destination ? [`Check ${destination}`, label].find(text => announcement.endsWith(text)) : undefined;
    const message = instruction ? announcement.slice(0, -instruction.length).trimEnd().replace(/\.$/, '') : announcement;
    head.setAttribute('aria-label', [message, label].filter(Boolean).join('. '));
    head.addEventListener('click', () => {
      if (entry.busy) return;
      closeEntry(entry, false);
      opts.open?.();
    });
  }

  const count = document.createElement('span');
  count.className = 'mn-toast__count';
  count.hidden = entry.count < 2;
  count.textContent = `×${entry.count}`;
  count.setAttribute('aria-label', `Repeated ${entry.count} times`);

  if (opts.source) {
    const meta = document.createElement('span');
    meta.className = 'mn-toast__meta';
    const source = document.createElement('span');
    source.className = 'mn-toast__source';
    source.textContent = opts.source;
    meta.append(source);
    if (opts.context) {
      const context = document.createElement('span');
      context.className = 'mn-toast__context';
      context.textContent = opts.context;
      meta.append(context);
    }
    if (entry.total === null) {
      const tag = document.createElement('span');
      tag.className = 'mn-toast__tag visually-hidden';
      tag.textContent = 'Needs you';
      meta.append(tag);
    }
    const age = document.createElement('span');
    age.className = 'mn-toast__age';
    age.textContent = formatAge(entry.createdAt);
    meta.append(age);
    head.append(meta);
    startAgeTimer();
  }

  if (opts.title) {
    const title = document.createElement('span');
    title.className = 'mn-toast__title';
    title.textContent = opts.title;
    head.append(withCount(title, count));
  }

  const text = opts.message?.trim() ?? '';
  const long = isLong(text);
  let message: HTMLElement | null = null;
  if (text) {
    message = document.createElement('span');
    message.className = 'mn-toast__message';
    message.id = `mn-toast-message-${++nextId}`;
    message.textContent = long && !entry.expanded ? preview(text) : text;
    head.append(opts.title ? message : withCount(message, count));
  } else if (!opts.title) {
    head.append(count);
  }
  main.append(head);

  let detail: HTMLPreElement | null = null;
  if (opts.detail) {
    detail = document.createElement('pre');
    detail.className = 'mn-toast__detail';
    detail.id = `mn-toast-detail-${++nextId}`;
    detail.textContent = opts.detail;
    detail.hidden = !entry.expanded;
  }
  if (opts.content) main.append(opts.content);

  const error = document.createElement('p');
  error.className = 'mn-toast__error';
  error.setAttribute('role', 'alert');
  error.hidden = true;
  main.append(error);

  const actionButtons: HTMLButtonElement[] = [];
  for (const action of opts.actions ?? []) {
    const node = button(`mn-toast__action${action.variant ? ` mn-toast__action--${action.variant}` : ''}`, action.label);
    if (action.ariaLabel) node.setAttribute('aria-label', action.ariaLabel);
    node.addEventListener('click', () => void runAction(entry, action, node, actionButtons, error));
    actionButtons.push(node);
  }

  const expandable = Boolean(detail) || long;
  const row = document.createElement('div');
  row.className = 'mn-toast__actions';
  row.append(...actionButtons);
  if (expandable) {
    const more = detail ? 'Details' : 'Show more';
    const less = detail ? 'Hide details' : 'Show less';
    const expand = button('mn-toast__expand', entry.expanded ? less : more);
    expand.setAttribute('aria-expanded', String(entry.expanded));
    expand.setAttribute('aria-controls', (detail ?? message)!.id);
    expand.addEventListener('click', () => {
      entry.expanded = !entry.expanded;
      if (detail) detail.hidden = !entry.expanded;
      if (message && long) message.textContent = entry.expanded ? text : preview(text);
      expand.textContent = entry.expanded ? less : more;
      expand.setAttribute('aria-expanded', String(entry.expanded));
      restartTimer(entry);
    });
    main.insertBefore(expand, opts.content ?? error);
    if (detail) expand.after(detail);
  }
  if (row.childElementCount) main.append(row);

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'mn-toast__dismiss';
  close.setAttribute('aria-label', 'Dismiss notification');
  close.innerHTML = iconHtml('close', { size: 14 });
  close.addEventListener('click', () => closeEntry(entry, true));

  const nodes: HTMLElement[] = [entry.announce, icon, main, close];
  if (entry.total) {
    const timer = document.createElement('span');
    timer.className = 'mn-toast__timer';
    timer.setAttribute('aria-hidden', 'true');
    const fill = document.createElement('span');
    fill.className = 'mn-toast__timer-fill';
    timer.append(fill);
    nodes.push(timer);
  }
  el.replaceChildren(...nodes);
}

async function runAction(
  entry: Entry,
  action: NotifyAction,
  clicked: HTMLButtonElement,
  buttons: HTMLButtonElement[],
  error: HTMLElement,
): Promise<void> {
  if (entry.busy || entry.closed) return;
  entry.busy = true;
  restartTimer(entry);
  for (const node of buttons) node.disabled = true;
  entry.el.setAttribute('aria-busy', 'true');
  error.hidden = true;
  const fail = (message: string) => {
    entry.busy = false;
    entry.el.removeAttribute('aria-busy');
    for (const node of buttons) node.disabled = false;
    error.textContent = message;
    error.hidden = false;
    restartTimer(entry);
  };
  try {
    const result = await action.run(entry.handle);
    if (entry.closed) return;
    if (result === false) {
      fail('That did not work. Try again.');
      return;
    }
    entry.busy = false;
    entry.el.removeAttribute('aria-busy');
    if (action.keepOpen && result === undefined) {
      for (const node of buttons) node.disabled = false;
      clicked.textContent = action.keepOpen.doneLabel;
      restartTimer(entry);
    } else if (result && typeof result === 'object') entry.handle.replace(result);
    else closeEntry(entry, false);
  } catch (caught) {
    if (!entry.closed) fail(caught instanceof Error && caught.message ? caught.message : 'That did not work. Try again.');
  }
}

function keyFor(opts: NotifyOptions): string {
  return opts.dedupeKey ?? JSON.stringify([opts.tone ?? 'success', opts.source ?? '', opts.title ?? '', opts.message?.trim() ?? '']);
}

function setOptions(entry: Entry, opts: NotifyOptions): void {
  stopTimer(entry);
  entry.opts = opts;
  entry.total = defaultDuration(opts);
  entry.remaining = entry.total ?? 0;
  entry.expanded = false;
  entry.paint();
}

/** Show a notification card. Returns null when there is nothing to show. */
export function notify(input: NotifyOptions): NotifyHandle | null {
  const opts: NotifyOptions = { ...input, message: input.message?.trim() || undefined, title: input.title?.trim() || undefined };
  if ((!opts.title && !opts.message) || typeof document === 'undefined' || !document.body) return null;
  if (!document.defaultView) return null;
  if (!opts.open) {
    // A named Settings or Models destination can open from the card.
    const link = findSettingsLink(`${opts.title ?? ''} ${opts.message ?? ''}`);
    if (link) {
      opts.open = () => { void import('./settings-page').then((m) => m.openSettings(link.section)); };
      opts.openLabel ??= `Open ${link.label}`;
    }
  }
  for (const [key, entry] of entries) {
    if (!entry.el.isConnected) {
      stopTimer(entry);
      entries.delete(key);
    }
  }
  const key = keyFor(opts);
  const existing = entries.get(key);
  if (existing) {
    stopTimer(existing);
    existing.count += 1;
    existing.createdAt = Date.now();
    existing.remaining = existing.total ?? 0;
    existing.announce.textContent = `${announcementText(existing.opts)} (repeated ${existing.count} times)`;
    const count = existing.el.querySelector<HTMLElement>('.mn-toast__count');
    if (count) {
      count.hidden = false;
      count.textContent = `×${existing.count}`;
      count.setAttribute('aria-label', `Repeated ${existing.count} times`);
    }
    const age = existing.el.querySelector('.mn-toast__age');
    if (age) age.textContent = formatAge(existing.createdAt);
    restartTimer(existing);
    return existing.handle;
  }

  const stack = getStack(true)!;
  const el = document.createElement('div');
  el.setAttribute('role', 'group');
  const announce = document.createElement('span');
  announce.className = 'mn-toast__announcement';
  announce.setAttribute('aria-atomic', 'true');

  const entry = {
    key, opts, el, announce, count: 1, createdAt: Date.now(),
    total: null, remaining: 0, startedAt: 0, timer: undefined,
    hovered: false, expanded: false, busy: false, closed: false,
    previousFocus: document.activeElement as HTMLElement | null,
  } as unknown as Entry;
  entry.paint = () => {
    renderEntry(entry);
    restartTimer(entry);
  };
  entry.handle = {
    element: el,
    get isOpen() { return !entry.closed; },
    dismiss: () => closeEntry(entry, false),
    replace: (next) => {
      if (entry.closed) return;
      entries.delete(entry.key);
      entry.key = keyFor(next);
      entries.set(entry.key, entry);
      entry.count = 1;
      entry.createdAt = Date.now();
      setOptions(entry, next);
      announce.textContent = announcementText(next);
    },
  };
  entry.total = defaultDuration(opts);
  entry.remaining = entry.total ?? 0;
  renderEntry(entry);

  el.addEventListener('mouseenter', () => { entry.hovered = true; restartTimer(entry); });
  el.addEventListener('mouseleave', () => { entry.hovered = false; restartTimer(entry); });
  el.addEventListener('focusin', () => restartTimer(entry));
  el.addEventListener('focusout', () => { queueMicrotask(() => restartTimer(entry)); });
  el.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    closeEntry(entry, true);
  });

  entries.set(key, entry);
  stack.appendChild(el);
  layoutStack();
  // Populate a mounted live region, rather than inserting an already-filled one.
  const reveal = () => {
    if (!el.isConnected) return;
    el.classList.add('mn-toast--visible');
    if (!announce.textContent) announce.textContent = announcementText(entry.opts);
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(reveal);
  else document.defaultView.setTimeout(reveal, 0);
  return entry.handle;
}

/** Plain feedback: a one-line success or an error card. */
export function showToast(
  message: string,
  variant: ToastVariant = 'success',
  durationMs?: number,
): void {
  notify({ tone: variant, message, durationMs });
}

/** Test helper — drop every card and timer. */
export function resetToastsForTests(): void {
  for (const entry of entries.values()) stopTimer(entry);
  entries.clear();
  stackExpanded = false;
  stopAgeTimer();
  getStack(false)?.remove();
}
