import { showToast } from './toast';
import {
  getPendingMessageQueue,
  getPendingMessageQueueCount,
  enqueueComposerMessage,
  pushQueuedMessageNow,
  removeQueuedMessage,
  setPendingMessageQueueChangedListener,
  updateQueuedMessage,
  setQueuedMessageEditing,
  flushPendingMessageQueue,
} from '../chat/message-queue';
import { clearPendingSteer, setSteerEnqueuedListener } from '../chat/steer-message';
import { sendRemoteChatCommand, shouldRelayChat } from '../chat/remote-chat-client';
import { isChatTurnInProgress } from '../chat/chat-turn-guard';
import { getActiveChat } from '../state/sessions';
import { getActiveComposerSurface } from './composer-surface';
import { createIcon, type IconName } from './icon';
import { refreshComposerStreamingAffordance } from './composer-send';
import type { QueuedComposerMessage } from '../types';
import { formatManagedModelSelection } from './managed-chat-model';
import { composerFollowUpPlaceholder } from './composer-shortcuts';

const DEFAULT_PLACEHOLDERS: Record<string, string> = {
  msgInput: 'Ask Minnow to plan, build, or debug…',
  chatAppInput: 'Message Minnow…',
  desktopInput: 'What would you like to do today?',
};

let queueCollapsed = false;
const edits = new Map<string, string>();
const resumeAfterEdit = new Set<string>();

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
    root.setAttribute('aria-label', 'Pending messages');
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

