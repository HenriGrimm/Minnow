import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPreviewCaptureGate } from '../../electron/preview-capture-gate.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('an idle guest resolves whenIdle immediately', async () => {
  const gate = createPreviewCaptureGate();
  const guest = {};
  assert.equal(gate.inFlight(guest), 0);
  await gate.whenIdle(guest);
});

test('whenIdle waits for every tracked capture, including a rejected one', async () => {
  const gate = createPreviewCaptureGate();
  const guest = {};
  const first = deferred<string>();
  const second = deferred<string>();
  const tracked = gate.track(guest, first.promise);
  void gate.track(guest, second.promise).catch(() => {});
  assert.equal(gate.inFlight(guest), 2);

  let idle = false;
  const waiting = gate.whenIdle(guest).then(() => { idle = true; });
  first.resolve('frame');
  assert.equal(await tracked, 'frame');
  await Promise.resolve();
  assert.equal(idle, false);

  second.reject(new Error('capture timed out'));
  await waiting;
  assert.equal(idle, true);
  assert.equal(gate.inFlight(guest), 0);
});

test('a capture tracked while waiting extends the wait', async () => {
  const gate = createPreviewCaptureGate();
  const guest = {};
  const first = deferred<string>();
  const late = deferred<string>();
  void gate.track(guest, first.promise);
  let idle = false;
  const waiting = gate.whenIdle(guest).then(() => { idle = true; });
  void gate.track(guest, late.promise);
  first.resolve('a');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(idle, false);
  late.resolve('b');
  await waiting;
  assert.equal(idle, true);
});

test('guests are tracked independently', async () => {
  const gate = createPreviewCaptureGate();
  const busy = {};
  const idleGuest = {};
  const capture = deferred<string>();
  void gate.track(busy, capture.promise);
  assert.equal(gate.inFlight(busy), 1);
  assert.equal(gate.inFlight(idleGuest), 0);
  await gate.whenIdle(idleGuest);
  capture.resolve('x');
  await gate.whenIdle(busy);
  assert.equal(gate.inFlight(busy), 0);
});
