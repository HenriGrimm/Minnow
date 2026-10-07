/**
 * Dismiss per-chat alerts when the user opens or focuses a chat thread.
 */

import { recordChatOpened, syncChatItemDotsInDom } from '../ui/chat-item-dot';
import { markChatDirty, scheduleSaveSessions, sessionState } from '../state/sessions';
import { markNotificationsReadForChat } from './store';

/** Clear sidebar unread/error flags and menubar inbox rows for this chat. */
export function acknowledgeChatViewed(chatId: string): void {
  const trimmed = chatId.trim();
  if (!trimmed) return;
  const chat = sessionState?.chats.find((c) => c.id === trimmed);
  if (chat && (chat.unread || chat.turnError)) {
    chat.unread = false;
    chat.turnError = false;
    markChatDirty(chat);
    scheduleSaveSessions();
  }
  recordChatOpened(trimmed);
  markNotificationsReadForChat(trimmed);
  syncChatItemDotsInDom();
}
