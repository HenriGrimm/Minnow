import http from 'node:http';
import { WebSocketServer } from 'ws';
import { getNetworkAccess, isClientAllowed, isHostAllowed } from '../network/access.js';
import { authenticateMinnowToken } from './authenticate-token.js';

/** Multiplex read-only API streams, keeping Chromium's HTTP pool free for RPCs.
 * Loopback requests deliberately traverse the existing auth/workspace middleware.
 * Each channel has one chunk of credit; a slow reader cannot buffer without bound.
 */
export function attachStreamWebSocketServer(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/api/streams/ws') return;
    const token = url.searchParams.get('token') ?? '';
    const access = getNetworkAccess();
    const origin = req.headers.origin;
    const forbidden = !isClientAllowed(req, access) || !isHostAllowed(req.headers.host ?? '', access)
      || (origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`);
    if (forbidden || !authenticateMinnowToken(token)) {
      socket.end(`HTTP/1.1 ${forbidden ? '403 Forbidden' : '401 Unauthorized'}\r\nConnection: close\r\n\r\n`);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
      const channels = new Map();
      let alive = true;
      const send = (message) => {
        if (ws.readyState !== ws.OPEN) return;
        if (ws.bufferedAmount > 8 * 1024 * 1024) { ws.terminate(); return; }
        ws.send(JSON.stringify(message));
      };
      const stop = (id) => {
        const channel = channels.get(id);
        channels.delete(id);
        channel?.request.destroy();
        channel?.response?.destroy();
      };
      const heartbeat = setInterval(() => {
        if (!alive) { ws.terminate(); return; }
        alive = false;
        ws.ping();
      }, 15_000);
      heartbeat.unref();
      ws.on('pong', () => { alive = true; });
      ws.on('error', () => {});
      ws.once('close', () => {
        clearInterval(heartbeat);
        for (const id of channels.keys()) stop(id);
      });
      ws.on('message', (raw) => {
        let message;
        try { message = JSON.parse(raw.toString()); } catch { ws.close(1008); return; }
        if (!message || typeof message.id !== 'string' || message.id.length > 80) { ws.close(1008); return; }
        const { id, type } = message;
        if (type === 'cancel') { stop(id); return; }
        if (type === 'pull') {
          const channel = channels.get(id);
          if (channel?.waiting) { channel.waiting = false; channel.response.resume(); }
          return;
        }
        if (type !== 'open' || channels.has(id)) { ws.close(1008); return; }
        if (channels.size >= 256) { send({ id, type: 'error', error: 'Too many active streams' }); return; }
        // No arbitrary hosts, methods, headers or credentials through the tunnel.
        if (typeof message.path !== 'string' || !message.path.startsWith('/api/')
          || /[\r\n\\#]/.test(message.path)) {
          send({ id, type: 'error', error: 'Invalid stream path' }); return;
        }
        if (!authenticateMinnowToken(token)) { ws.close(1008, 'Unauthorized'); return; }
        const target = new URL(message.path, 'http://localhost');
        if (!target.pathname.startsWith('/api/')) {
          send({ id, type: 'error', error: 'Invalid stream path' }); return;
        }
        target.searchParams.delete('token');
        const headers = { 'X-Minnow-Token': token, Accept: 'text/event-stream' };
        if (typeof message.workspace === 'string') headers['X-Minnow-Workspace'] = message.workspace;
        if (typeof message.lastEventId === 'string') headers['Last-Event-ID'] = message.lastEventId;
        const channel = { request: null, response: null, waiting: false };
        const fail = () => {
          if (!channels.has(id)) return;
          send({ id, type: 'error', error: 'Stream connection interrupted' });
          stop(id);
        };
        try {
          channel.request = http.request({
            hostname: req.socket.localAddress,
            port: req.socket.localPort,
            path: target.pathname + target.search,
            method: 'GET', headers, agent: false,
          }, (response) => {
            channel.response = response;
            send({ id, type: 'headers', status: response.statusCode,
              contentType: response.headers['content-type'] ?? '' });
            response.on('data', (chunk) => {
              response.pause();
              channel.waiting = true;
              send({ id, type: 'data', data: chunk.toString('base64') });
            });
            response.on('end', () => { send({ id, type: 'end' }); stop(id); });
            response.on('error', fail);
            response.on('aborted', fail);
          });
          channels.set(id, channel);
          channel.request.on('error', fail);
          channel.request.end();
        } catch { send({ id, type: 'error', error: 'Invalid stream request' }); stop(id); }
      });
    });
  });
  server.once('close', () => { for (const ws of wss.clients) ws.terminate(); wss.close(); });
  return wss;
}
