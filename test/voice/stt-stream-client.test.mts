import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { SttStreamClient } from '../../src/voice/stt-stream-client.ts';

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalWebSocket = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');

class FakeSocket {
  static OPEN = 1;
  readyState = 1;
  closed = false;
  onopen?: () => void;
  onclose?: () => void;
  onerror?: () => void;
  onmessage?: (event: { data: string }) => void;
  send() {}
  close() { this.closed = true; this.onclose?.(); }
}

function installSocket(create: (socket: FakeSocket) => void): FakeSocket[] {
  const sockets: FakeSocket[] = [];
  class Socket extends FakeSocket {
    constructor() {
      super();
      sockets.push(this);
      create(this);
    }
  }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    location: { protocol: 'http:', host: 'localhost:9473' },
  } });
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: Socket });
  return sockets;
}

afterEach(() => {
  for (const [key, descriptor] of [['window', originalWindow], ['WebSocket', originalWebSocket]] as const) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('close before ready rejects startup and closes the socket', async () => {
  const sockets = installSocket((socket) => queueMicrotask(() => socket.close()));
  const client = new SttStreamClient();
  await assert.rejects(client.start(), /closed before ready/);
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].closed, true);
  client.close();
});

test('silent server hits readiness deadline and can be retried', async () => {
  const sockets = installSocket(() => {});
  const client = new SttStreamClient({ readyTimeoutMs: 15 });
  await assert.rejects(client.start(), /did not become ready in time/);
  assert.equal(sockets[0].closed, true);
  await assert.rejects(client.start(), /did not become ready in time/);
  assert.equal(sockets.length, 2);
  assert.equal(sockets[1].closed, true);
});

test('explicit cancellation rejects startup and clears its deadline', async () => {
  const sockets = installSocket(() => {});
  const client = new SttStreamClient({ readyTimeoutMs: 100 });
  const starting = client.start();
  client.close();
  await assert.rejects(starting, /cancelled before ready/);
  assert.equal(sockets[0].closed, true);
});
