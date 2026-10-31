import type { TranscriptMessage } from './transcript-store';

export function projectUserContent<T extends TranscriptMessage>(message: T, options?: { vision?: boolean }): T;
