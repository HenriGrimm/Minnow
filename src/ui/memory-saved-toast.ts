import type { BrainPage } from '../brain/types';
import type { MemoryEntryMeta } from '../memory/types';
import { createIcon } from './icon';
import { showToast } from './toast';
import { registerChromePopover, unregisterChromePopover } from './preview-electron-visibility';

const DEFAULT_DURATION_MS = 10_000;
const PROGRESS_INTERVAL_MS = 50;
const DESCRIPTION_MAX_LENGTH = 160;

export type MemorySavedTarget =
  | { kind: 'page'; relPath: string }
  | { kind: 'memory'; id: string };

export interface MemorySavedPayload {
  title: string;
  description: string;
  target: MemorySavedTarget;
}

export interface MemorySavedToastOptions {
  durationMs?: number;
  onOpen?: (payload: MemorySavedPayload) => void | Promise<void>;
  onReject?: (payload: MemorySavedPayload) => boolean | void | Promise<boolean | void>;
}

interface QueuedMemorySavedToast {
  token: symbol;
  payload: MemorySavedPayload;
  options: MemorySavedToastOptions;
}

interface ActiveMemorySavedToast extends QueuedMemorySavedToast {
  element: HTMLElement;
  intervalId: number;
  remainingMs: number;
  resumedAt: number;
  paused: boolean;
  busy: boolean;
}

const queuedToasts: QueuedMemorySavedToast[] = [];
let activeToast: ActiveMemorySavedToast | null = null;
const mountedToastRemovers = new Map<HTMLElement, () => void>();

/** Convert markdown-like memory content into a compact plain-text description. */
export function memorySavedDescription(text: unknown, fallback = 'Saved to Brain.'): string {
  if (typeof text !== 'string') {
    return fallback;
  }

  const normalized = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^[\s>#*`~_-]+/gm, '')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) {
    return fallback;
  }
  if (normalized.length <= DESCRIPTION_MAX_LENGTH) {
    return normalized;
  }
  return `${normalized.slice(0, DESCRIPTION_MAX_LENGTH - 1).trimEnd()}…`;
}

/** Build a card payload from the canonical Brain page response. */
export function memorySavedPayloadFromBrainPage(page: BrainPage): MemorySavedPayload {
  return {
    title: page.meta.title || 'Untitled memory',
    description: memorySavedDescription(page.meta.summary || page.body),
    target: { kind: 'page', relPath: page.path },
  };
}

/** Build a card payload from a legacy memory entry and its submitted body. */
export function memorySavedPayloadFromEntry(
  entry: MemoryEntryMeta,
  body: string,
): MemorySavedPayload {
  return {
    title: entry.title || 'Untitled memory',
    description: memorySavedDescription(body),
    target: { kind: 'memory', id: entry.id },
  };
}

function readStringArg(args: unknown, key: string): string {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return '';
  }
  const value = (args as Record<string, unknown>)[key];
  return typeof value === 'string' ? value.trim() : '';
}

/** Parse successful memory tool output into a card payload. */
export function memorySavedPayloadFromTool(
  toolName: string,
  args: unknown,
  result: string,
): MemorySavedPayload | null {
  if (result.trimStart().startsWith('Error')) {
    return null;
  }

  const id = result.match(/\(id:\s*([0-9a-f-]{36})\)/i)?.[1];
  if (!id) {
    return null;
  }

  const title = readStringArg(args, 'title') || 'Untitled memory';
  const description = memorySavedDescription(
    readStringArg(args, 'summary') || readStringArg(args, 'body'),
  );

  if (toolName === 'save_memory' && result.startsWith('Saved memory')) {
    return {
      title,
      description,
      target: { kind: 'memory', id },
    };
  }

  if (toolName === 'brain_write_page' && /^(Created|Updated) wiki page/.test(result)) {
    const relPath = readStringArg(args, 'path').replace(/\\/g, '/');
    if (!relPath) {
      return null;
    }
    return {
      title,
      description,
      target: { kind: 'page', relPath },
    };
  }

  return null;
}

async function openSavedMemory(payload: MemorySavedPayload): Promise<void> {
  const { openBrain, openBrainEditForPath } = await import('./brain-page');
  if (payload.target.kind === 'page') {
    openBrainEditForPath(payload.target.relPath);
    return;
  }
  openBrain('memories');
}

