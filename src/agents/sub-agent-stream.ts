import { withSessionToken } from '../api/session-token';
import type { EventStream } from './sub-agent-client';

/** Preserve the event interface without occupying Chromium's shared HTTP/1.1 pool. */
export function openSubAgentStream(runId: string): EventStream {
  const listeners = new Map<string, Set<(event: { data: string }) => void>>();
  let socket: WebSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let delay = 1_000;
  const close = () => {
    closed = true;
    clearTimeout(retry);
    socket?.close();
    socket = null;
  };
  const connect = () => {
    if (closed) return;
    const url = new URL(withSessionToken(`/api/agents/ws?runId=${encodeURIComponent(runId)}`), window.location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const current = new WebSocket(url);
    socket = current;
    current.addEventListener('message', (event) => {
      if (closed || socket !== current) return;
      try {
        const frame = JSON.parse(String(event.data));
        if (typeof frame.type !== 'string') return;
        delay = 1_000;
        for (const listener of listeners.get(frame.type) ?? []) {
          listener({ data: JSON.stringify(frame.data) });
        }
        if (frame.type === 'done') close();
      } catch (err) {
        console.error('[agents] could not read WebSocket frame', err);
      }
    });
    current.addEventListener('close', () => {
      if (closed || socket !== current) return;
      socket = null;
      retry = setTimeout(connect, delay);
      delay = Math.min(delay * 2, 15_000);
    });
  };
  connect();
  return {
    addEventListener(type, listener) {
      let set = listeners.get(type);
      if (!set) listeners.set(type, set = new Set());
      set.add(listener);
    },
    close,
  };
}
