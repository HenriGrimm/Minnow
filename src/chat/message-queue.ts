import type { Chat, QueuedComposerMessage } from '../types';
import { randomUUID } from '../lib/random-id';
import {
  scheduleSaveSessions,
  touchChat,
} from '../state/sessions';
import { forceCloseAskQuestionModalForChat } from '../ui/question-cards-modal';
import { isChatTurnInProgress } from './chat-turn-guard';
import { clearPendingSteer, enqueueSteerMessage } from './steer-message';
import { parseCompactSlashInput } from './context/parse-compact-command';
import { sendRemoteChatCommand, shouldRelayChat } from './remote-chat-client';
import { setStatus } from '../ui/status';

type QueueChangedListener = () => void;
var queueChangedListener: QueueChangedListener | null = null;
const dispatching = new Map<string, object>();
const editing = new Set<string>();

/** Hold a queued message in place while its inline editor is open. */
export function setQueuedMessageEditing(chatId: string, id: string, active: boolean): void {
  const key = `${chatId}:${id}`;
  if (active) editing.add(key);
  else editing.delete(key);
}

export function setPendingMessageQueueChangedListener(
  listener: QueueChangedListener | null,
): void {
  queueChangedListener = listener;
}

function notifyPendingMessageQueueChanged(): void {
  queueChangedListener?.();
}

function restoreDequeuedMessage(chat: Chat, item: QueuedComposerMessage): void {
  const queue = getPendingMessageQueue(chat);
  if (queue.some((entry) => entry.id === item.id)) return;
  chat.pendingMessageQueue = [item, ...queue];
  touchChat(chat);
  scheduleSaveSessions();
  notifyPendingMessageQueueChanged();
}

async function dispatchQueuedMessage(chat: Chat, item: QueuedComposerMessage): Promise<void> {
  const token = {};
  dispatching.set(chat.id, token);
  let admitted = false;
  const release = () => { if (dispatching.get(chat.id) === token) dispatching.delete(chat.id); };
  try {
    const { resumeParentChatWithMessage } = await import('./run-turn-chat');
    const completed = await resumeParentChatWithMessage(chat, item.text, {
      onUserMessageAccepted: async () => { admitted = true; release(); },
    });
    if (!completed && !admitted) restoreDequeuedMessage(chat, item);
    // Local commands have no turn teardown to advance the next queued message.
    if (completed && !admitted) { release(); queueMicrotask(() => { void flushPendingMessageQueue(chat); }); }
  } catch (error) {
    if (!admitted) restoreDequeuedMessage(chat, item);
    throw error;
  } finally { release(); }
}

/** Return the chat queue array (empty when unset). */
export function getPendingMessageQueue(chat: Chat): QueuedComposerMessage[] {
  return Array.isArray(chat.pendingMessageQueue) ? chat.pendingMessageQueue : [];
}

/** Count of queued follow-ups for UI badges. */
export function getPendingMessageQueueCount(chat: Chat): number {
  return getPendingMessageQueue(chat).length;
}

function normalizeQueueItem(raw: unknown): QueuedComposerMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Partial<QueuedComposerMessage>;
  const text = typeof row.text === 'string' ? row.text.trim() : '';
  if (!text) return null;
  const id = typeof row.id === 'string' && row.id.trim() ? row.id.trim() : randomUUID();
  const createdAt =
    typeof row.createdAt === 'number' && Number.isFinite(row.createdAt)
      ? row.createdAt
      : Date.now();
  return { id, text, createdAt };
}

/** Validate persisted queue rows on session load. */
export function ensurePendingMessageQueue(
  raw: unknown,
): QueuedComposerMessage[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const items = raw.map(normalizeQueueItem).filter(Boolean) as QueuedComposerMessage[];
  return items.length ? items : undefined;
}

/** Append a follow-up to the queue while the chat is streaming. */
export function enqueueComposerMessage(chat: Chat, text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  forceCloseAskQuestionModalForChat(chat.id);
  const queue = getPendingMessageQueue(chat);
  if (!Array.isArray(chat.pendingMessageQueue)) {
    chat.pendingMessageQueue = queue;
  }
  chat.pendingMessageQueue!.push({
    id: randomUUID(),
    text: trimmed,
    createdAt: Date.now(),
  });
  touchChat(chat);
  scheduleSaveSessions();
  notifyPendingMessageQueueChanged();
  return true;
}

