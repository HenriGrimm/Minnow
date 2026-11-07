export function runWithDeadline<T>(work: (signal: AbortSignal) => T | PromiseLike<T>, options?: {
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<T>;
