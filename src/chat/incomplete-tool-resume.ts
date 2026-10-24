import { beginChatTurnSetup, endChatTurnSetup, isChatTurnSetupPending } from './chat-turn-guard';

import { findIncompleteToolBatchAtTail } from './incomplete-tool-batch';

import { isChatStreaming, isStreamDomVisible } from './streaming-state';

import { createSubAgentRunId } from '../agents/sub-agent-run-id';

import { getActiveChat } from '../state/sessions';

import { runChatToolBatch } from '../tools/chat-tool-batch';

import { findToolWrapInDom } from '../tools/tool-wrap-dom';

import type { Chat } from '../types';

import { appendChatTranscriptNode } from '../ui/chat-mount';

import { renderToolCall } from '../ui/tool-messages';

import { isAskQuestionModalOpenForChat } from '../ui/question-cards-modal';
import { isUserPromptLocked } from '../ui/user-prompt-lock';

import { setStatus } from '../ui/status';
import { isResumeGateHeld } from './resume-gate';
import { acquireChatTurn, type ChatTurnLease } from './turn-ownership';
import { persistSessionsBeforeDeliveryAck, refreshChatBeforeRecovery } from '../state/sessions';
import { renderChatFromHistory } from '../ui/messages';



const resumingChatIds = new Set<string>();









function ensureToolWrap(

  chat: Chat,

  toolName: string,

  args: unknown,

  toolCallId: string,

): HTMLElement {

  const existing = findToolWrapInDom(toolCallId);

  if (existing) {

    return existing;

  }

  const toolWrap = renderToolCall(toolName, args);

  toolWrap.dataset.toolCallId = toolCallId;

  if (isStreamDomVisible(chat.id)) {

    appendChatTranscriptNode(toolWrap);

  }

  return toolWrap;

}




export async function resumeIncompleteToolBatch(

  chat: Chat,

  options: { ownsGlobalStreaming?: boolean } = {},

): Promise<boolean> {

  if (typeof document === 'undefined') {

    return false;

  }

  if (isResumeGateHeld()) {

    return false;

  }

  if (isChatStreaming(chat.id) || isChatTurnSetupPending(chat.id)) {

    return false;

  }

  if (isUserPromptLocked()) {

    return false;

  }

  if (isAskQuestionModalOpenForChat(chat.id)) {

    return false;

  }

  if (resumingChatIds.has(chat.id)) {

    return false;

  }



  let batch = findIncompleteToolBatchAtTail(chat);

  if (!batch) {

    return false;

  }



  if (!beginChatTurnSetup(chat.id)) {

    return false;

  }



  resumingChatIds.add(chat.id);

  const parentTurnId = createSubAgentRunId();

  const resumeAbort = new AbortController();
  let turnLease: ChatTurnLease | null = null;
  let handedOff = false;



  try {

    turnLease = await acquireChatTurn(chat.id);
    if (!turnLease) return false;
    await turnLease.check();
    if (!await refreshChatBeforeRecovery(chat)) return false;
    if (getActiveChat().id === chat.id) renderChatFromHistory(chat);
    batch = findIncompleteToolBatchAtTail(chat);
    if (!batch) return false;

    await runChatToolBatch({

      chat,

      toolCalls: batch.pendingToolCalls,

      signal: AbortSignal.any([resumeAbort.signal, turnLease.signal]),

      constrained: false,

      paintInChat: isStreamDomVisible(chat.id),

      parentTurnId,

      uiDesignerActive: false,

      uiDesignerMode: 'implement',

      livePartialText: '',

      thoughtController: null,

      syncContextUsage: () => {},

      trackHistoryPush: () => {},

      ensureToolWrap: (toolName, args, toolCallId) =>

        ensureToolWrap(chat, toolName, args, toolCallId),

    });



    const modelId = chat.modelId?.trim() || '';

    if (!modelId) {

      setStatus('err', 'Select a model to continue this reply');

      return true;

    }



    const { runChatTurn } = await import('./run-turn-chat');

    endChatTurnSetup(chat.id);
    handedOff = true;
    await runChatTurn({

      turnLease,

      chat,

      pushUser: false,

      rawText: '',

      userText: '',

      skillId: null,

      displayText: '',

      historyContent: '',

      validAttachments: [],

      ownsGlobalStreaming: options.ownsGlobalStreaming ?? true,

    });

    return true;

  } catch {

    if (!handedOff) endChatTurnSetup(chat.id);

    return false;

  } finally {

    if (turnLease) {
      await persistSessionsBeforeDeliveryAck();
      await turnLease.release();
    }
    if (!handedOff) endChatTurnSetup(chat.id);

    resumingChatIds.delete(chat.id);

  }

}




export async function hasIncompleteToolBatchForBoot(): Promise<boolean> {

  if (typeof document === 'undefined') {

    return false;

  }

  const active = getActiveChat();

  if (!active) {

    return false;

  }

  try {

    const { ensureChatHistoryLoaded } = await import('../state/sessions');

    await ensureChatHistoryLoaded(active.id);

  } catch {

    return false;

  }

  return Boolean(findIncompleteToolBatchAtTail(active));

}



/** Resume pending tools for the active chat after reload (other chats wait until opened). */

export async function bootIncompleteToolResumeForChats(chats: readonly Chat[]): Promise<void> {

  if (!(await hasIncompleteToolBatchForBoot())) {

    return;

  }

  const active = getActiveChat();

  if (!active) {

    return;

  }

  await resumeIncompleteToolBatch(active, { ownsGlobalStreaming: true });

}



/** Resume when switching to a chat that still has unanswered question cards in history. */

export async function resumeIncompleteToolBatchOnChatSwitch(chat: Chat): Promise<void> {

  if (isResumeGateHeld()) {

    return;

  }

  if (!findIncompleteToolBatchAtTail(chat)) {

    return;

  }

  if (isAskQuestionModalOpenForChat(chat.id)) {

    return;

  }

  await resumeIncompleteToolBatch(chat, { ownsGlobalStreaming: true });

}

