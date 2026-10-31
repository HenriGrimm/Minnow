import { createSessionTranscriptStore } from '../agents/session-transcript-store';
import { createTranscriptDecoration } from '../../server/runner/transcript-decoration.js';
import { findChatById, recordChatMessage, scheduleSaveSessions, touchChat } from '../state/sessions';
import { noteRunGeneration, noteRunOutputIndex } from '../state/runs-store';
import type { ThoughtBubbleController } from '../ui/thought-bubbles';
import type { TurnEvent } from '../../server/runner/run-turn';
import type { TranscriptMessage, TranscriptStore } from '../../server/runner/transcript-store';
import type { TurnRunId } from '../types';

export interface ChatTranscriptStore extends TranscriptStore {
  observe(event: TurnEvent): void;
  noteGeneration(chatId: string, generationId: string): void;
  abortThinking(): void;
  lastAssistantHistoryIndex(): number | undefined;
}
export interface CreateChatTranscriptStoreOptions {
  inner?: TranscriptStore;
  thoughtController?: ThoughtBubbleController | null;
  turnRunId?: TurnRunId;
}

/** Renderer bookkeeping around the shared event-to-history projection. */
export function createChatTranscriptStore(options: CreateChatTranscriptStoreOptions = {}): ChatTranscriptStore {
  const inner = options.inner ?? createSessionTranscriptStore();
  const controller = options.thoughtController ?? null;
  const decoration = createTranscriptDecoration({
    readThinkingSegments: () => controller?.getSegmentsNormalized() ?? [],
    readThinkingSignature: () => controller?.getAnthropicThinkingSignature(),
  });
  let lastAssistantIndex: number | undefined;
  let lastChatId: string | undefined;
  return {
    load: (chatId) => inner.load(chatId),
    setMeta: (chatId, meta) => inner.setMeta(chatId, meta),
    append(chatId, message) {
      const chat = findChatById(chatId);
      if (!chat) return -1;
      const decorated = decoration.decorate(message);
      if (!decorated) return -1;
      inner.append(chatId, decorated);
      const index = chat.history.length - 1;
      lastChatId = chatId;
      if (decorated.role === 'assistant') lastAssistantIndex = index;
      if (options.turnRunId) noteRunOutputIndex(chat, options.turnRunId, index);
      recordChatMessage(chat);
      scheduleSaveSessions();
      return index;
    },
    observe(event) {
      decoration.observe(event);
      if (event.type === 'response_restart') controller?.resetFailedResponse();
      if (event.type === 'round_start') {
        if (event.index > 0) {
          controller?.consumePersistedSegments();
          controller?.resetStreamPhaseHints();
        }
        lastAssistantIndex = undefined;
      }
      if (event.type !== 'round_end' || lastAssistantIndex === undefined || !lastChatId) return;
      const chat = findChatById(lastChatId);
      const row = chat?.history[lastAssistantIndex];
      if (!chat || row?.role !== 'assistant') return;
      Object.assign(row, decoration.patchAssistant(row));
      recordChatMessage(chat);
      scheduleSaveSessions();
    },
    noteGeneration(chatId, generationId) {
      const chat = findChatById(chatId);
      if (!chat) return;
      if (options.turnRunId) noteRunGeneration(chat, options.turnRunId, generationId);
      touchChat(chat);
      scheduleSaveSessions();
    },
    abortThinking: () => decoration.abortThinking(),
    lastAssistantHistoryIndex: () => lastAssistantIndex,
  };
}
