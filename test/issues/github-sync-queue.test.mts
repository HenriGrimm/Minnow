import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GITHUB_SYNC_CONCURRENCY, runGithubSyncQueue } from '../../src/issues/github-sync-queue.ts';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

test('bulk sync overlaps independent issues, caps concurrency, and drains the queue', async () => {
  const firstWave = gate();
  let active = 0;
  let peak = 0;
  const started: number[] = [];
  const completed: number[] = [];
  const issues = Array.from({ length: 8 }, (_, id) => ({ id }));
  const pass = runGithubSyncQueue(issues, async ({ id }) => {
    started.push(id);
    peak = Math.max(peak, ++active);
    await firstWave.promise;
    active--;
    completed.push(id);
  });
  assert.equal(started.length, GITHUB_SYNC_CONCURRENCY);
  firstWave.release();
  await pass;
  assert.equal(peak, GITHUB_SYNC_CONCURRENCY);
  assert.deepEqual(completed.sort((a, b) => a - b), issues.map(({ id }) => id));
});

test('children wait for all parents, even when a parent completes out of order', async () => {
  const slowParent = gate();
  const started: string[] = [];
  const issues = [{ id: 'child', parentId: 'parent' }, { id: 'parent' }, { id: 'other' }];
  const pass = runGithubSyncQueue(issues, async ({ id }) => {
    started.push(id);
    if (id === 'parent') await slowParent.promise;
  });
  await Promise.resolve();
  assert.deepEqual(started, ['parent', 'other']);
  slowParent.release();
  await pass;
  assert.deepEqual(started, ['parent', 'other', 'child']);
});

test('cooldown or disabling sync stops queued work while in-flight issues finish', async () => {
  const inFlight = gate();
  let keepGoing = true;
  const started: string[] = [];
  const completed: string[] = [];
  const pass = runGithubSyncQueue([
    ...Array.from({ length: 7 }, (_, id) => ({ id: String(id) })),
    { id: 'child', parentId: '0' },
  ], async ({ id }) => {
    started.push(id);
    await inFlight.promise;
    keepGoing = false;
    completed.push(id);
  }, () => keepGoing);
  inFlight.release();
  await pass;
  assert.equal(started.length, GITHUB_SYNC_CONCURRENCY);
  assert.deepEqual(completed, started);
});