/** Remove one queued follow-up by id. */
export function removeQueuedMessage(chat: Chat, id: string): boolean {
  if (shouldRelayChat(chat.id)) {
    void sendRemoteChatCommand(chat.id, 'remove', { itemId: id }).catch(error => setStatus('err', String(error?.message || error)));
    return true;
  }
  const queue = getPendingMessageQueue(chat);
  const index = queue.findIndex((item) => item.id === id);
  if (index < 0) return false;
  queue.splice(index, 1);
  editing.delete(`${chat.id}:${id}`);
  chat.pendingMessageQueue = queue.length > 0 ? queue : undefined;
  touchChat(chat);
  scheduleSaveSessions();
  notifyPendingMessageQueueChanged();
  return true;
}

/** Update queued message text (edit in place). */
export function updateQueuedMessage(chat: Chat, id: string, text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (shouldRelayChat(chat.id)) {
    void sendRemoteChatCommand(chat.id, 'edit', { itemId: id, text: trimmed }).catch(error => setStatus('err', String(error?.message || error)));
    return true;
  }
  const queue = getPendingMessageQueue(chat);
  const item = queue.find((entry) => entry.id === id);
  if (!item) return false;
  item.text = trimmed;
  chat.pendingMessageQueue = queue;
  touchChat(chat);
  scheduleSaveSessions();
  notifyPendingMessageQueueChanged();
  return true;
}

/** Keep unapplied corrections available after Stop, failure, or a boundary-free reply. */
export function preservePendingSteer(chat: Chat): void {
  const text = chat.pendingSteerMessage?.trim();
  if (!text) return;
  chat.pendingMessageQueue = [{ id: randomUUID(), text, createdAt: Date.now() }, ...getPendingMessageQueue(chat)];
  clearPendingSteer(chat);
  notifyPendingMessageQueueChanged();
}

export type PushQueuedMessageNowResult = 'sent' | 'deferred' | false;

/** Promote a queued item to steer while streaming, or send immediately when idle. */
export function pushQueuedMessageNow(chat: Chat, id: string): PushQueuedMessageNowResult {
  if (shouldRelayChat(chat.id)) {
    void sendRemoteChatCommand(chat.id, 'push', { itemId: id }).catch(error => setStatus('err', String(error?.message || error)));
    return 'sent';
  }
  const queue = getPendingMessageQueue(chat);
  const index = queue.findIndex((item) => item.id === id);
  if (index < 0) return false;
  const queued = queue[index];
  if (dispatching.has(chat.id) || editing.has(`${chat.id}:${id}`)) return false;
  // Local commands must reach their command handler after the current turn.
  // Sending one as a steer persists it as ordinary user text for the model.
  if (isChatTurnInProgress(chat.id) && parseCompactSlashInput(queued?.text ?? '')) {
    return 'deferred';
  }
  const [item] = queue.splice(index, 1);
  chat.pendingMessageQueue = queue.length > 0 ? queue : undefined;
  touchChat(chat);
  scheduleSaveSessions();
  notifyPendingMessageQueueChanged();
  if (!item) return false;

  if (isChatTurnInProgress(chat.id)) {
    return enqueueSteerMessage(chat, item.text) ? 'sent' : false;
  }

  void dispatchQueuedMessage(chat, item).catch(error => setStatus('err', String(error?.message || error)));
  return 'sent';
}

/** Drop all queued follow-ups (e.g. chat delete). */
export function clearPendingMessageQueue(chat: Chat): void {
  if (!chat.pendingMessageQueue?.length) return;
  for (const item of chat.pendingMessageQueue) editing.delete(`${chat.id}:${item.id}`);
  chat.pendingMessageQueue = undefined;
  touchChat(chat);
  scheduleSaveSessions();
  notifyPendingMessageQueueChanged();
}

/** Send the oldest queued follow-up as a new turn after streaming ends. */
export async function flushPendingMessageQueue(chat: Chat): Promise<void> {
  if (chat.chatCommandVersion === 1) return;
  const queue = getPendingMessageQueue(chat);
  if (queue.length === 0 || isChatTurnInProgress(chat.id) || dispatching.has(chat.id) || editing.has(`${chat.id}:${queue[0].id}`)) return;
  const item = queue.shift();
  chat.pendingMessageQueue = queue.length > 0 ? queue : undefined;
  touchChat(chat);
  scheduleSaveSessions();
  notifyPendingMessageQueueChanged();
  if (!item?.text.trim()) return;

  await dispatchQueuedMessage(chat, item);
}

/** @internal Test hook — append a queue row with a fixed id. */
export function enqueueComposerMessageForTests(
  chat: Chat,
  item: QueuedComposerMessage,
): void {
  if (!Array.isArray(chat.pendingMessageQueue)) {
    chat.pendingMessageQueue = [];
  }
  chat.pendingMessageQueue.push(item);
  touchChat(chat);
  scheduleSaveSessions();
  notifyPendingMessageQueueChanged();
}
