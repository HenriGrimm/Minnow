/**
 * Chat turn notification producer — invoked after `finalizeRun` in `run-turn-chat.ts`.
 */

import { findRunById } from '../state/runs-store';
import { findChatById } from '../state/sessions';
import type { Chat, Message, TurnRunRecord } from '../types';
import { appIdForChat } from './app-for-chat';
import {
  formatToolFailurePreview,
  lastAssistantPreview,
  truncatePreview,
} from './preview';
import { pushNotificationOrActiveChatSound } from './push';

function runOutputMessages(chat: Chat, run: TurnRunRecord): Message[] {
  if (run.outputMessages?.length) {
    return run.outputMessages;
  }
  const start = run.outputHistoryStart;
  const end = run.outputHistoryEnd;
  if (start === undefined || end === undefined || end < start) return [];
  return chat.history.slice(start, end + 1);
}

function chatTitle(chat: Chat): string {
  return chat.name?.trim() || 'Chat';
}

/** Push inbox rows (and an OS toast) for a settled turn run; called from `run-turn-chat.ts` after finalizeRun. */
export function notifyChatTurnEnded(chatId: string, runId: string): void {
  const chat = findChatById(chatId);
  if (!chat) return;
  if (chat.chatCommandVersion === 1) return;

  const run = findRunById(chat, runId);
  if (!run || run.status === 'running' || run.status === 'superseded') return;

  const title = chatTitle(chat);
  const output = runOutputMessages(chat, run);
  const dedupeKey = `chat:${chatId}:${run.runId}`;
  const appId = appIdForChat(chat);
  const source = { activityId: `turn:${run.runId}`, workspacePath: chat.workspacePath };

  if (run.status === 'stopped') {
    pushNotificationOrActiveChatSound({
      ...source, kind: 'chat_turn_complete', activityStatus: 'stopped', title,
      preview: run.stopReason === 'user' ? 'Stopped by you' : 'Run stopped',
      chatId, appId, dedupeKey: `${dedupeKey}:stopped`, silent: true,
    });
    return;
  }

  if (run.status === 'failed') {
    const errPreview =
      run.errorMessage?.trim() ||
      lastAssistantPreview(output) ||
      truncatePreview(
        (run.outputMessages?.find((m) => m.role === 'assistant')?.content as string) ??
          'Turn failed',
      );
    pushNotificationOrActiveChatSound({
      ...source,
      kind: 'chat_turn_error',
      title,
      preview: errPreview || 'Turn failed',
      chatId,
      appId,
      dedupeKey: `${dedupeKey}:error`,
      os: true,
    });
    return;
  }

  if (run.status === 'completed') {
    const toolPreview = formatToolFailurePreview(output);
    if (toolPreview) {
      pushNotificationOrActiveChatSound({
        ...source,
        kind: 'chat_tool_failure',
        silent: true,
        title,
        preview: toolPreview,
        chatId,
        appId,
        dedupeKey: `${dedupeKey}:tools`,
      });
    }

    const preview = lastAssistantPreview(output) || 'Turn finished';
    pushNotificationOrActiveChatSound({
      ...source,
      kind: 'chat_turn_complete',
      title,
      preview,
      chatId,
      appId,
      dedupeKey: `${dedupeKey}:complete`,
      os: true,
    });
  }
}
