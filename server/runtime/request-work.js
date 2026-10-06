import { AsyncLocalStorage } from 'node:async_hooks';

const requestWork = new AsyncLocalStorage();

export function getRequestAbortSignal() {
  return requestWork.getStore();
}

/** Only request-owned work belongs in this scope; persistent sessions do not. */
export async function runRequestWork(req, res, work) {
  const controller = new AbortController();
  const abort = () => controller.abort(new Error('Request disconnected'));
  const close = () => { if (!res.writableFinished) abort(); };
  req.once('aborted', abort);
  res.once('close', close);
  if (req.aborted || res.destroyed) abort();
  try {
    return await requestWork.run(controller.signal, work);
  } finally {
    req.removeListener('aborted', abort);
    res.removeListener('close', close);
  }
}

export function waitForRequestWork(promise, signal = getRequestAbortSignal(), onAbort) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      try { onAbort?.(); } catch { /* A cancellation callback must not escape the HTTP event handler. */ }
      reject(signal.reason ?? new Error('Request disconnected'));
    };
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', abort);
    });
  });
}
