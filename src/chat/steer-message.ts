import type { Chat } from '../types';
import {
  recordChatMessage,
  scheduleSaveSessions,
  touchChat,
} from '../state/sessions';
import { isStreamDomVisible } from './streaming-state';
import { appendBubble } from '../ui/messages';
import { scrollChatIfPinned } from '../ui/chat-scroll';
import { forceCloseAskQuestionModalForChat } from '../ui/question-cards-modal';

type SteerEnqueuedListener = (chatId: string) => void;
let steerEnqueuedListener: SteerEnqueuedListener | null = null;

/** @internal Optional UI hook when push-now steer is queued. P10-I does not abort. */
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

/** Last-write-wins slot for the next tool-loop consume. */
export function enqueueSteerMessage(chat: Chat, text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  forceCloseAskQuestionModalForChat(chat.id);
  chat.pendingSteerMessage = trimmed;
  touchChat(chat);
  scheduleSaveSessions();
  notifySteerEnqueued(chat.id);
  return true;
}

/** Drop queued steer (e.g. user stopped generation). */
export function clearPendingSteer(chat: Chat): void {
  if (!chat.pendingSteerMessage) return;
  chat.pendingSteerMessage = undefined;
  touchChat(chat);
  scheduleSaveSessions();
}

export interface ConsumePendingSteerOptions {
  /** When true, append an inline correction if this chat's stream DOM is visible. */
  renderDom?: boolean;
}

export interface ConsumePendingSteerResult {
  consumed: boolean;
  content?: string;
  historyIndex?: number;
}

export function consumePendingSteer(
  chat: Chat,
  options: ConsumePendingSteerOptions = {},
): ConsumePendingSteerResult {
  const trimmed = chat.pendingSteerMessage?.trim();
  if (!trimmed) return { consumed: false };

  const content = formatSteerHistoryContent(trimmed);
  chat.history.push({ role: 'user', content, steer: true });
  recordChatMessage(chat);
  touchChat(chat);
  chat.pendingSteerMessage = undefined;
  scheduleSaveSessions();

  const historyIndex = chat.history.length - 1;
  const shouldRenderDom =
    options.renderDom !== false && isStreamDomVisible(chat.id);
  if (shouldRenderDom) {
    const { wrap } = appendBubble('user', content, {
      historyIndex,
      turnKind: 'user',
      chatId: chat.id,
    }, { steer: true });
    void import('../ui/message-actions').then((m) => {
      m.attachMessageActions(wrap, {
        chatId: chat.id,
        historyIndex,
        turnKind: 'user',
      });
    });
    scrollChatIfPinned();
  }

  return { consumed: true, content, historyIndex };
}
