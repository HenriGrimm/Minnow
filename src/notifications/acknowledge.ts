/**
 * Dismiss per-chat alerts when the user opens or focuses a chat thread.
 */

import { recordChatOpened, syncChatItemDotsInDom } from '../ui/chat-item-dot';
import { applySharedChatAttention, markChatDirty, scheduleSaveSessions, sessionState } from '../state/sessions';
import { markNotificationsReadForChat } from './store';
import { isPairedDevice } from '../api/session-token';
import { acknowledgeManagedChatActivity } from '../chat/managed-chat-client';
import { notifyManagedChatMetadata } from '../chat/managed-chat-view';
import type { ChatActivityCursor } from '../../server/chats/activity';

const pendingAcknowledgements = new Map<string, Promise<void>>();
const acknowledgedActivity = new WeakMap<object, string>();
const sameCursor = (a: ChatActivityCursor | undefined, b: ChatActivityCursor) =>
  a?.messageSeq === b.messageSeq && a.executionId === b.executionId;

/** Acknowledge only the activity the user actually saw, without saving a stale chat snapshot. */
export function acknowledgeObservedManagedActivity(chatId: string, cursor: ChatActivityCursor): Promise<void> {
  const chat = sessionState?.chats.find(row => row.id === chatId);
  const execution = chat?.agentExecution;
  const stamp = JSON.stringify([cursor, execution?.executionId, execution?.status, execution?.updatedAt]);
  if (chat && acknowledgedActivity.get(chat) === stamp) return Promise.resolve();
  const key = chatId + ':' + stamp;
  const existing = pendingAcknowledgements.get(key);
  if (existing) return existing;
  const observed = { ...cursor };
  const work = acknowledgeManagedChatActivity(chatId, observed).then(activity => {
    const current = sessionState?.chats.find(row => row.id === chatId);
    if (!current || !sameCursor(current.agentActivityCursor, observed) || !sameCursor(activity.agentActivityCursor, observed)) return;
    const latest = current.agentExecution;
    if (JSON.stringify([current.agentActivityCursor, latest?.executionId, latest?.status, latest?.updatedAt]) !== stamp) return;
    applySharedChatAttention(chatId, { unread: activity.unread, turnError: activity.turnError });
    acknowledgedActivity.set(current, stamp);
    notifyManagedChatMetadata(chatId);
    syncChatItemDotsInDom();
  }).finally(() => { pendingAcknowledgements.delete(key); });
  pendingAcknowledgements.set(key, work);
  return work;
}

/** Clear sidebar unread/error flags and menubar inbox rows for this chat. */
export function acknowledgeChatViewed(chatId: string): void {
  const trimmed = chatId.trim();
  if (!trimmed) return;
  const chat = sessionState?.chats.find((c) => c.id === trimmed);
  if (chat?.chatCommandVersion === 1 && chat.agentActivityCursor) {
    void acknowledgeObservedManagedActivity(trimmed, chat.agentActivityCursor).catch(() => { /* The next focused view retries; server flags stay authoritative. */ });
  } else if (!isPairedDevice() && chat && (chat.unread || chat.turnError)) {
    chat.unread = false;
    chat.turnError = false;
    markChatDirty(chat);
    scheduleSaveSessions();
  }
  recordChatOpened(trimmed);
  markNotificationsReadForChat(trimmed);
  syncChatItemDotsInDom();
}