async function rejectSavedMemory(payload: MemorySavedPayload): Promise<boolean> {
  if (payload.target.kind === 'memory') {
    const { deleteMemoryEntry } = await import('../memory/client');
    return deleteMemoryEntry(payload.target.id);
  }

  const { deleteBrainPage } = await import('../brain/client');
  const result = await deleteBrainPage(payload.target.relPath);
  return result.ok;
}

function updateProgress(toast: ActiveMemorySavedToast): void {
  const durationMs = Math.max(1, toast.options.durationMs ?? DEFAULT_DURATION_MS);
  const elapsedMs = toast.paused ? 0 : Date.now() - toast.resumedAt;
  const remainingMs = Math.max(0, toast.remainingMs - elapsedMs);
  const progress = remainingMs / durationMs;
  toast.element.style.setProperty('--memory-saved-progress', String(progress));

  if (remainingMs > 0 || toast.paused || toast.busy) {
    return;
  }
  dismissActiveToast(toast.token);
}

function pauseActiveToast(toast: ActiveMemorySavedToast): void {
  if (toast.paused || toast.busy) {
    return;
  }
  toast.remainingMs = Math.max(0, toast.remainingMs - (Date.now() - toast.resumedAt));
  toast.paused = true;
  updateProgress(toast);
}

function resumeActiveToast(toast: ActiveMemorySavedToast): void {
  if (!toast.paused || toast.busy) {
    return;
  }
  toast.paused = false;
  toast.resumedAt = Date.now();
  updateProgress(toast);
}

function dismissActiveToast(token: symbol): void {
  if (!activeToast || activeToast.token !== token) {
    return;
  }

  const toast = activeToast;
  activeToast = null;
  window.clearInterval(toast.intervalId);
  toast.element.classList.remove('memory-saved-toast--visible');
  const remove = mountedToastRemovers.get(toast.element);
  const onExitTransitionEnd = (event: TransitionEvent): void => {
    if (event.target !== toast.element) return;
    toast.element.removeEventListener('transitionend', onExitTransitionEnd);
    remove?.();
  };
  toast.element.addEventListener('transitionend', onExitTransitionEnd);
  window.setTimeout(() => remove?.(), 250);
  window.setTimeout(renderNextToast, 180);
}

function buildToastElement(item: QueuedMemorySavedToast): HTMLElement {
  const card = document.createElement('section');
  card.className = 'memory-saved-toast';
  card.setAttribute('role', 'status');
  card.setAttribute('aria-live', 'polite');
  card.setAttribute('aria-atomic', 'true');

  const body = document.createElement('div');
  body.className = 'memory-saved-toast__body';

  const status = document.createElement('div');
  status.className = 'memory-saved-toast__status';

  const icon = document.createElement('span');
  icon.className = 'memory-saved-toast__icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.append(createIcon('check', { size: 14 }));

  const eyebrow = document.createElement('span');
  eyebrow.className = 'memory-saved-toast__label';
  eyebrow.textContent = 'Memory saved';

  const title = document.createElement('strong');
  title.className = 'memory-saved-toast__title';
  title.textContent = item.payload.title;

  const description = document.createElement('p');
  description.className = 'memory-saved-toast__description';
  description.textContent = item.payload.description;

  const error = document.createElement('p');
  error.className = 'memory-saved-toast__error';
  error.setAttribute('aria-live', 'assertive');

  status.append(icon, eyebrow);
  body.append(status, title, description, error);

  const footer = document.createElement('div');
  footer.className = 'memory-saved-toast__footer';

  const actions = document.createElement('div');
  actions.className = 'memory-saved-toast__actions';

  const rejectButton = document.createElement('button');
  rejectButton.type = 'button';
  rejectButton.className =
    'memory-saved-toast__button memory-saved-toast__button--reject';
  rejectButton.textContent = 'Reject';

  const openButton = document.createElement('button');
  openButton.type = 'button';
  openButton.className = 'memory-saved-toast__button memory-saved-toast__button--open';
  openButton.textContent = 'Open memory';

  actions.append(rejectButton, openButton);

  const progress = document.createElement('div');
  progress.className = 'memory-saved-toast__progress';
  progress.setAttribute('aria-hidden', 'true');
  const progressFill = document.createElement('span');
  progressFill.className = 'memory-saved-toast__progress-fill';
  progress.append(progressFill);

  footer.append(actions, progress);
  card.append(body, footer);

  rejectButton.addEventListener('click', () => {
    const current = activeToast;
    if (!current || current.token !== item.token || current.busy) {
      return;
    }

    pauseActiveToast(current);
    current.busy = true;
    rejectButton.disabled = true;
    openButton.disabled = true;
    rejectButton.textContent = 'Rejecting…';
    error.textContent = '';

    void (async () => {
      try {
        const result = item.options.onReject
          ? await item.options.onReject(item.payload)
          : await rejectSavedMemory(item.payload);
        if (result === false) {
          throw new Error('Could not reject this memory. Try again.');
        }
        dismissActiveToast(item.token);
        showToast('Memory rejected', 'success');
      } catch (caught) {
        error.textContent =
          caught instanceof Error ? caught.message : 'Could not reject this memory. Try again.';
        rejectButton.disabled = false;
        openButton.disabled = false;
        rejectButton.textContent = 'Reject';
        current.busy = false;
        current.paused = false;
        current.resumedAt = Date.now();
      }
    })();
  });

  openButton.addEventListener('click', () => {
    if (!activeToast || activeToast.token !== item.token || activeToast.busy) {
      return;
    }
    dismissActiveToast(item.token);
    if (item.options.onOpen) {
      void item.options.onOpen(item.payload);
      return;
    }
    openSavedMemory(item.payload);
  });

  card.addEventListener('pointerenter', () => {
    if (activeToast?.token === item.token) {
      pauseActiveToast(activeToast);
    }
  });
  card.addEventListener('pointerleave', () => {
    if (activeToast?.token === item.token && !card.contains(document.activeElement)) {
      resumeActiveToast(activeToast);
    }
  });
  card.addEventListener('focusin', () => {
    if (activeToast?.token === item.token) {
      pauseActiveToast(activeToast);
    }
  });
  card.addEventListener('focusout', () => {
    window.setTimeout(() => {
      if (activeToast?.token === item.token && !card.contains(document.activeElement)) {
        resumeActiveToast(activeToast);
      }
    });
  });

  return card;
}

