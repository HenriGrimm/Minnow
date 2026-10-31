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
 * Stop a chat and its delegated work, retaining saved output and queued input.
 * @param reason Recorded on the turn run when the stream ends with status `stopped`.
 */
export function stopGeneration(chatId?: string, reason: ChatStopReason = 'user', options: { ownedByThisView?: boolean; serverControl?: boolean } = {}): void {
  const requestedId = chatId?.trim();
  const chat = requestedId ? findChatById(requestedId) : getActiveChat();
  if (!chat) return;
  const id = chat.id;
  if (!options.ownedByThisView && shouldRelayChat(id)) {
    void sendRemoteChatCommand(id, 'stop', {
      scope: 'tree',
      ...(chat.agentExecution && !['completed', 'failed', 'stopped', 'recovery_required'].includes(chat.agentExecution.status)
        ? { executionId: chat.agentExecution.executionId } : {}),
    }).catch(error => setStatus('err', String(error?.message || error)));
    return;
  }
  if (reason === 'user') {
    chat.subAgentAutoResumeBlocked = true;
    touchChat(chat);
    scheduleSaveSessions();
  }
  const persistentScope = getAgentConversationsCapabilitySync()?.recoveryEnabled === true || chat.subAgentRuns?.some(run => Boolean(run.childChatId));
  const ownerId = getChatTurnOwnerId(id);
  forceCloseAskQuestionModalForChat(id);
  setChatStopReason(id, reason);
  const generationId = chat.currentGenerationId?.trim();
  const abort = getChatAbort(id);
  const stopLocal = () => {
    if (generationId) void cancelGeneration(generationId).catch(() => {});
    abort?.abort();
    // A delayed scope receipt must not clear a replacement turn's presentation.
    if (getChatAbort(id) === abort && (!chat.currentGenerationId || chat.currentGenerationId === generationId)) {
      flushStoppedChatPresentation([id], { keepGenerationId: reason === 'system' });
    }
  };
  if (persistentScope) cancelAllForParentChat(id, { includePersistent: false });
  else cancelAllForParentChat(id);
  preservePendingSteer(chat);

  if (reason === 'user' && persistentScope && isServerStorageMode() && !options.serverControl) {
    // Keep the renderer lease alive until the server captures the family Stop.
    // Releasing it first makes the owner-pinned command stale and strands children.
    void import('./managed-chat-client').then(async module => {
      if (ownerId) await module.stopLegacyConversationScope(id, ownerId);
      else await module.sendManagedChatAction(id, 'stop', { scope: 'tree' });
    })
      .catch(error => reportBackgroundError('conversation-stop', error))
      .finally(stopLocal);
  } else {
    stopLocal();
  }
}
