import { MAX_WAIT_MS, DEFAULT_WAIT_MS, DEFAULT_WAIT_REASON, formatWaitDuration, parseWaitDuration } from '../../server/tools/utility-core.js';
export { MAX_WAIT_MS, DEFAULT_WAIT_MS, DEFAULT_WAIT_REASON, formatWaitDuration, parseWaitDuration };
/**
 * The `wait` tool: park a chat turn on a timer, then continue in the same loop.
 *
 * The tool call blocks until the timer fires and returns a tool result the model
 * reads as "the timer completed". Coordination stays in the transcript,
 * without creating a user-facing completion alert.
 */

/** Pending timers, so tests can clear them and no timer outlives its turn. */
const pendingTimers = new Set<ReturnType<typeof setTimeout>>();

/** Timer capability injected into the chat turn, mirroring `AskCapability`. */
export interface WaitCapability {
  wait(input: {
    durationMs: number;
    reason: string;
    chatId?: string;
    signal?: AbortSignal;
  }): Promise<string>;
}

/** Build a capability that parks the caller until the timer fires. */
export function createWaitCapability(): WaitCapability {
  return {
    wait({ durationMs, reason, signal }) {
      return new Promise<string>((resolve, reject) => {
        if (signal?.aborted) {
          const err = new Error('wait aborted');
          err.name = 'AbortError';
          reject(err);
          return;
        }

        let timer: ReturnType<typeof setTimeout>;
        const onAbort = () => {
          clearTimeout(timer);
          pendingTimers.delete(timer);
          const err = new Error('wait aborted');
          err.name = 'AbortError';
          reject(err);
        };

        timer = setTimeout(() => {
          pendingTimers.delete(timer);
          signal?.removeEventListener('abort', onAbort);
          resolve(
            `Timer completed after ${formatWaitDuration(durationMs)} — ${reason.trim() || DEFAULT_WAIT_REASON}. Continue now.`,
          );
        }, durationMs);

        pendingTimers.add(timer);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    },
  };
}

/** Clear pending timers (tests). */
export function resetWaitTimersForTests(): void {
  for (const timer of pendingTimers) clearTimeout(timer);
  pendingTimers.clear();
}
