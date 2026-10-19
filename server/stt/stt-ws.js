/**
 * WebSocket bridge for live STT streaming (/api/stt/ws).
 */

import { WebSocketServer } from 'ws';
import { parseClientMessage } from './stt-protocol.js';
import { SttStreamSession } from './stream-session.js';
import { authorizeUpgrade } from '../runtime/request-auth.js';

/**
 * Attach STT WebSocket server to the HTTP server.
 * @param {import('http').Server} httpServer
 */
export function attachSttWebSocketServer(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/api/stt/ws') {
      return;
    }

    if (!authorizeUpgrade(req, socket)) return;

    wss.handleUpgrade(req, socket, head, (ws) => {
      const session = new SttStreamSession(ws);

      ws.on('message', (data, isBinary) => {
        if (isBinary) {
          session.handleAudio(data);
          return;
        }
        const text = typeof data === 'string' ? data : data.toString('utf8');
        const parsed = parseClientMessage(text);
        if (!parsed) return;
        if (parsed.type === 'start') {
          void session.handleStart();
        } else if (parsed.type === 'stop') {
          void session.handleStop();
        } else if (parsed.type === 'ping') {
          ws.send(JSON.stringify({ type: 'ready' }));
        }
      });

      const cleanup = () => {
        void session.dispose();
      };

      ws.on('close', cleanup);
      req.on('close', cleanup);
    });
  });

  return wss;
}
