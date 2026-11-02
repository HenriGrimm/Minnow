/** One bounded background read at a time, shared by timer and manual triggers.
 * Callers must check the signal before publishing results after an await.
 */
export function createPollingTask(work: (signal: AbortSignal) => Promise<void>, timeoutMs = 10_000) {
  let pending: { controller: AbortController; promise: Promise<void> } | undefined;
  return {
    run(): Promise<void> {
      if (pending) return pending.promise;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const promise = Promise.resolve().then(() => {
        if (!controller.signal.aborted) return work(controller.signal);
      }).catch(error => {
        if (!controller.signal.aborted) throw error;
      }).finally(() => {
        clearTimeout(timer);
        if (pending?.controller === controller) pending = undefined;
      });
      pending = { controller, promise };
      return promise;
    },
    cancel(): void {
      pending?.controller.abort();
      pending = undefined;
    },
  };
}
