import {
  getPendingMessageQueue,
  getPendingMessageQueueCount,
  pushQueuedMessageNow,
  removeQueuedMessage,
} from '../chat/message-queue';
import { isChatTurnInProgress } from '../chat/chat-turn-guard';
import { getActiveChat } from '../state/sessions';
import {
  appendChatTranscriptNode,
  getActiveChatMountElement,
  QUEUED_TRANSCRIPT_ID,
} from './chat-mount';
import { getActiveComposerSurface } from './composer-surface';
import { createIcon, type IconName } from './icon';
import { autoResize } from './input';
import { setStatus } from './status';
import { renderUserMessageBubble } from './user-message-bubble';

function loadQueueItemIntoComposer(text: string): void {
  const { inputEl } = getActiveComposerSurface();
  if (!inputEl) return;
  inputEl.value = text;
  inputEl.focus();
  autoResize(inputEl);
}

function queuedIconButton(
  label: string,
  iconName: IconName,
  onClick: () => void,
): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'queued-transcript__action';
  btn.setAttribute('aria-label', label);
  btn.title = label;
  btn.appendChild(createIcon(iconName, { className: 'queued-transcript__icon' }));
  btn.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    onClick();
  });
  return btn;
}

function renderQueuedTranscriptBubble(item: { id: string; text: string }): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'msg user msg--queued';
  wrap.dataset.queueId = item.id;

  const chip = document.createElement('div');
  chip.className = 'msg-queued-chip';
  chip.textContent = 'Queued';

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  renderUserMessageBubble(bubble, item.text);

  const actions = document.createElement('div');
  actions.className = 'queued-transcript__actions';

  actions.appendChild(
    queuedIconButton('Edit queued message', 'edit', () => {
      const chat = getActiveChat();
      if (!removeQueuedMessage(chat, item.id)) return;
      loadQueueItemIntoComposer(item.text);
      setStatus('ok', 'Edit queued message and send again');
    }),
  );

  actions.appendChild(
    queuedIconButton('Push now', 'arrowUp', () => {
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
      void import('./composer-send').then((m) => m.refreshComposerStreamingAffordance());
    }),
  );

  actions.appendChild(
    queuedIconButton('Delete queued message', 'trash', () => {
      const chat = getActiveChat();
      removeQueuedMessage(chat, item.id);
    }),
  );

  wrap.append(chip, bubble, actions);
  return wrap;
}

function resolveQueuedTranscriptMount(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  const mount = getActiveChatMountElement();
  if (!mount) return null;
  if (mount.isConnected === false) return null;
  return mount;
}

/** Rebuild the queued-follow-up cluster at the tail of the active transcript. */
export function syncQueuedTranscript(): void {
  const mount = resolveQueuedTranscriptMount();
  if (!mount) return;

  const existing = mount.querySelector(`#${QUEUED_TRANSCRIPT_ID}`);
  let chat;
  try {
    chat = getActiveChat();
  } catch {
    existing?.remove();
    return;
  }
  const count = getPendingMessageQueueCount(chat);

  if (count === 0) {
    existing?.remove();
    return;
  }

  const root =
    existing instanceof HTMLElement
      ? existing
      : document.createElement('div');
  if (!existing) {
    root.id = QUEUED_TRANSCRIPT_ID;
    root.className = 'queued-transcript';
    root.setAttribute('aria-label', 'Queued follow-up messages');
    root.setAttribute('role', 'status');
    appendChatTranscriptNode(root, mount);
  }

  root.replaceChildren();
  for (const item of getPendingMessageQueue(chat)) {
    root.appendChild(renderQueuedTranscriptBubble(item));
  }
}
