import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { closeInProcessHttpServer } from '../../electron/server-host.ts';

test('packaged server closes on the first restart while an HTTP stream is active', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: live\n\n');
  });
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
      closeInProcessHttpServer(server),
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
