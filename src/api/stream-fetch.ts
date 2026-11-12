import { getSessionToken } from './session-token';
import { getViewWorkspacePath } from '../state/view-workspace';

type Channel = {
  open: () => void;
  receive: (message: Record<string, any>) => void;
  fail: (error: Error) => void;
};
const channels = new Map<string, Channel>();
let socket: WebSocket | undefined;
let nextId = 0;

function connection(): WebSocket {
  if (socket && socket.readyState < WebSocket.CLOSING) return socket;
  const url = new URL('/api/streams/ws', window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('token', getSessionToken());
  const current = new WebSocket(url);
  socket = current;
  const timeout = setTimeout(() => { fail(); current.close(); }, 15_000);
  const fail = () => {
    clearTimeout(timeout);
    if (socket !== current) return;
    socket = undefined;
    for (const channel of [...channels.values()]) channel.fail(new Error('Live connection interrupted'));
  };
  current.onopen = () => {
    clearTimeout(timeout);
    for (const channel of channels.values()) channel.open();
  };
  current.onmessage = (event) => {
    try {
      const message = JSON.parse(String(event.data));
      channels.get(message.id)?.receive(message);
    } catch { fail(); current.close(); }
  };
  current.onerror = fail;
  current.onclose = fail;
  return current;
}

/** GET a streaming API response without leasing a browser HTTP connection.
 * Reconnection/replay belongs to the subscriber, just as with a failed fetch.
 * Node/headless callers retain HTTP; browsers never fall back into pool starvation.
 */
export function streamFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (typeof window === 'undefined' || !/^https?:/.test(window.location.href)) return fetch(path, init);
  if (typeof WebSocket === 'undefined') return Promise.reject(new Error('Live connections require WebSocket support'));
  const url = new URL(path, window.location.href);
  if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/')
    || (init.method && init.method !== 'GET')) return Promise.reject(new Error('Invalid stream request'));
  return tunnel(url, init);
}

/** Mirrors STREAM_RPC_PATHS in server/runtime/stream-ws.js. */
const RPC_PATHS = new Set(['/api/chat-turns', '/api/tools', '/api/tools/workspace-files']);
// Leave headroom under the server's 1 MiB frame limit for the JSON envelope.
const MAX_RPC_BODY_BYTES = 768 * 1024;

/** POST JSON to a tunnelled RPC route. Lease renewals and tool calls ride the
 * shared socket so several running chats cannot exhaust Chromium's six HTTP
 * connections and starve each other's heartbeats. Oversized bodies (one-off
 * file writes) and non-browser callers keep using HTTP.
 */
export function rpcFetch(path: '/api/chat-turns' | '/api/tools' | '/api/tools/workspace-files', body: string, init: { signal?: AbortSignal } = {}): Promise<Response> {
  const viaHttp = () => fetch(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: init.signal,
  });
  // Tokenless views (paired devices, harnesses) never run leases or tools: plain HTTP.
  if (typeof window === 'undefined' || !/^https?:/.test(window.location.href)
    || typeof WebSocket === 'undefined' || !RPC_PATHS.has(path) || !getSessionToken()) return viaHttp();
  // The body travels as an escaped JSON string inside the envelope.
  const framed = JSON.stringify(body);
  if (framed.length * 3 > MAX_RPC_BODY_BYTES && new TextEncoder().encode(framed).length > MAX_RPC_BODY_BYTES) return viaHttp();
  return tunnel(new URL(path, window.location.href), { signal: init.signal }, body);
}

function tunnel(url: URL, init: RequestInit, rpcBody?: string): Promise<Response> {
  if (init.signal?.aborted) return Promise.reject(init.signal.reason);
  return new Promise((resolve, reject) => {
    const id = String(++nextId);
    const ws = connection();
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let finished = false;
    let waiting = false;
    const send = (type: string, extra = {}) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id, type, ...extra }));
    };
    const cleanup = () => {
      finished = true;
      channels.delete(id);
      init.signal?.removeEventListener('abort', abort);
    };
    const fail = (error: Error) => {
      if (finished) return;
      cleanup();
      send('cancel');
      reject(error);
      controller?.error(error);
    };
    const abort = () => fail(init.signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    const pull = () => {
      if (waiting) { waiting = false; send('pull'); }
    };
    channels.set(id, {
      fail,
      open: () => send('open', {
        path: url.pathname + url.search,
        workspace: getViewWorkspacePath() || url.searchParams.get('workspace') || '',
        lastEventId: new Headers(init.headers).get('Last-Event-ID') ?? '',
        ...(rpcBody !== undefined ? { method: 'POST', body: rpcBody } : {}),
      }),
      receive(message) {
        if (message.type === 'headers') {
          const body = new ReadableStream<Uint8Array>({
            start(value) { controller = value; }, pull,
            cancel() { cleanup(); send('cancel'); },
          });
          resolve(new Response(message.status === 204 || message.status === 304 ? null : body, {
            status: message.status, headers: { 'Content-Type': message.contentType },
          }));
        } else if (message.type === 'data') {
          const bytes = Uint8Array.from(atob(message.data), (char) => char.charCodeAt(0));
          waiting = true;
          controller?.enqueue(bytes);
          if ((controller?.desiredSize ?? 0) > 0) pull();
        } else if (message.type === 'end') {
          cleanup(); controller?.close();
        } else if (message.type === 'error') fail(new Error(message.error));
      },
    });
    init.signal?.addEventListener('abort', abort, { once: true });
    if (ws.readyState === WebSocket.OPEN) channels.get(id)?.open();
  });
}
