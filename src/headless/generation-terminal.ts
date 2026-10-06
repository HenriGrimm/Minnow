import type { GenerationEndEvent } from '../api/generations';

export class HeadlessGenerationError extends Error {
  constructor(
    readonly status: 'error' | 'cancelled',
    readonly partialText: string,
    readonly generationId: string,
    message: string,
  ) {
    super(message);
    this.name = 'HeadlessGenerationError';
  }
}

/** Return a failure for every non-success terminal state, retaining streamed text. */
export function headlessGenerationFailure(
  event: GenerationEndEvent | undefined,
  partialText: string,
  generationId: string,
): HeadlessGenerationError | null {
  if (event?.status === 'complete') return null;
  const status = event?.status === 'cancelled' ? 'cancelled' : 'error';
  const message = event?.errorMessage?.trim()
    || (status === 'cancelled'
      ? 'Generation cancelled'
      : event?.quotaExceeded ? 'Provider usage quota exhausted' : 'Generation ended without completing');
  return new HeadlessGenerationError(status, partialText, generationId, message);
}
