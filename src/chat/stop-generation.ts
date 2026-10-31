import { getChatAbort, setChatStopReason } from '../app-state';
import type { ChatStopReason } from '../types';
import { preservePendingSteer } from './message-queue';
import { cancelGeneration } from '../api/generations';
import { flushStoppedChatPresentation } from './flush-stopped-chat-presentation';
import { findChatById, getActiveChat, scheduleSaveSessions, touchChat } from '../state/sessions';
import { forceCloseAskQuestionModalForChat } from '../ui/question-cards-modal';
import { cancelAllForParentChat } from '../agents/orchestrator';
import { sendRemoteChatCommand, shouldRelayChat } from './remote-chat-client';
import { setStatus } from '../ui/status';
import { getAgentConversationsCapabilitySync } from '../config/agent-conversations-enabled';
import { isServerStorageMode } from '../config/storage-mode';
import { getChatTurnOwnerId } from './turn-ownership';
import { reportBackgroundError } from '../boot/report-background-error';

/**
 * Stop a chat turn: cancel the backend generation (if any) and abort the local SSE reader.
 * @param reason Recorded on the turn run when the stream ends with status `stopped`.
 */
export function stopGeneration(chatId?: string, reason: ChatStopReason = 'user', options: { ownedByThisView?: boolean; serverControl?: boolean } = {}): void {
  const requestedId = chatId?.trim();
  const chat = requestedId ? findChatById(requestedId) : getActiveChat();
  if (!chat) return;
  const id = chat.id;
  if (!options.ownedByThisView && shouldRelayChat(id)) {
    void sendRemoteChatCommand(id, 'stop').catch(error => setStatus('err', String(error?.message || error)));
    return;
  }
  if (reason === 'user') {
    chat.subAgentAutoResumeBlocked = true;
    touchChat(chat);
    scheduleSaveSessions();
  }
  const persistentScope = getAgentConversationsCapabilitySync()?.creationEnabled === true || chat.subAgentRuns?.some(run => Boolean(run.childChatId));
  const ownerId = getChatTurnOwnerId(id);
  if (reason === 'user' && persistentScope && ownerId && isServerStorageMode() && !options.serverControl) {
    void import('./managed-chat-client').then(module => module.stopLegacyConversationScope(id, ownerId))
      .catch(error => reportBackgroundError('conversation-stop', error));
  }
  forceCloseAskQuestionModalForChat(id);
  setChatStopReason(id, reason);
  const generationId = chat.currentGenerationId?.trim();
  if (generationId) {
    void cancelGeneration(generationId).catch(() => {
    });
  }
  if (persistentScope) cancelAllForParentChat(id, { includePersistent: false });
  else cancelAllForParentChat(id);

  preservePendingSteer(chat);

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
