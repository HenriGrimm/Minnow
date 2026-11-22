import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { superviseBackend } from '../../electron/backend-process.ts';

const endpoint = { url: 'http://127.0.0.1:55321/', token: 'a'.repeat(64) };

class FakeBackend extends EventEmitter {
  sent: unknown[] = [];
  killed = 0;

  postMessage(message: unknown): void {
    this.sent.push(message);
  }

  kill(): boolean {
    this.killed += 1;
    return true;
  }

  announce(value = endpoint): void {
    this.emit('message', { type: 'ready', ...value });
  }
}

test('only accepts the authenticated loopback endpoint and clears it on process loss', async () => {
  const child = new FakeBackend();
  const exits: number[] = [];
  const backend = superviseBackend(child, code => exits.push(code));
  child.announce({ ...endpoint, url: 'http://localhost:9473/' });
  child.announce({ ...endpoint, url: 'http://127.0.0.1:99999/' });
  child.announce({ ...endpoint, token: '' });
  assert.equal(backend.endpoint(), undefined);
  child.announce();
  assert.deepEqual(await backend.ready, endpoint);
  child.announce({ ...endpoint, url: 'http://127.0.0.1:9473/' });
  assert.deepEqual(backend.endpoint(), endpoint);
  child.emit('exit', 0);
  assert.equal(backend.endpoint(), undefined);
  assert.deepEqual(exits, [0]);
  await backend.close();
  assert.deepEqual(child.sent, []);
});

test('reports a pre-ready exit through startup and skips the recovery prompt', async () => {
  const child = new FakeBackend();
  const backend = superviseBackend(child, () => assert.fail('Unexpected recovery callback'));
  child.emit('exit', 9);
  await assert.rejects(backend.ready, /before it was ready \(code 9\)/);
  await backend.close();
});

test('bounds startup and rejects readiness after the timeout', async () => {
  const child = new FakeBackend();
  const backend = superviseBackend(child, () => assert.fail('Unexpected recovery callback'), { startupMs: 5 });
  await assert.rejects(backend.ready, /did not become ready in time/);
  child.announce();
  assert.equal(backend.endpoint(), undefined);
  assert.equal(child.killed, 1);
  child.emit('exit', 1);
  await backend.close();
});

test('coalesces planned shutdown and waits for the child to exit', async () => {
  const child = new FakeBackend();
  const backend = superviseBackend(child, () => assert.fail('Unexpected recovery callback'));
  child.announce();
  await backend.ready;
  const closing = backend.close();
  assert.equal(backend.close(), closing);
  assert.deepEqual(child.sent, [{ type: 'shutdown' }]);
  let settled = false;
  void closing.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  child.emit('exit', 0);
  await closing;
  assert.equal(backend.endpoint(), undefined);
  assert.equal(child.killed, 0);
});

test('kills an unresponsive child and bounds the wait for its exit notification', async () => {
  const child = new FakeBackend();
  const backend = superviseBackend(child, () => assert.fail('Unexpected recovery callback'), { shutdownMs: 5, reapMs: 5 });
  child.announce();
  await backend.ready;
  await assert.rejects(backend.close(), /did not exit/);
  assert.equal(child.killed, 1);
  child.emit('exit', 1);
});
