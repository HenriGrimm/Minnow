import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { openSubAgentStream } from '../../src/agents/sub-agent-stream.ts';

class FakeSocket extends EventTarget {
  static instances: FakeSocket[] = [];
  closed = false;
  constructor(readonly url: URL) {
    super();
    FakeSocket.instances.push(this);
  }
  close() { this.closed = true; this.dispatchEvent(new Event('close')); }
  frame(type: string, data: unknown) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type, data }) }));
  }
}

const originalWindow = globalThis.window;
const originalSocket = globalThis.WebSocket;
beforeEach(() => {
  FakeSocket.instances = [];
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  globalThis.window = {
    location: { href: 'https://localhost:9473/' },
    __MINNOW_SESSION_TOKEN__: 'test-token',
    minnow: { viewContext: { workspacePath: 'C:/work/project' } },
  } as unknown as Window & typeof globalThis;
});
afterEach(() => {
  globalThis.window = originalWindow;
  globalThis.WebSocket = originalSocket;
});

test('authenticates, forwards frames, and stops reconnecting on done', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stream = openSubAgentStream('run with spaces');
  const socket = FakeSocket.instances[0];
  assert.equal(socket.url.protocol, 'wss:');
  assert.equal(socket.url.searchParams.get('runId'), 'run with spaces');
  assert.equal(socket.url.searchParams.get('token'), 'test-token');
  assert.equal(socket.url.searchParams.get('workspace'), 'C:/work/project');
  const received: unknown[] = [];
  stream.addEventListener('snapshot', (event) => received.push(JSON.parse(event.data)));
  socket.frame('snapshot', { seq: 4 });
  assert.deepEqual(received, [{ seq: 4 }]);
  socket.frame('done', {});
  t.mock.timers.tick(30_000);
  assert.equal(socket.closed, true);
  assert.equal(FakeSocket.instances.length, 1);
});

test('reconnects after disconnect and cancels a pending retry on close', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stream = openSubAgentStream('run-a');
  FakeSocket.instances[0].close();
  t.mock.timers.tick(1_000);
  assert.equal(FakeSocket.instances.length, 2);
  FakeSocket.instances[1].close();
  stream.close();
  t.mock.timers.tick(30_000);
  assert.equal(FakeSocket.instances.length, 2);
});
