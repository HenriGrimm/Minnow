import type { TurnEvent } from './run-turn';
import type { TranscriptMessage } from './transcript-store';

export interface TranscriptDecorationOptions {
  now?: () => number;
  readThinkingSegments?: () => string[];
  readThinkingSignature?: () => string | undefined;
  omitSystem?: boolean;
}
export interface TranscriptDecoration {
  observe(event: TurnEvent): void;
  decorate(message: TranscriptMessage): TranscriptMessage | null;
  patchAssistant(message: TranscriptMessage): TranscriptMessage;
  abortThinking(): void;
}
export function createTranscriptDecoration(options?: TranscriptDecorationOptions): TranscriptDecoration;
