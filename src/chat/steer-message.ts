import type { Chat, QueuedComposerMessage, UserMessage } from '../types';
import type { Attachment } from '../attachments/types';
import { attachmentImageDataUrl } from '../attachments/attachment-image';
import { randomUUID } from '../lib/random-id';
import { buildHistoryUserContent, persistableUserImages } from './build-api-messages';
import {
  recordChatMessage,
  scheduleSaveSessions,
  touchChat,
} from '../state/sessions';
import { isStreamDomVisible } from './streaming-state';
import { appendBubble, syncPendingTranscriptMessages } from '../ui/messages';
import { scrollChatIfPinned, scrollChatToBottom } from '../ui/chat-scroll';
import { forceCloseAskQuestionModalForChat } from '../ui/question-cards-modal';
import { showToast } from '../ui/toast';

type SteerEnqueuedListener = (chatId: string) => void;
let steerEnqueuedListener: SteerEnqueuedListener | null = null;

/** @internal UI hook when pending steering changes. Does not abort a turn. */
export function setSteerEnqueuedListener(listener: SteerEnqueuedListener | null): void {
  steerEnqueuedListener = listener;
}

function notifySteerEnqueued(chatId: string): void {
  steerEnqueuedListener?.(chatId);
}

/** History/API content for a consumed steer row (plain user text in v1). */
export function formatSteerHistoryContent(text: string): string {
  return text.trim();
}

/** Retain separate messages and images until the next model boundary. */
export function enqueueSteerMessage(chat: Chat, text: string, attachments: Attachment[] = []): boolean {
  const trimmed = buildHistoryUserContent(text, attachments).trim();
  if (!trimmed) return false;
  const images = persistableUserImages(attachments);
  if (images.length !== attachments.filter(attachment => Boolean(attachmentImageDataUrl(attachment))).length) {
    showToast('Attached images exceed this conversation\'s saved image limit. Remove an image and retry.');
    return false;
  }
  forceCloseAskQuestionModalForChat(chat.id);
  chat.pendingMessageQueue = [...(chat.pendingMessageQueue ?? []), {
    id: randomUUID(), text: trimmed, createdAt: Date.now(), kind: 'steer',
    ...(images.length ? { images } : {}),
  }];
  touchChat(chat);
  scheduleSaveSessions();
  if (isStreamDomVisible(chat.id)) {
    syncPendingTranscriptMessages(chat);
    scrollChatToBottom();
  }
  notifySteerEnqueued(chat.id);
  return true;
}

/** Drop a pending correction after cancellation or preservation in the queue. */
export function clearPendingSteer(chat: Chat): void {
  if (!chat.pendingSteerMessage && !chat.pendingMessageQueue?.some(item => item.kind === 'steer')) return;
  chat.pendingSteerMessage = undefined;
  chat.pendingMessageQueue = chat.pendingMessageQueue?.filter(item => item.kind !== 'steer');
  if (!chat.pendingMessageQueue?.length) chat.pendingMessageQueue = undefined;
  touchChat(chat);
  scheduleSaveSessions();
  notifySteerEnqueued(chat.id);
}

export interface ConsumePendingSteerOptions {
  /** When true, append an inline correction if this chat's stream DOM is visible. */
  renderDom?: boolean;
}

export interface ConsumePendingSteerResult {
  consumed: boolean;
  content?: string;
  historyIndex?: number;
  messages?: UserMessage[];
}

export function consumePendingSteer(
  chat: Chat,
  options: ConsumePendingSteerOptions = {},
): ConsumePendingSteerResult {
  const items: QueuedComposerMessage[] = chat.pendingMessageQueue?.filter(item => item.kind === 'steer') ?? [];
  // Read old saved drafts without merging separately submitted corrections.
  if (chat.pendingSteerMessage?.trim()) items.unshift({ id: 'legacy-steer', text: chat.pendingSteerMessage.trim(), createdAt: Date.now() });
  if (!items.length) return { consumed: false };
  const messages: UserMessage[] = items.map(item => ({ role: 'user', content: formatSteerHistoryContent(item.text), steer: true,
    ...(item.images?.length ? { images: item.images } : {}) }));
  const historyIndex = chat.history.length;
  for (const message of messages) {
    chat.history.push(message);
    recordChatMessage(chat);
  }
  touchChat(chat);
  chat.pendingSteerMessage = undefined;
  chat.pendingMessageQueue = chat.pendingMessageQueue?.filter(item => item.kind !== 'steer');
  if (!chat.pendingMessageQueue?.length) chat.pendingMessageQueue = undefined;
  scheduleSaveSessions();

  const shouldRenderDom =
    options.renderDom !== false && isStreamDomVisible(chat.id);
  if (shouldRenderDom) {
    syncPendingTranscriptMessages(chat);
    for (const [index, message] of messages.entries()) {
      const rowIndex = historyIndex + index;
      const { wrap } = appendBubble('user', message.content, {
        historyIndex: rowIndex,
        turnKind: 'user',
        chatId: chat.id,
      }, { persistedImages: message.images, steer: true });
      void import('../ui/message-actions').then((m) => {
        m.attachMessageActions(wrap, {
          chatId: chat.id,
          historyIndex: rowIndex,
          turnKind: 'user',
        });
      });
    }
    scrollChatIfPinned();
  }

  return { consumed: true, content: messages.map(message => message.content).join('\n\n'), historyIndex, messages };
}