function renderQueueItem(item: Pick<QueuedComposerMessage, 'id' | 'text' | 'modelSelection'>): HTMLElement {
  const chat = getActiveChat();
  const editKey = `${chat.id}:${item.id}`;
  const row = document.createElement('div');
  row.className = 'composer-message-queue__item';
  row.setAttribute('role', 'listitem');
  row.dataset.queueId = item.id;

  if (edits.has(editKey)) {
    row.classList.add('is-editing');
    const editor = document.createElement('textarea');
    editor.className = 'composer-message-queue__editor';
    editor.setAttribute('aria-label', 'Edit queued message');
    editor.dataset.editKey = editKey;
    editor.value = edits.get(editKey)!;
    editor.rows = 3;
    editor.addEventListener('input', () => edits.set(editKey, editor.value));
    const actions = document.createElement('div');
    actions.className = 'composer-message-queue__actions';
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'composer-message-queue__text-action';
    const stillQueued = getPendingMessageQueue(chat).some(entry => entry.id === item.id);
    save.textContent = stillQueued ? 'Save' : 'Send as new message';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'composer-message-queue__text-action';
    cancel.textContent = 'Cancel';
    const finish = () => {
      edits.delete(editKey);
      setQueuedMessageEditing(chat.id, item.id, false);
      syncComposerMessageQueue();
      if (resumeAfterEdit.delete(editKey) && !isChatTurnInProgress(chat.id) && !chat.subAgentAutoResumeBlocked && !chat.turnError) {
        void flushPendingMessageQueue(chat).catch(error => showToast(String(error?.message || error), 'error'));
      }
    };
    cancel.addEventListener('click', finish);
    save.addEventListener('click', async () => {
      const value = editor.value.trim();
      if (!value) { editor.focus(); return; }
      save.disabled = cancel.disabled = editor.disabled = true;
      try {
        if (!stillQueued) {
          if (shouldRelayChat(chat.id)) await sendRemoteChatCommand(chat.id, 'send', { text: value });
          else {
            enqueueComposerMessage(chat, value);
            if (!isChatTurnInProgress(chat.id)) {
              const queued = getPendingMessageQueue(chat).at(-1)!;
              pushQueuedMessageNow(chat, queued.id);
            }
          }
        } else if (shouldRelayChat(chat.id)) await sendRemoteChatCommand(chat.id, 'edit', { itemId: item.id, text: value });
        else if (!updateQueuedMessage(chat, item.id, value)) throw new Error('This message has already been sent. Your edit is kept here.');
        finish();
      } catch (error) {
        showToast(error instanceof Error ? error.message : String(error), 'error');
        save.disabled = cancel.disabled = editor.disabled = false;
        editor.focus();
      }
    });
    editor.addEventListener('keydown', (event) => {
      if (event.isComposing) return;
      if (event.key === 'Escape') { event.preventDefault(); finish(); }
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); save.click(); }
    });
    actions.append(save, cancel);
    if (!stillQueued) {
      const notice = document.createElement('span');
      notice.textContent = 'This message is no longer queued. Your edit is kept below.';
      row.append(notice);
    }
    row.append(editor, actions);
    return row;
  }

  const status = document.createElement('span');
  status.className = 'composer-message-queue__status';
  status.setAttribute('aria-hidden', 'true');
  row.appendChild(status);

  const text = document.createElement('span');
  text.className = 'composer-message-queue__text';
  text.textContent = item.text;
  text.title = item.text;
  const content = document.createElement('div');
  content.className = 'composer-message-queue__content';
  content.append(text);
  if (item.modelSelection) {
    const selection = document.createElement('span');
    selection.className = 'composer-message-queue__model';
    selection.textContent = `Saved model: ${formatManagedModelSelection(item.modelSelection)}`;
    selection.title = `${item.modelSelection.providerId} / ${selection.textContent}`;
    content.append(selection);
  }
  row.append(content);

  const actions = document.createElement('div');
  actions.className = 'composer-message-queue__actions';

  actions.appendChild(
    iconButton('composer-message-queue__action', 'Edit queued message', 'edit', () => {
      edits.set(editKey, item.text);
      setQueuedMessageEditing(chat.id, item.id, true);
      if (isChatTurnInProgress(chat.id)) resumeAfterEdit.add(editKey);
      syncComposerMessageQueue();
      document.querySelector<HTMLTextAreaElement>('.composer-message-queue__editor')?.focus();
    }),
  );

  actions.appendChild(
    iconButton('composer-message-queue__action', isChatTurnInProgress(chat.id) ? 'Steer current run' : 'Send queued message', 'arrowUp', () => {
      const chat = getActiveChat();
      const result = pushQueuedMessageNow(chat, item.id);
      if (!result) return;
      showToast(result === 'deferred'
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
  setSteerEnqueuedListener(() => syncComposerMessageQueue());
}

// ── Sync ─────────────────────────────────────────────────────────────────────

/** Show or hide the queued follow-up strip for the active streaming chat. */
export function syncComposerMessageQueue(): void {
  bindQueueChangedListener();
  if (typeof document === 'undefined') return;

  let chat;
  try {
    chat = getActiveChat();
  } catch {
    const orphan = document.getElementById('composerMessageQueue');
    orphan?.classList.add('hidden');
    return;
  }

  const root = ensureQueueRoot();
  const busy = isChatTurnInProgress(chat.id);
  const count = getPendingMessageQueueCount(chat);
  const pendingSteer = chat.pendingSteerMessage?.trim();
  const orphanEdits = [...edits.keys()].filter(key => key.startsWith(`${chat.id}:`) &&
    !getPendingMessageQueue(chat).some(item => key === `${chat.id}:${item.id}`));
  const show = count > 0 || Boolean(pendingSteer) || orphanEdits.length > 0;

  root.classList.toggle('hidden', !show);
  syncComposerFollowUpPlaceholder(busy);
  const renderKey = JSON.stringify([chat.id, busy, queueCollapsed, pendingSteer, orphanEdits,
    getPendingMessageQueue(chat).map(item => [item.id, item.text, item.modelSelection, edits.get(`${chat.id}:${item.id}`)])]);
  if (root.dataset.renderKey === renderKey) return;
  root.dataset.renderKey = renderKey;
  if (!show) {
    root.replaceChildren();
    return;
  }

  const focused = document.activeElement as HTMLTextAreaElement | null;
  const editKey = focused?.dataset.editKey;
  const selection = editKey ? [focused!.selectionStart, focused!.selectionEnd] : null;

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
  label.textContent = [pendingSteer ? 'Steering at next step' : '', count ? `${count} queued for later` : '', orphanEdits.length ? 'Unsent edit' : ''].filter(Boolean).join(' · ');
  label.setAttribute('role', 'status');
  header.setAttribute('aria-label', label.textContent);
  header.setAttribute('aria-controls', 'composerMessageQueueList');

  header.append(chevron, label);
  header.addEventListener('click', () => {
    queueCollapsed = !queueCollapsed;
    syncComposerMessageQueue();
  });

  const list = document.createElement('div');
  list.className = 'composer-message-queue__list';
  list.id = 'composerMessageQueueList';
  list.hidden = queueCollapsed && !pendingSteer && orphanEdits.length === 0;
  list.setAttribute('role', 'list');

  if (pendingSteer) {
    const row = document.createElement('div');
    row.className = 'composer-message-queue__item composer-message-queue__item--steer';
    row.setAttribute('role', 'listitem');
    const text = document.createElement('span');
    text.className = 'composer-message-queue__text';
    text.textContent = pendingSteer;
    text.title = pendingSteer;
    row.append(text, iconButton('composer-message-queue__action', 'Cancel pending steering', 'close', () => {
      if (shouldRelayChat(chat.id)) {
        void sendRemoteChatCommand(chat.id, 'cancel-steer').catch(error => showToast(String(error?.message || error), 'error'));
      } else clearPendingSteer(chat);
      syncComposerMessageQueue();
    }));
    list.append(row);
  }

  for (const item of getPendingMessageQueue(chat)) {
    if (queueCollapsed) continue;
    list.appendChild(renderQueueItem(item));
  }
  for (const key of orphanEdits) {
    list.append(renderQueueItem({ id: key.slice(chat.id.length + 1), text: edits.get(key)! }));
  }

  root.replaceChildren(header, list);
  if (editKey) {
    const editor = [...root.querySelectorAll<HTMLTextAreaElement>('textarea')].find(el => el.dataset.editKey === editKey);
    editor?.focus();
    if (selection) editor?.setSelectionRange(selection[0], selection[1]);
  }
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
    ? composerFollowUpPlaceholder()
    : inputEl.dataset.defaultPlaceholder;
}

/** Reset collapse state when switching chats (optional UX). */
export function resetComposerMessageQueueUi(): void {
  queueCollapsed = false;
}
