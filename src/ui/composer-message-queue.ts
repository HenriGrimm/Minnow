import {
  getPendingMessageQueue,
  getPendingMessageQueueCount,
  pushQueuedMessageNow,
  removeQueuedMessage,
  setPendingMessageQueueChangedListener,
} from '../chat/message-queue';
import { isChatTurnInProgress } from '../chat/chat-turn-guard';
import { isActiveChatStreaming } from '../chat/streaming-state';
import { getActiveChat } from '../state/sessions';
import { getActiveComposerSurface } from './composer-surface';
import { createIcon, type IconName } from './icon';
import { autoResize } from './input';
import { setStatus } from './status';
import { refreshComposerStreamingAffordance } from './composer-send';
import { syncQueuedTranscript } from './queued-transcript';

const COMPOSER_FOLLOW_UP_PLACEHOLDER = 'Add a follow-up';

const DEFAULT_PLACEHOLDERS: Record<string, string> = {
  msgInput: 'Type a message…',
  chatAppInput: 'Message Minnow…',
  desktopInput: 'What would you like to do today?',
};

let queueCollapsed = false;

interface QueueMountTarget {
  host: HTMLElement;
  before: ChildNode | null;
}

// ── Mount ────────────────────────────────────────────────────────────────────

/** Resolve where the queue strip should mount for the active composer surface. */
export function resolveComposerQueueMount(
  inputEl: HTMLTextAreaElement | null = getActiveComposerSurface().inputEl,
): QueueMountTarget | null {
  if (!inputEl) return null;

  const before =
    inputEl.closest('.input-row') ??
    inputEl.closest('.chat-app-input') ??
    inputEl.closest('.mn-os-desktop-input-row') ??
    inputEl;

  const host = before.parentElement;
  if (!host) return null;
  return { host, before };
}

function mountQueueRoot(root: HTMLElement): void {
  const mount = resolveComposerQueueMount();
  if (!mount) {
    if (root.parentElement !== document.body) {
      document.body.appendChild(root);
    }
    return;
  }

  if (root.parentElement !== mount.host || root.nextSibling !== mount.before) {
    mount.host.insertBefore(root, mount.before);
  }
}

function ensureQueueRoot(): HTMLElement {
  let root = document.getElementById('composerMessageQueue');
  if (!root) {
    root = document.createElement('section');
    root.id = 'composerMessageQueue';
    root.className = 'composer-message-queue hidden';
    root.setAttribute('aria-label', 'Queued follow-up messages');
  }

  mountQueueRoot(root);
  return root;
}

// ── Items ────────────────────────────────────────────────────────────────────

function iconButton(
  className: string,
  label: string,
  iconName: IconName,
  onClick: () => void,
): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = className;
  btn.setAttribute('aria-label', label);
  btn.title = label;
  btn.appendChild(createIcon(iconName, { className: 'composer-message-queue__icon' }));
  btn.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    onClick();
  });
  return btn;
}

function loadQueueItemIntoComposer(text: string): void {
  const { inputEl } = getActiveComposerSurface();
  if (!inputEl) return;
  inputEl.value = text;
  inputEl.focus();
  autoResize(inputEl);
}

