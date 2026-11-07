/** Bound the caller's entire operation, including cold setup. Late results are discarded.
 * Shared initialization must not use the caller's signal; only its wait is cancelled.
 */
export function runWithDeadline(work, { timeoutMs = 3000, signal } = {}) {
  const controller = new AbortController();
  const ms = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 3000;
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); };
    const stop = reason => { controller.abort(reason); cleanup(); reject(reason); };
    const cancel = () => stop(signal.reason ?? new DOMException('Stopped', 'AbortError'));
    if (signal?.aborted) { cancel(); return; }
    signal?.addEventListener('abort', cancel, { once: true });
    timer = setTimeout(() => stop(new DOMException('Preparation deadline exceeded', 'TimeoutError')), ms);
    Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return work(controller.signal);
    }).then(value => {
      if (!controller.signal.aborted) { cleanup(); resolve(value); }
    }, error => { cleanup(); reject(error); });
  });
}
