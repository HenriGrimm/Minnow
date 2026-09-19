import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WebSocket as NodeWebSocket } from 'ws';
import { attachStreamWebSocketServer } from '../../server/runtime/stream-ws.js';
import { createAuthMiddleware } from '../../server/runtime/auth-middleware.js';
import { getSessionToken, resetSessionTokenCache } from '../../server/runtime/session-token.js';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { streamFetch } from '../../src/api/stream-fetch.ts';
import { StreamEventSource } from '../../src/api/stream-event-source.ts';

const previousHome = process.env.MINNOW_HOME;
const home = await mkdtemp(path.join(os.tmpdir(), 'minnow-stream-test-'));
process.env.MINNOW_HOME = home;
resetMinnowHomeCache(); resetSessionTokenCache();
const token = getSessionToken();
const auth = createAuthMiddleware();
const active = new Set<http.ServerResponse>();
let lastId = '';
let connections = 0;
const server = http.createServer((req, res) => auth(req, res, () => {
  if (req.url === '/api/ping') { res.end('pong'); return; }
  if (req.url === '/api/missing') { res.writeHead(404); res.end('missing'); return; }
  if (req.url === '/api/no-content') { res.writeHead(204); res.end(); return; }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  active.add(res);
  res.once('close', () => active.delete(res));
  if (req.url === '/api/reconnect') {
    lastId = String(req.headers['last-event-id'] ?? '');
    res.end('id: 42\nretry: 250\ndata: replay\n\n'); return;
  }
  if (req.url === '/api/utf8') {
    const data = Buffer.from('event: custom\r\ndata: hé🐟\r\ndata: second\r\nid: 9\r\n\r\n');
    for (const byte of data) res.write(Buffer.from([byte]));
    return;
  }
  res.write(`data: ${req.headers['x-minnow-workspace'] || 'ready'}\n\n`);
}));
const wss = attachStreamWebSocketServer(server);
wss.on('connection', () => { connections += 1; });
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as any).port}`;
const originalWindow = globalThis.window;
const originalWs = globalThis.WebSocket;
Object.assign(globalThis, {
  window: { location: { href: base, origin: base }, __MINNOW_SESSION_TOKEN__: token },
  WebSocket: NodeWebSocket,
});

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

after(async () => {
  for (const ws of wss.clients) ws.terminate();
  for (const res of active) res.destroy();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  Object.assign(globalThis, { window: originalWindow, WebSocket: originalWs });
  if (previousHome === undefined) delete process.env.MINNOW_HOME;
  else process.env.MINNOW_HOME = previousHome;
  resetMinnowHomeCache(); resetSessionTokenCache();
  await rm(home, { recursive: true, force: true });
});

test('32 simultaneous streams share one socket; HTTP RPC and channel cancellation stay independent', async () => {
  const responses = await Promise.all(Array.from({ length: 32 }, (_, index) =>
    streamFetch(`/api/live?workspace=project-${index}`)));
  const readers = responses.map((response) => response.body!.getReader());
  const chunks = await Promise.all(readers.map((reader) => reader.read()));
  chunks.forEach((chunk, index) => assert.equal(new TextDecoder().decode(chunk.value), `data: project-${index}\n\n`));
  assert.equal(connections, 1);
  assert.equal(active.size, 32);
  const ping = await fetch(`${base}/api/ping`, { headers: { 'X-Minnow-Token': token }, signal: AbortSignal.timeout(1000) });
  assert.equal(await ping.text(), 'pong');
  await readers[0].cancel();
  await until(() => active.size === 31);
  await Promise.all(readers.slice(1).map((reader) => reader.cancel()));
  await until(() => active.size === 0);
});

test('HTTP errors retain status/body and abort releases only its subscription', async () => {
  const missing = await streamFetch('/api/missing');
  assert.equal(missing.status, 404);
  assert.equal(await missing.text(), 'missing');
  const controller = new AbortController();
  const response = await streamFetch('/api/live', { signal: controller.signal });
  const reader = response.body!.getReader();
  await reader.read();
  controller.abort();
  await assert.rejects(reader.read(), { name: 'AbortError' });
  await until(() => active.size === 0);
});

test('EventSource parses fragmented Unicode, named events, multiline data and ids', async () => {
  const source = new StreamEventSource('/api/utf8');
  const [event] = await once(source, 'custom') as [MessageEvent];
  assert.equal(event.data, 'hé🐟\nsecond');
  assert.equal(event.lastEventId, '9');
  source.close();
  await until(() => active.size === 0);
});

test('EventSource reconnect sends Last-Event-ID and close stops reconnection', async () => {
  const source = new StreamEventSource('/api/reconnect');
  let messages = 0;
  source.onmessage = () => { messages += 1; if (messages === 2) source.close(); };
  await until(() => messages === 2);
  assert.equal(lastId, '42');
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(messages, 2);
});

test('204 stops EventSource permanently', async () => {
  const source = new StreamEventSource('/api/no-content');
  await until(() => source.readyState === source.CLOSED);
});

test('socket loss fails readers promptly and the next subscription reconnects', async () => {
  const response = await streamFetch('/api/live');
  const reader = response.body!.getReader();
  await reader.read();
  const pending = assert.rejects(reader.read(), /connection interrupted/);
  for (const ws of wss.clients) ws.terminate();
  await pending;
  const next = await streamFetch('/api/live');
  await next.body!.cancel();
  assert.equal(connections, 2);
  await until(() => active.size === 0);
});

test('upgrade rejects invalid credentials and cross-origin requests', async () => {
  for (const options of [{ token: 'bad', origin: base }, { token, origin: 'https://evil.example' }]) {
    const ws = new NodeWebSocket(`${base.replace('http:', 'ws:')}/api/streams/ws?token=${options.token}`, { origin: options.origin });
    await assert.rejects(once(ws, 'open'), /Unexpected server response: (401|403)/);
  }
});

test('a paused channel receives no further bytes until it grants read credit', async () => {
  const ws = new NodeWebSocket(`${base.replace('http:', 'ws:')}/api/streams/ws?token=${token}`);
  await once(ws, 'open');
  const data: string[] = [];
  ws.on('message', (raw) => {
    const message = JSON.parse(String(raw));
    if (message.type === 'data') data.push(Buffer.from(message.data, 'base64').toString());
  });
  ws.send(JSON.stringify({ id: 'slow', type: 'open', path: '/api/live' }));
  await until(() => data.length === 1);
  for (const response of active) response.write('data: second\n\n');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(data.length, 1);
  ws.send(JSON.stringify({ id: 'slow', type: 'pull' }));
  await until(() => data.length === 2);
  assert.equal(data[1], 'data: second\n\n');
  ws.close();
  await until(() => active.size === 0);
});

test('cancelling before headers releases the pending request', async () => {
  const controller = new AbortController();
  const pending = streamFetch('/api/live', { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(active.size, 0);
});
