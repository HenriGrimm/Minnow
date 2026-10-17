import { showToast } from '../ui/toast';
import { isChatTurnInProgress } from './chat-turn-guard';
import { clearAttachments } from '../attachments/store';
import { parseSlashCommand } from '../skills/parse-slash';
import { parseSkillTagFromHistory } from '../skills/history-content';
import {
  ensureChatHistoryLoaded,
  findChatById,
  getActiveChat,
  scheduleSaveSessions,
  touchChat,
} from '../state/sessions';
import { getActiveRun } from '../state/runs-store';
import { runChatTurn } from './run-turn-chat';
import type { TurnSnapshot } from '../types';
import { truncateChatHistory } from './history-truncate';
import { renderChatFromHistory } from '../ui/messages';
import { setStatus } from '../ui/status';

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
