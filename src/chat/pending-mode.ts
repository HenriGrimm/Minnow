import type { ModeId } from './modes/types';
import type { Chat } from '../types';
import { isChatStreaming, subscribeChatStreamEnd } from './streaming-state';
import { findChatById, scheduleSaveSessions, touchChat } from '../state/sessions';
import { setChatMode, type SetChatModeResult } from '../ui/mode-selector';

/** Last-write-wins slot; applied when streaming ends for this chat. */
export function enqueuePendingMode(chat: Chat, modeId: ModeId): void {
  ensurePendingModeListener();
  chat.pendingModeId = modeId;
  touchChat(chat);
  scheduleSaveSessions();
}

/** Drop queued mode (explicit cancel only — normal stop still flushes). */
export function clearPendingMode(chat: Chat): void {
  if (!chat.pendingModeId) return;
  chat.pendingModeId = undefined;
  touchChat(chat);
  scheduleSaveSessions();
}

export function flushPendingMode(chat: Chat): SetChatModeResult | null {
  const modeId = chat.pendingModeId;
  if (!modeId) return null;
  if (isChatStreaming(chat.id)) return null;

  chat.pendingModeId = undefined;
  touchChat(chat);
  scheduleSaveSessions();
  return setChatMode(modeId, chat);
}

let pendingModeListenerRegistered = false;

function ensurePendingModeListener(): void {
  if (pendingModeListenerRegistered) return;
  pendingModeListenerRegistered = true;
  subscribeChatStreamEnd((chatId) => {
    // Stop paths may notify before clearing streaming flags.
    queueMicrotask(() => {
      const chat = findChatById(chatId);
      if (chat) flushPendingMode(chat);
    });
  });
}
