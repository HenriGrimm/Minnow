import type { TranscriptStore } from '../runner/transcript-store';
export function createStageTranscriptStore(runId: string, role: string): TranscriptStore & { reset(): void };
