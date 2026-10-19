import { WebSocketServer } from 'ws';
import { authorizeUpgrade } from '../runtime/request-auth.js';
import { subscribeAgentEvents } from './middleware.js';

/** Agent streams use upgraded sockets so additional windows cannot fill the HTTP pool. */
export function attachAgentsWebSocketServer(httpServer) {
  const wss = new WebSocketServer({ noServer: true });
  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/api/agents/ws') return;
    if (!authorizeUpgrade(req, socket)) return;
    if (!url.searchParams.get('runId')) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const heartbeat = setInterval(() => {
        if (ws.readyState === ws.OPEN) ws.ping();
      }, 15_000);
      ws.once('close', () => clearInterval(heartbeat));
      const transport = {
        send(type, data, id) {
          if (ws.readyState !== ws.OPEN) return false;
          ws.send(JSON.stringify({ type, data, id }));
          return true;
        },
        close: () => ws.close(),
        isClosed: () => ws.readyState !== ws.OPEN,
        onClose(cleanup) {
          ws.once('close', cleanup);
          ws.once('error', cleanup);
        },
      };
      // Reconnect with a fresh fold; journal sequence filtering remains client-side.
      void subscribeAgentEvents(url.searchParams.get('runId'), transport).catch((err) => {
        console.warn('[agents] WebSocket subscription failed:', err.message);
        ws.close(1011, 'Subscription failed');
      });
    });
  });
  return wss;
}
