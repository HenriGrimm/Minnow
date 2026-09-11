import type { TranscriptStore } from '../runner/transcript-store';

export function isTranscriptKey(key: string): boolean;

/** Transcript store for one stage step; every attempt of the step shares it. */
export function createStepTranscriptStore(runId: string, key: string): TranscriptStore & { reset(): void };

/** Messages of one step without the system prompt, or null for an invalid key. */
export function readStepTranscript(runId: string, key: string): Record<string, unknown>[] | null;

export function listStepTranscripts(runId: string): Array<{ key: string; messageCount: number }>;

/** Tool calls on the last assistant turn that never got a result. */
export function danglingToolCalls(messages: Record<string, unknown>[]): Array<{ id: string; name: string; arguments: unknown }>;
