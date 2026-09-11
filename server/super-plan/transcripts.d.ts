import type { TranscriptStore } from '../runner/transcript-store';
export function readStageTranscripts(runId: string): Array<{ stage: string; messages: unknown[] }>;
export function createStageTranscriptStore(runId: string, role: string): TranscriptStore & { reset(): void };
