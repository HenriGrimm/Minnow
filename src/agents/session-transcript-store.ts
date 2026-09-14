import { findChatById } from '../state/sessions';
import { isUiOnlyTranscriptMessage } from '../chat/context/injection-notice';
import type { TranscriptStore } from '../../server/runner/transcript-store';

export function createSessionTranscriptStore(): TranscriptStore {
  return {
    load(chatId) {
      const chat = findChatById(chatId);
      if (!chat) return null;
      const messages: typeof chat.history = [];
      const rowIds: number[] = [];
      (chat.history ?? []).forEach((m, i) => {
        if (isUiOnlyTranscriptMessage(m)) return;
        messages.push(m);
        rowIds.push(i);
      });
      return {
        messages,
        // History indices: context / injection rows are filtered out of `messages`.
        rowIds,
        meta: {
          thinkingMode: chat.thinkingMode,
          reasoningEffort: chat.reasoningEffort,
        },
      };
    },
    append(chatId, message) {
      const chat = findChatById(chatId);
      if (!chat) return -1;
      chat.history.push(message as (typeof chat.history)[number]);
      return chat.history.length - 1;
    },
    setMeta(chatId, meta) {
      const chat = findChatById(chatId);
      if (!chat) return;
      if (meta.thinkingMode !== undefined) {
        chat.thinkingMode = meta.thinkingMode as typeof chat.thinkingMode;
      }
      if (meta.reasoningEffort !== undefined) {
        chat.reasoningEffort = meta.reasoningEffort as typeof chat.reasoningEffort;
      }
    },
  };
}
