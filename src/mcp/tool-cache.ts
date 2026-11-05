import type { OpenAIFunctionDefinition } from '../tools/definitions';
import { createRefreshGate } from '../tools/refresh-gate';
import { StreamEventSource } from '../api/stream-event-source';

type Catalog = { tools?: OpenAIFunctionDefinition[]; revision?: string };

function subscribeChanges(onRevision: (revision: string) => void): () => void {
  if (typeof window === 'undefined' || !/^https?:/.test(window.location.href)) return () => {};
  const source = new StreamEventSource('/api/mcp/events');
  source.onmessage = event => {
    try {
      const body = JSON.parse(event.data) as { revision?: string };
      if (typeof body.revision === 'string') onRevision(body.revision);
    } catch { /* ignore malformed event data */ }
  };
  return () => source.close();
}

/** Renderer catalog reads are driven by server revisions, never by elapsed time. */
export function createMcpToolCache({
  read = async (): Promise<Catalog> => {
    const response = await fetch('/api/mcp/tools');
    if (!response.ok) throw new Error('MCP catalog is unavailable');
    return response.json() as Promise<Catalog>;
  },
  subscribe = subscribeChanges,
} = {}) {
  let tools: OpenAIFunctionDefinition[] = [];
  let revision: string | undefined;
  let loaded = false;
  let unsubscribe: (() => void) | undefined;
  let epoch = 0;
  const load = async () => {
    const capturedEpoch = epoch;
    const body = await read();
    if (epoch !== capturedEpoch) return;
    tools = Array.isArray(body.tools) ? body.tools : [];
    revision = body.revision;
    loaded = true;
    // The initial stream snapshot catches changes during the read or a reconnect.
    unsubscribe ??= subscribe(next => {
      if (!loaded || revision !== next) void refresh();
    });
  };
  let gate = createRefreshGate(load);
  const refresh = async (force = true): Promise<void> => {
    const capturedEpoch = epoch;
    const capturedGate = gate;
    try { await capturedGate(force ? 0 : Infinity); }
    catch {
      if (epoch !== capturedEpoch) return;
      tools = [];
      loaded = false;
      if (gate === capturedGate) gate = createRefreshGate(load);
    }
  };
  const clear = () => {
    epoch++;
    unsubscribe?.();
    unsubscribe = undefined;
    tools = [];
    revision = undefined;
    loaded = false;
    gate = createRefreshGate(load);
  };
  return { get tools() { return tools; }, refresh, clear };
}
