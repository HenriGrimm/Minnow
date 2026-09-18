import { getChatAbort, setChatStopReason } from '../app-state';
import type { ChatStopReason } from '../types';
import { clearPendingSteer } from './steer-message';
import { cancelGeneration } from '../api/generations';
import { flushStoppedChatPresentation } from './flush-stopped-chat-presentation';
import { findChatById, getActiveChat } from '../state/sessions';
import { forceCloseAskQuestionModalForChat } from '../ui/question-cards-modal';
import { cancelAllForParentChat } from '../agents/orchestrator';

/**
 * Stop a chat turn: cancel the backend generation (if any) and abort the local SSE reader.
 * @param reason Recorded on the turn run when the stream ends with status `stopped`.
 */
export function stopGeneration(chatId?: string, reason: ChatStopReason = 'user'): void {
  const requestedId = chatId?.trim();
  const chat = requestedId ? findChatById(requestedId) : getActiveChat();
  if (!chat) return;
  const id = chat.id;
  forceCloseAskQuestionModalForChat(id);
  setChatStopReason(id, reason);
  const generationId = chat.currentGenerationId?.trim();
  if (generationId) {
    void cancelGeneration(generationId).catch(() => {
    });
  }
  cancelAllForParentChat(id);

  clearPendingSteer(chat);

  const abort = getChatAbort(chat.id);
  if (abort) {
    abort.abort();
  }

  // Settle the visible state synchronously. The aborted turn's finally block
  // remains idempotent, while the user no longer sees a spinner until it runs.
  flushStoppedChatPresentation([chat.id], {
    keepGenerationId: reason === 'system',
  });
}
