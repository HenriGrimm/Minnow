import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import { createInProcessHttpServerCloser } from '../../electron/server-host.ts';

test('packaged server closes on the first restart while an HTTP stream is active', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: live\n\n');
  });
  const closeHttpServer = createInProcessHttpServerCloser(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as { port: number }).port;
  const request = http.get(`http://127.0.0.1:${port}/stream`);
  request.on('error', () => {});
  const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
    request.once('response', resolve);
    request.once('error', reject);
  });
  response.on('error', () => {});

  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      closeHttpServer(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('server close waited on the active stream')), 1_000);
      }),
    ]);
    assert.equal(server.listening, false);
  } finally {
    if (timer) clearTimeout(timer);
    request.destroy();
    if (server.listening) server.closeAllConnections();
  }
});

test('packaged server closes while upgraded WebSocket connections are active', async (t) => {
  const server = http.createServer();
  const closeHttpServer = createInProcessHttpServerCloser(server);
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('error', () => {});
      wss.emit('connection', ws, req);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const clients = [new WebSocket(`ws://127.0.0.1:${port}/streams`), new WebSocket(`ws://127.0.0.1:${port}/agents`)];
  let timer: NodeJS.Timeout | undefined;
  t.after(() => {
    if (timer) clearTimeout(timer);
    for (const ws of clients) ws.terminate();
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    server.closeAllConnections();
    if (server.listening) server.close();
  });
  await Promise.all(clients.map((ws) => new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  })));
  assert.equal(wss.clients.size, 2);
  const connectionsClosed = Promise.all([...wss.clients].map((ws) =>
    new Promise<void>((resolve) => ws.once('close', resolve)),
  ));
  await Promise.race([
    closeHttpServer().then(() => connectionsClosed),
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('server close waited on active WebSockets')), 1_000);
    }),
  ]);
  assert.equal(server.listening, false);
  assert.equal(wss.clients.size, 0);
});