function renderQueueItem(item: { id: string; text: string }): HTMLElement {
  const row = document.createElement('div');
  row.className = 'composer-message-queue__item';
  row.dataset.queueId = item.id;

  const status = document.createElement('span');
  status.className = 'composer-message-queue__status';
  status.setAttribute('aria-hidden', 'true');
  row.appendChild(status);

  const text = document.createElement('span');
  text.className = 'composer-message-queue__text';
  text.textContent = item.text;
  text.title = item.text;
  row.appendChild(text);

  const actions = document.createElement('div');
  actions.className = 'composer-message-queue__actions';

  actions.appendChild(
    iconButton('composer-message-queue__action', 'Edit queued message', 'edit', () => {
      const chat = getActiveChat();
      if (!removeQueuedMessage(chat, item.id)) return;
      loadQueueItemIntoComposer(item.text);
      setStatus('ok', 'Edit queued message and send again');
      syncComposerMessageQueue();
    }),
  );

  actions.appendChild(
    iconButton('composer-message-queue__action', 'Push now', 'arrowUp', () => {
      const chat = getActiveChat();
      const result = pushQueuedMessageNow(chat, item.id);
      if (!result) return;
      setStatus(
        'ok',
        result === 'deferred'
          ? 'Compaction will run after this reply'
          : isChatTurnInProgress(chat.id)
            ? 'Steering at next step…'
            : 'Sending queued message…',
      );
      refreshComposerStreamingAffordance();
      syncComposerMessageQueue();
    }),
  );

  actions.appendChild(
    iconButton('composer-message-queue__action', 'Delete queued message', 'trash', () => {
      const chat = getActiveChat();
      if (!removeQueuedMessage(chat, item.id)) return;
      syncComposerMessageQueue();
    }),
  );

  row.appendChild(actions);
  return row;
}

/** Bind after modules finish evaluating. */
function bindQueueChangedListener(): void {
  setPendingMessageQueueChangedListener(() => {
    syncComposerMessageQueue();
  });
}

// ── Sync ─────────────────────────────────────────────────────────────────────

/** Show or hide the queued follow-up strip for the active streaming chat. */
export function syncComposerMessageQueue(): void {
  bindQueueChangedListener();
  if (typeof document === 'undefined') return;

  syncQueuedTranscript();

  let chat;
  try {
    chat = getActiveChat();
  } catch {
    const orphan = document.getElementById('composerMessageQueue');
    orphan?.classList.add('hidden');
    return;
  }

  const root = ensureQueueRoot();
  const count = getPendingMessageQueueCount(chat);
  const show = count > 0;

  root.classList.toggle('hidden', !show);
  if (!show) {
    root.replaceChildren();
    syncComposerFollowUpPlaceholder(false);
    return;
  }

  syncComposerFollowUpPlaceholder(isActiveChatStreaming());

  const header = document.createElement('button');
  header.type = 'button';
  header.className = 'composer-message-queue__header';
  header.setAttribute('aria-expanded', queueCollapsed ? 'false' : 'true');

  const chevron = document.createElement('span');
  chevron.className = 'composer-message-queue__chevron';
  chevron.setAttribute('aria-hidden', 'true');
  chevron.textContent = queueCollapsed ? '▸' : '▾';

  const label = document.createElement('span');
  label.className = 'composer-message-queue__count';
  label.textContent = `${count} Queued`;

  header.append(chevron, label);
  header.addEventListener('click', () => {
    queueCollapsed = !queueCollapsed;
    syncComposerMessageQueue();
  });

  const list = document.createElement('div');
  list.className = 'composer-message-queue__list';
  list.hidden = queueCollapsed;
  list.setAttribute('role', 'list');

  for (const item of getPendingMessageQueue(chat)) {
    list.appendChild(renderQueueItem(item));
  }

  root.replaceChildren(header, list);
}

/** Swap composer placeholder while follow-ups can be queued. */
export function syncComposerFollowUpPlaceholder(streaming: boolean): void {
  const { inputEl } = getActiveComposerSurface();
  if (!inputEl) return;

  const defaultText = DEFAULT_PLACEHOLDERS[inputEl.id] ?? inputEl.placeholder;
  if (!inputEl.dataset.defaultPlaceholder) {
    inputEl.dataset.defaultPlaceholder = defaultText;
  }

  inputEl.placeholder = streaming
    ? COMPOSER_FOLLOW_UP_PLACEHOLDER
    : inputEl.dataset.defaultPlaceholder;
}

/** Reset collapse state when switching chats (optional UX). */
export function resetComposerMessageQueueUi(): void {
  queueCollapsed = false;
}
