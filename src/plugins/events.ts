/** Coalesced renderer changes, with no dependency on the chat or UI stores. */
const listeners = new Set<() => void>();
let pending = false;

export function notifyPluginContextChanged(): void {
  if (pending || listeners.size === 0) return;
  pending = true;
  queueMicrotask(() => {
    pending = false;
    for (const listener of listeners) {
      try { listener(); } catch (error) { console.error('[plugin-ui] context listener failed', error); }
    }
  });
}

export function subscribePluginContextChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
