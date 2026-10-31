import type { TranscriptStore } from '../runner/transcript-store';

export interface TranscriptExecutionFence {
  executionId: string;
  ownerId: string;
  epoch: number;
}
export interface ChatTranscriptRepository {
  readTranscript(chatId: string): import('../runner/transcript-store').TranscriptRecord | null;
  appendMessage(chatId: string, message: import('../runner/transcript-store').TranscriptMessage, options: { fence: TranscriptExecutionFence; messageId: string; commandId?: string }): { rowId: number };
  readMessage(chatId: string, rowId: number): { message: import('../runner/transcript-store').TranscriptMessage; rowHash: string } | null;
  patchMessage(chatId: string, rowId: number, patch: import('../runner/transcript-store').TranscriptMessage, options: { fence: TranscriptExecutionFence; expectedHash?: string }): unknown;
  setTranscriptMeta(chatId: string, meta: Record<string, unknown>, options: { fence: TranscriptExecutionFence }): unknown;
}
export function createChatTranscriptStore(options: {
  chatId: string;
  fence: TranscriptExecutionFence;
  repository?: ChatTranscriptRepository;
  now?: () => number;
}): TranscriptStore;
