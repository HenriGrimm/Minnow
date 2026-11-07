import { showToast } from '../ui/toast';
import { isChatTurnInProgress } from './chat-turn-guard';
import { clearAttachments } from '../attachments/store';
import { parseSlashCommand } from '../skills/parse-slash';
import { parseSkillTagFromHistory } from '../skills/history-content';
import {
  ensureChatHistoryLoaded,
  activateChatById,
  findChatById,
  getActiveChat,
  scheduleSaveSessions,
  refreshSessionsFromServer,
  touchChat,
} from '../state/sessions';
import { getActiveRun } from '../state/runs-store';
import { runChatTurn } from './run-turn-chat';
import type { TurnSnapshot } from '../types';
import { truncateChatHistory } from './history-truncate';
import { renderChatFromHistory } from '../ui/messages';
import { setStatus } from '../ui/status';
import { CANONICAL_HISTORY_HINT, supportsLocalHistoryMutation } from '../state/chat-relationships';

export interface ForkOverrides {
  providerId?: string;
  modelId?: string;
  temperature?: number;
  maxTokens?: number;
}

/** Apply fork UI overrides onto a cloned snapshot. */
export function mergeSnapshotOverrides(
  base: TurnSnapshot,
  overrides?: ForkOverrides,
): TurnSnapshot {
  if (!overrides) return base;
  return {
    ...base,
    ...(overrides.providerId !== undefined ? { providerId: overrides.providerId } : {}),
    ...(overrides.modelId !== undefined ? { modelId: overrides.modelId } : {}),
    ...(overrides.temperature !== undefined ? { temperature: overrides.temperature } : {}),
    ...(overrides.maxTokens !== undefined ? { maxTokens: overrides.maxTokens } : {}),
  };
}

/** Replay or fork from a user message (truncate tail, then runChatTurn). */
export async function forkFromUserIndex(
  chatId: string,
  userHistoryIndex: number,
  overrides?: ForkOverrides,
): Promise<void> {
  if (isChatTurnInProgress(chatId)) {
    showToast('Finish or stop the current reply first');
    return;
  }

  const chat =
    findChatById(chatId) ??
    (getActiveChat().id === chatId ? getActiveChat() : undefined);
  if (!chat) {
    setStatus('err', 'Chat not found');
    return;
  }

  if (!supportsLocalHistoryMutation(chat)) {
    if (chat.chatCommandVersion !== 1 || chat.agentConversation) { showToast(CANONICAL_HISTORY_HINT); return; }
    try {
      if (overrides?.temperature !== undefined || overrides?.maxTokens !== undefined) throw new Error('Canonical replay preserves saved sampler settings. Sampler overrides are not supported yet.');
      await ensureChatHistoryLoaded(chatId);
      const row = chat.history[userHistoryIndex];
      if (!Number.isSafeInteger(userHistoryIndex) || userHistoryIndex < 0 || row?.role !== 'user' || !row.messageId) throw new Error('Replay requires a saved canonical user message.');
      const selection = overrides?.providerId !== undefined || overrides?.modelId !== undefined ? {
        providerId: overrides?.providerId ?? '', modelId: overrides?.modelId ?? '', options: {},
      } : undefined;
      if (selection && (!selection.providerId || !selection.modelId)) throw new Error('Select a complete provider/model pair for replay.');
      const { forkManagedChat } = await import('./managed-chat-client');
      const receipt = await forkManagedChat(chatId, row.messageId, { ...(selection ? { selection } : {}) });
      await refreshSessionsFromServer();
      if (getActiveChat().id !== chatId) return;
      await activateChatById(receipt.chatId);
      const forked = findChatById(receipt.chatId);
      if (forked) renderChatFromHistory(forked);
    } catch (error) { setStatus('err', error instanceof Error ? error.message : String(error)); }
    return;
  }

  try {
    await ensureChatHistoryLoaded(chatId);
  } catch {
    setStatus('err', 'Could not load this chat’s messages');
    return;
  }

  if (isChatTurnInProgress(chatId)) {
    showToast('Finish or stop the current reply first');
    return;
  }

  if (
    !Number.isInteger(userHistoryIndex) ||
    userHistoryIndex < 0 ||
    userHistoryIndex >= chat.history.length
  ) {
    setStatus('err', 'Invalid message');
    return;
  }

  const row = chat.history[userHistoryIndex];
  if (row.role !== 'user') {
    setStatus('err', 'Can only replay from a user message');
    return;
  }

  const priorRun = getActiveRun(chat, userHistoryIndex);
  const parentRunId = priorRun?.runId;

  const truncated = truncateChatHistory(chatId, userHistoryIndex, 'inclusive');
  if (!truncated.ok) {
    if (truncated.error === 'streaming') {
      showToast('Finish or stop the current reply first');
    } else {
      setStatus('err', 'Could not update history');
    }
    return;
  }

  const active = truncated.chat ?? chat;
  const userRow = active.history[userHistoryIndex];
  if (!userRow || userRow.role !== 'user') {
    setStatus('err', 'User message missing after truncate');
    return;
  }

  clearAttachments();
  renderChatFromHistory(active);

  const tagged = parseSkillTagFromHistory(userRow.content);
  const slash = parseSlashCommand(tagged.displayText);
  const skillId = tagged.skillId ?? slash.skillId;
  const userText = slash.userText || tagged.displayText;

  let replaySnapshot: TurnSnapshot | undefined;
  if (priorRun?.snapshot) {
    replaySnapshot = mergeSnapshotOverrides(priorRun.snapshot, overrides);
    replaySnapshot = {
      ...replaySnapshot,
      forkHistoryIndex: userHistoryIndex,
      userContent: tagged.displayText,
      skillId,
    };
  } else if (overrides) {
    replaySnapshot = undefined;
  }

  touchChat(active);
  scheduleSaveSessions();

  await runChatTurn({
    chat: active,
    pushUser: false,
    rawText: tagged.displayText,
    userText,
    skillId,
    displayText: tagged.displayText,
    historyContent: tagged.displayText,
    validAttachments: [],
    shouldScheduleTitle: false,
    replaySnapshot,
    parentRunId,
    forkOverrides: overrides,
  });
}
