/** Cooperative pause at model/tool boundaries; abort always releases a waiter. */
export function createPauseGate() {
  let paused = false;
  const listeners = new Set();
  return {
    get paused() { return paused; },
    setPaused(value) {
      if (paused === value) return;
      paused = value;
      for (const listener of [...listeners]) listener(paused);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async wait(signal) {
      signal?.throwIfAborted();
      if (!paused) return;
      await new Promise((resolve, reject) => {
        const cleanup = () => {
          listeners.delete(changed);
          signal?.removeEventListener('abort', aborted);
        };
        const changed = (value) => {
          if (value) return;
          cleanup();
          resolve();
        };
        const aborted = () => {
          cleanup();
          reject(signal.reason);
        };
        listeners.add(changed);
        signal?.addEventListener('abort', aborted, { once: true });
      });
      // A second pause may have arrived before this continuation ran.
      await this.wait(signal);
    },
  };
}