function renderNextToast(): void {
  if (activeToast || queuedToasts.length === 0) {
    return;
  }

  const next = queuedToasts.shift();
  if (!next) {
    return;
  }

  const element = buildToastElement(next);
  const durationMs = Math.max(1, next.options.durationMs ?? DEFAULT_DURATION_MS);
  const toast: ActiveMemorySavedToast = {
    ...next,
    element,
    intervalId: 0,
    remainingMs: durationMs,
    resumedAt: Date.now(),
    paused: false,
    busy: false,
  };
  activeToast = toast;
  registerChromePopover();
  mountedToastRemovers.set(element, () => {
    if (!mountedToastRemovers.delete(element)) return;
    element.remove();
    unregisterChromePopover();
  });
  document.body.append(element);
  requestAnimationFrame(() => element.classList.add('memory-saved-toast--visible'));
  toast.intervalId = window.setInterval(() => updateProgress(toast), PROGRESS_INTERVAL_MS);
  toast.resumedAt = Date.now();
  updateProgress(toast);
}

/** Queue a memory saved card. */
export function showMemorySavedToast(
  payload: MemorySavedPayload,
  options: MemorySavedToastOptions = {},
): () => void {
  const payloadSnapshot: MemorySavedPayload = {
    title: payload.title,
    description: payload.description,
    target: { ...payload.target },
  };
  const item: QueuedMemorySavedToast = {
    token: Symbol('memory-saved-toast'),
    payload: payloadSnapshot,
    options,
  };
  queuedToasts.push(item);
  renderNextToast();

  return () => {
    if (activeToast?.token === item.token) {
      dismissActiveToast(item.token);
      return;
    }
    const index = queuedToasts.findIndex((queued) => queued.token === item.token);
    if (index >= 0) {
      queuedToasts.splice(index, 1);
    }
  };
}

/** Show a card only when the completed tool result confirms a successful save. */
export function notifyMemorySavedFromTool(
  toolName: string,
  args: unknown,
  result: string,
): void {
  const payload = memorySavedPayloadFromTool(toolName, args, result);
  if (payload) {
    showMemorySavedToast(payload);
  }
}

/** Clear global card state during teardown and deterministic tests. */
export function dismissAllMemorySavedToasts(): void {
  queuedToasts.length = 0;
  if (activeToast) dismissActiveToast(activeToast.token);
  for (const remove of mountedToastRemovers.values()) remove();
}
