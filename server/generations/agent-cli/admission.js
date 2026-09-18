const providers = new Map();
const abortError = () => Object.assign(new Error('Agent CLI request cancelled.'), { name: 'AbortError' });

/** FIFO admission is shared across chats, sub-agents, routers, and utility callers. */
export function admitAgentCli(providerId, limit = 1, signal) {
  if (signal?.aborted) return Promise.reject(abortError());
  let pool = providers.get(providerId);
  if (!pool) { pool = { active: 0, queue: [] }; providers.set(providerId, pool); }
  if (pool.queue.length >= 64) return Promise.reject(new Error('Agent CLI queue is full. Wait for a running task or increase concurrency in Models → CLIs.'));
  function drain() {
    while (pool.queue.length && pool.active < pool.queue[0].limit) {
      const entry = pool.queue.shift();
      entry.signal?.removeEventListener('abort', entry.abort);
      if (entry.signal?.aborted) { entry.reject(abortError()); continue; }
      pool.active += 1;
      let released = false;
      entry.resolve(() => {
        if (released) return;
        released = true;
        pool.active -= 1;
        drain();
      });
    }
    if (!pool.active && !pool.queue.length && providers.get(providerId) === pool) providers.delete(providerId);
  }
  return new Promise((resolve, reject) => {
    const entry = { limit: Math.max(1, Math.min(16, Math.floor(Number(limit) || 1))), signal, resolve, reject, abort: null };
    entry.abort = () => {
      const index = pool.queue.indexOf(entry);
      if (index >= 0) pool.queue.splice(index, 1);
      signal.removeEventListener('abort', entry.abort);
      reject(abortError());
      drain();
    };
    pool.queue.push(entry);
    signal?.addEventListener('abort', entry.abort, { once: true });
    drain();
  });
}
