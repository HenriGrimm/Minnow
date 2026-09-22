import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRefreshGate } from '../../src/tools/refresh-gate';

test('discovery freshness, concurrent deduplication, and forced refresh', async () => {
  let now = 0, loads = 0;
  const refresh = createRefreshGate(async () => { loads++; }, () => now);
  await Promise.all([refresh(30000), refresh(30000), refresh(30000)]);
  assert.equal(loads, 1);
  now = 29999;
  await refresh(30000);
  assert.equal(loads, 1);
  await refresh(); // Settings callers force a fresh fetch.
  assert.equal(loads, 2);
  now += 30000;
  await refresh(30000);
  assert.equal(loads, 3);
});

test('a rejected refresh is retryable, not cached', async () => {
  let calls = 0;
  const refresh = createRefreshGate(async () => { if (++calls === 1) throw Error('offline'); });
  await assert.rejects(refresh(30000), /offline/);
  await refresh(30000);
  assert.equal(calls, 2);
});

test('settings refresh during discovery waits for a fresh post-mutation request', async () => {
  let release!: () => void;
  let loads = 0;
  const refresh = createRefreshGate(async () => {
    if (++loads === 1) await new Promise<void>(resolve => { release = resolve; });
  });
  const old = refresh(30000);
  await Promise.resolve();
  const forced = refresh();
  const alsoForced = refresh();
  release();
  await Promise.all([old, forced, alsoForced]);
  assert.equal(loads, 2);
});
