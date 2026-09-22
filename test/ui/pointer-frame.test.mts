import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPointerFrame } from '../../src/ui/pointer-frame.ts';

test('a burst of pointer events paints once, and release flushes the last position', () => {
  const previous = globalThis.window;
  const callbacks = new Map<number, FrameRequestCallback>();
  let id = 0;
  globalThis.window = {
    requestAnimationFrame: (cb: FrameRequestCallback) => { callbacks.set(++id, cb); return id; },
    cancelAnimationFrame: (key: number) => { callbacks.delete(key); },
  } as unknown as Window & typeof globalThis.window;
  try {
    const positions: number[] = [];
    const frame = createPointerFrame((x) => positions.push(x));
    for (let x = 1; x <= 200; x++) frame.schedule(x);
    assert.equal(callbacks.size, 1);
    assert.equal(positions.length, 0);
    callbacks.values().next().value!(0);
    assert.deepEqual(positions, [200]);
    frame.schedule(250);
    frame.schedule(300);
    frame.flush();
    assert.deepEqual(positions, [200, 300]);
    assert.equal(callbacks.size, 0, 'release cancels its queued frame');
    frame.flush();
    assert.equal(positions.length, 2, 'lost capture after release must not paint again');
  } finally {
    globalThis.window = previous;
  }
});
