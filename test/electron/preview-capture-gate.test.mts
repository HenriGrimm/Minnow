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

import { createPreviewCaptureVisibility, previewCaptureGate } from '../../electron/preview-capture-gate.ts';
import { previewCapturePageBase64 } from '../../electron/preview-guest-actions.ts';
import type { WebContents } from 'electron';

test('caller timeout does not release raw copy or allow another placeholder', async () => {
  const raw = deferred<any>();
  let calls = 0;
  const wc = {
    isDestroyed: () => false,
    capturePage: () => { calls++; return raw.promise; },
  } as unknown as WebContents;
  const options = { immediate: true, captureTimeoutMs: 5 };
  assert.equal(await previewCapturePageBase64(wc, options), '');
  assert.equal(previewCaptureGate.inFlight(wc), 1);
  let finished = false;
  const visibility = createPreviewCaptureVisibility(previewCaptureGate);
  visibility.hide(wc, () => { finished = true; });
  assert.equal(await previewCapturePageBase64(wc, options), '');
  assert.equal(calls, 1);
  assert.equal(finished, false);
  raw.resolve({ toPNG: () => Buffer.from('frame') });
  await previewCaptureGate.whenIdle(wc);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(finished, true);
  assert.equal(previewCaptureGate.inFlight(wc), 0);
});

test('show cancels deferred zero-size and detach, and only the latest hide runs', async () => {
  const gate = createPreviewCaptureGate();
  const visibility = createPreviewCaptureVisibility(gate);
  const guest = {};
  const raw = deferred<string>();
  gate.track(guest, raw.promise);
  const actions: string[] = [];
  visibility.hide(guest, () => { actions.push('zero', 'detach'); });
  visibility.change(guest); // late show
  raw.resolve('frame');
  await gate.whenIdle(guest);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(actions, []);
  const next = deferred<string>();
  gate.track(guest, next.promise);
  visibility.hide(guest, () => { actions.push('old hide'); });
  visibility.hide(guest, () => { actions.push('latest hide'); });
  next.reject(new Error('native copy failed'));
  await gate.whenIdle(guest);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(actions, ['latest hide']);
});

test('temporary reveal ownership is invalidated by later show or hide, not another surface', () => {
  const visibility = createPreviewCaptureVisibility(createPreviewCaptureGate());
  const guest = {};
  const temporary = visibility.change(guest);
  visibility.change({});
  assert.equal(visibility.isCurrent(guest, temporary), true);
  visibility.change(guest);
  assert.equal(visibility.isCurrent(guest, temporary), false);
  const second = visibility.change(guest);
  visibility.hide(guest, () => {});
  assert.equal(visibility.isCurrent(guest, second), false);
});

test('a hide during paint waits prevents the subsequent native copy', async () => {
  let visible = true;
  let copies = 0;
  const wc = {
    isDestroyed: () => false,
    isLoading: () => false,
    executeJavaScript: async () => { visible = false; },
    capturePage: async () => { copies++; throw new Error('must not capture'); },
  } as unknown as WebContents;
  assert.equal(await previewCapturePageBase64(wc, { canCapture: () => visible }), '');
  assert.equal(copies, 0);
});
