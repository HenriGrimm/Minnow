import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPollingTask } from '../../src/lib/polling-task.ts';

const settle = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('timer and manual triggers share one pending read without queuing more reads', async () => {
  const read = deferred();
  let calls = 0;
  const task = createPollingTask(async () => { calls++; await read.promise; });
  const pending = task.run();
  for (let i = 0; i < 100; i++) assert.equal(task.run(), pending);
  await settle();
  assert.equal(calls, 1);
  read.resolve(); await pending;
  await settle();
  assert.equal(calls, 1, 'settlement must not replay skipped timer ticks');
});

test('cancellation aborts the read and late settlement cannot unlock a replacement read', async () => {
  const reads: { signal: AbortSignal; done: ReturnType<typeof deferred> }[] = [];
  const task = createPollingTask(async signal => {
    const done = deferred(); reads.push({ signal, done }); await done.promise;
  });
  const old = task.run(); await settle(); task.cancel();
  assert.equal(reads[0].signal.aborted, true);
  const next = task.run(); await settle();
  reads[0].done.resolve(); await old;
  assert.equal(task.run(), next);
  reads[1].done.resolve(); await next;
});

test('a stalled HTTP read is aborted at its deadline and the next poll can recover', async () => {
  let aborted = false;
  const task = createPollingTask(signal => new Promise<void>((_, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
  }), 20);
  await task.run();
  assert.equal(aborted, true);
  await task.run();
});

test('read failures release the guard and remain visible to the caller', async () => {
  let calls = 0;
  const task = createPollingTask(async () => { if (++calls === 1) throw new Error('offline'); });
  await assert.rejects(task.run(), /offline/);
  await task.run();
  assert.equal(calls, 2);
});
