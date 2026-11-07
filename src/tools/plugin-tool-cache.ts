import type { OpenAIFunctionDefinition } from './definitions';
import { StreamEventSource } from '../api/stream-event-source';

type Catalog = { tools?: OpenAIFunctionDefinition[]; revision?: string };
type Options = {
  read?: (signal: AbortSignal, force: boolean) => Promise<Catalog>;
  subscribe?: (onRevision: (revision: string, reconnected?: boolean) => void) => () => void;
  timeoutMs?: number;
  onError?: (error: Error) => void;
};

function subscribeChanges(onRevision: (revision: string, reconnected?: boolean) => void): () => void {
  if (typeof window === 'undefined' || !/^https?:/.test(window.location.href)) return () => {};
  const source = new StreamEventSource('/api/plugins/events');
  let opened = false;
  let reconnected = false;
  source.onopen = () => { reconnected = opened; opened = true; };
  source.onmessage = event => {
    try {
      const body = JSON.parse(event.data) as { revision?: string };
      if (typeof body.revision === 'string') {
        onRevision(body.revision, reconnected);
        reconnected = false;
      }
    } catch { /* ignore malformed event data */ }
  };
  return () => source.close();
}

async function readCatalog(signal: AbortSignal, force: boolean): Promise<Catalog> {
  if (force) {
    const response = await fetch('/api/plugins/reload', { method: 'POST', signal });
    if (!response.ok) throw new Error('Plugin catalog refresh is unavailable');
    await response.body?.cancel();
  }
  const response = await fetch('/api/plugins/tools', { signal });
  if (!response.ok) throw new Error('Plugin catalog is unavailable');
  return response.json() as Promise<Catalog>;
}

/** Revision-driven discovery only. Server dispatch always rechecks current authority. */
export function createPluginToolCache({
  read = readCatalog, subscribe = subscribeChanges, timeoutMs = 5000,
  onError = () => console.warn('[plugins] Catalog unavailable; refresh Plugins or reconnect to retry.'),
}: Options = {}) {
  let tools: OpenAIFunctionDefinition[] = [];
  let revision: string | undefined;
  let observedRevision: string | undefined;
  let error: Error | undefined;
  let version = 0;
  let settled = -1;
  let forceNext = false;
  let pending: Promise<void> | undefined;
  let controller: AbortController | undefined;
  let unsubscribe: (() => void) | undefined;
  let lifecycle = 0;

  const invalidate = () => { version++; tools = []; error = undefined; };
  const refresh = (force = false): Promise<void> => {
    if (force) { invalidate(); forceNext = true; }
    const capturedLifecycle = lifecycle;
    unsubscribe ??= subscribe((next, reconnected) => {
      if (lifecycle !== capturedLifecycle) return;
      if (observedRevision === next && !(reconnected && error)) return;
      observedRevision = next;
      if (revision === next && settled === version && !error) return;
      invalidate();
      void refresh().catch(() => {}); // The failure is latched and reported once below.
    });
    if (pending) return pending;
    if (settled === version) return error ? Promise.reject(error) : Promise.resolve();
    pending = (async () => {
      while (settled !== version) {
        const captured = version;
        const forceRead = forceNext;
        forceNext = false;
        const abort = new AbortController();
        controller = abort;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          // Also bound response.json() and readers which fail to honor abort.
          const stopped = new Promise<never>((_, reject) => {
            abort.signal.addEventListener('abort', () => reject(abort.signal.reason), { once: true });
            timer = setTimeout(() => abort.abort(new Error('Plugin catalog read timed out')), timeoutMs);
          });
          const body = await Promise.race([read(abort.signal, forceRead), stopped]);
          if (lifecycle !== capturedLifecycle) return;
          // A notification during the read may already describe this response.
          if (captured !== version && (!body.revision || body.revision !== observedRevision || forceNext)) continue;
          tools = Array.isArray(body.tools) ? body.tools : [];
          revision = body.revision;
          error = undefined;
          settled = version;
        } catch (failure) {
          if (lifecycle !== capturedLifecycle) return;
          if (captured !== version) continue;
          tools = [];
          error = failure instanceof Error ? failure : new Error('Plugin catalog is unavailable');
          settled = version;
          onError(error);
          throw error;
        } finally { clearTimeout(timer); }
      }
    })().finally(() => {
      if (lifecycle === capturedLifecycle) { pending = undefined; controller = undefined; }
    });
    return pending;
  };

  const clear = () => {
    lifecycle++;
    unsubscribe?.();
    unsubscribe = undefined;
    controller?.abort(new Error('Plugin catalog cache cleared'));
    controller = undefined;
    pending = undefined;
    invalidate();
    settled = -1;
    revision = observedRevision = undefined;
    forceNext = false;
  };
  return { get tools() { return tools; }, get error() { return error; }, refresh, clear };
}
