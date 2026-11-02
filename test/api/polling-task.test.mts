import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPollingTask } from '../../src/lib/polling-task.ts';
import { createBoardListClient } from '../../src/orchestrator/client.ts';

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

test('a slow board list coalesces refreshes and stop discards its late response', async () => {
  let finish!: (value: any[]) => void;
  let signal!: AbortSignal;
  let calls = 0, notifications = 0;
  const list = createBoardListClient({ fetchBoards: nextSignal => {
    calls++; signal = nextSignal!; return new Promise(resolve => { finish = resolve; });
  } });
  list.subscribe(() => { notifications++; });
  const pending = list.refresh();
  for (let i = 0; i < 30; i++) void list.refresh();
  await settle();
  assert.equal(calls, 1);
  list.stop();
  assert.equal(signal.aborted, true);
  finish([{ boardId: 'old' }]); await pending;
  assert.deepEqual(list.getBoards(), []);
  assert.equal(notifications, 0);
});

test('stopping and restarting a board list cannot accept the previous lifetime response', async () => {
  const reads: ((value: any[]) => void)[] = [];
  const list = createBoardListClient({ intervalMs: 60_000, fetchBoards: () => new Promise(resolve => reads.push(resolve)) });
  try {
    const old = list.refresh(); await settle(); list.stop(); list.start(); await settle();
    reads[1]([{ boardId: 'current' }]); await settle();
    reads[0]([{ boardId: 'old' }]); await old;
    assert.equal(list.getBoards()[0].boardId, 'current');
  } finally { list.stop(); }
});
