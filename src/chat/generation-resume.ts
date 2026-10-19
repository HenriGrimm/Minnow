import { isChatStreaming } from './streaming-state';
import { GENERATION_LOST_ON_RESTART_MESSAGE } from '../api/generations';
import type { Chat } from '../types';
import { isGoalLoopActive } from '../state/sessions';
import { setStatus } from '../ui/status';
import { isResumeGateHeld } from './resume-gate';

/** Read the composer model picker (empty when none selected). */


/** Chats that still have a persisted backend generation id (boot resume candidates). */
export function listChatsWithGenerationId(chats: Chat[]): Chat[] {
  return chats.filter((c) => c.currentGenerationId?.trim());
}

export async function bootGenerationResumeForChats(chats: Chat[]): Promise<void> {
  const resumable = listChatsWithGenerationId(chats);
  if (!resumable.length) {
    return;
  }

  const { getActiveChat } = await import('../state/sessions');
  const activeId = getActiveChat()?.id;
  const active = resumable.find((chat) => chat.id === activeId);
  if (!active) {
    return;
  }
  await bootGenerationResumeForChat(active, { ownsGlobalStreaming: true });
}

export interface BootGenerationResumeOptions {
  /** When true, this chat drives `streaming` / sidebar thinking state. */
  ownsGlobalStreaming?: boolean;
}

export async function bootGenerationResumeForChat(
  chat: Chat,
  options: BootGenerationResumeOptions = {},
): Promise<void> {
  if (isResumeGateHeld()) {
    return;
  }
  if (isChatStreaming(chat.id)) {
    return;
  }

  const generationId = chat.currentGenerationId?.trim();
  if (!generationId) {
    return;
  }

  const modelId = chat.modelId?.trim() || '';
  if (!modelId) {
    setStatus('err', 'Select a model to resume this reply');
    return;
  }

  const { runChatTurn } = await import('./run-turn-chat');

  try {
    await runChatTurn({
      chat,
      pushUser: false,
      rawText: '',
      userText: '',
      skillId: null,
      displayText: '',
      historyContent: '',
      validAttachments: [],
      resumeGenerationId: generationId,
      ownsGlobalStreaming: options.ownsGlobalStreaming ?? true,
      goalDriven: isGoalLoopActive(chat),
    });
  } catch {}
}

/** Inline error copy when GET /stream returns 404 (generation evicted on server restart). */
export function generationLostOnRestartMessage(): string {
  return GENERATION_LOST_ON_RESTART_MESSAGE;
}
