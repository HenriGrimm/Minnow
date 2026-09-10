import { withSessionToken } from '../../api/session-token';

type Listener = (type: string, data: Record<string, any>) => void;
const streams = new Map<string, { stream: EventSource; listeners: Set<Listener> }>();

/** Share one connection between the claim loop and the visible activity panel. */
export function subscribeSuperPlanEvents(runId: string, listener: Listener): () => void {
  let entry = streams.get(runId);
  if (!entry) {
    const stream = new EventSource(withSessionToken(`/api/super-plan/${encodeURIComponent(runId)}/events`));
    entry = { stream, listeners: new Set() };
    streams.set(runId, entry);
    const subscribers = entry.listeners;
    for (const type of ['snapshot', 'event', 'live']) stream.addEventListener(type, (event) => {
      let data: Record<string, any>;
      try { data = JSON.parse((event as MessageEvent).data); } catch { return; }
      for (const callback of subscribers) callback(type, data);
    });
  }
  entry.listeners.add(listener);
  const subscribed = entry;
  return () => {
    subscribed.listeners.delete(listener);
    if (!subscribed.listeners.size) {
      subscribed.stream.close();
      if (streams.get(runId) === subscribed) streams.delete(runId);
    }
  };
}
