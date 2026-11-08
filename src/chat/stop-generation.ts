import { getChatAbort, setChatStopReason } from '../app-state';
import type { ChatStopReason } from '../types';
import { preservePendingSteer } from './message-queue';
import { cancelGeneration } from '../api/generations';
import { flushStoppedChatPresentation } from './flush-stopped-chat-presentation';
import { findChatById, getActiveChat, scheduleSaveSessions, sessionState, touchChat } from '../state/sessions';
import { projectChatRelationships } from '../state/chat-relationships';
import { forceCloseAskQuestionModalForChat } from '../ui/question-cards-modal';
import { cancelAllForParentChat, listActiveSubAgentRuns } from '../agents/orchestrator';
import { isChatTurnInProgress } from './chat-turn-guard';
import { sendRemoteChatCommand, shouldRelayChat } from './remote-chat-client';
import { setStatus } from '../ui/status';
import { getAgentConversationsCapabilitySync } from '../config/agent-conversations-enabled';
import { isServerStorageMode } from '../config/storage-mode';
import { getChatTurnOwnerId } from './turn-ownership';
import { reportBackgroundError } from '../boot/report-background-error';

const stoppableStates = new Set(['accepted', 'queued', 'running', 'loading_model', 'waiting', 'waiting_for_host', 'waiting_for_model', 'waiting_for_capacity', 'waiting_for_agents', 'waiting_for_input', 'waiting_for_question', 'waiting_for_approval', 'stopping']);

/** Keep Stop available for waiting turns and delegated work after the parent settles. */
export function hasChatWorkToStop(chatId: string): boolean {
  const chat = findChatById(chatId);
  if (!chat || chat.agentConversation?.origin === 'native' || chat.agentConversation?.capabilities?.canStop === false) return false;
  if (isChatTurnInProgress(chat.id) || stoppableStates.has(chat.agentExecution?.status ?? '') || (chat.agentPendingCommand && !chat.agentPendingCommand.held)) return true;
  const runningParents = new Set(listActiveSubAgentRuns().map(run => run.parentChatId));
  if (runningParents.has(chat.id)) return true;
  const graph = projectChatRelationships(sessionState?.chats ?? [chat]);
  const family = [...(graph.children.get(chat.id) ?? [])];
  for (let index = 0; index < family.length; index++) {
    const member = family[index]!;
    if (isChatTurnInProgress(member.id) || stoppableStates.has(member.agentExecution?.status ?? '') || (member.agentPendingCommand && !member.agentPendingCommand.held) || runningParents.has(member.id)) return true;
    family.push(...(graph.children.get(member.id) ?? []));
  }
  return false;
}

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
