import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RouterScheduler, entryKey, validateRouters } from '../../server/model-routers/scheduler.js';

const router = (policy = 'priority') => ({ id: 'router', name: 'Router', enabled: true, policy, entries: ['a', 'b', 'c'].map((id) => ({ id, providerId: 'provider', modelId: id, enabled: true, concurrencyLimit: 1 })) });
test('priority, eligibility, stickiness and failover use provider/model identities', () => {
  const scheduler = new RouterScheduler(); const r = router();
  assert.equal(scheduler.select(r, 'chat', () => true).id, 'a');
  r.entries.reverse();
  assert.equal(scheduler.select(r, 'chat', () => true).id, 'a');
  assert.equal(scheduler.select(r, 'chat', () => true, new Set([entryKey(r.entries[2])])).id, 'c');
  assert.equal(scheduler.select(r, 'chat', () => true).id, 'c');
  r.entries[0].enabled = false;
  assert.equal(scheduler.select(r, 'chat', (e) => e.id !== 'a').id, 'b');
  assert.throws(() => scheduler.select(r, 'chat', () => false), /No eligible models/);
});
test('smooth balance distributes new assignments by rank, but keeps existing chats sticky', () => {
  const scheduler = new RouterScheduler(); const r = router('balance'); const counts = { a: 0, b: 0, c: 0 };
  for (let i = 0; i < 60; i++) counts[scheduler.select(r, `chat-${i}`, () => true).id]++;
  assert.deepEqual(counts, { a: 30, b: 20, c: 10 });
  const assignment = scheduler.select(r, 'sticky', () => true).id;
  for (let i = 0; i < 10; i++) assert.equal(scheduler.select(r, 'sticky', () => true).id, assignment);
});
test('capacity is shared by provider/model, queues FIFO, releases are idempotent', async () => {
  const scheduler = new RouterScheduler(); const r = router(); const entry = r.entries[0];
  scheduler.select(r, 'one', () => true);
  const release = await scheduler.acquire(r, 'one', entry);
  const order = [];
  const second = scheduler.acquire(r, 'two', entry).then((done) => { order.push('two'); return done; });
  const third = scheduler.acquire({ ...r, id: 'another-router' }, 'three', { ...entry, id: 'other-entry-id' }).then((done) => { order.push('three'); return done; });
  assert.equal(scheduler.activity(r).entries[0].active, 1);
  assert.equal(scheduler.activity(r).entries[0].queued, 2);
  assert.equal(scheduler.select(r, 'one', () => true).id, 'a');
  release(); release(); const releaseSecond = await second;
  assert.deepEqual(order, ['two']); releaseSecond(); const releaseThird = await third;
  assert.deepEqual(order, ['two', 'three']); releaseThird();
  assert.equal(scheduler.activity(r).entries[0].active, 0);
});
test('queued cancellation removes the waiter and never reassigns a chat', async () => {
  const scheduler = new RouterScheduler(); const r = router(); const entry = scheduler.select(r, 'one', () => true);
  const release = await scheduler.acquire(r, 'one', entry);
  const abort = new AbortController();
  const queued = scheduler.acquire(r, 'two', entry, abort.signal);
  abort.abort(); await assert.rejects(queued, { name: 'AbortError' });
  assert.equal(scheduler.activity(r).entries[0].queued, 0);
  assert.equal(scheduler.events.filter((e) => e.status === 'failover').length, 0); release();
});
test('overrides survive failover and persistence until manually cleared', () => {
  const scheduler = new RouterScheduler(); const r = router();
  scheduler.override(r, 'chat', 'b');
  assert.equal(scheduler.select(r, 'chat', () => true).id, 'b');
  assert.equal(scheduler.select(r, 'chat', (e) => e.id !== 'b').id, 'a');
  assert.equal(scheduler.select(r, 'chat', () => true).id, 'a');
  const restored = new RouterScheduler({ assignments: JSON.parse(JSON.stringify(scheduler.assignments)) });
  assert.equal(restored.select(r, 'chat', () => true).id, 'a');
  assert.equal(restored.activity(r).assignments[0].assignmentMode, 'override');
  restored.override(r, 'chat', null);
  assert.equal(restored.activity(r).assignments[0].assignmentMode, 'router');
  assert.equal(restored.events.filter((e) => e.status === 'assigned').length, 0);
});
test('configuration rejects duplicates and invalid concurrency and default', () => {
  const r = router();
  assert.deepEqual(validateRouters({ routers: [r], defaultRouterId: r.id }).routers, [r]);
  assert.throws(() => validateRouters({ routers: [{ ...r, entries: [...r.entries, { ...r.entries[0], id: 'duplicate' }] }] }), /unique/);
  assert.throws(() => validateRouters({ routers: [{ ...r, entries: [{ ...r.entries[0], concurrencyLimit: 0 }] }] }), /Concurrency/);
  assert.throws(() => validateRouters({ routers: [r], defaultRouterId: 'absent' }), /default router/);
});

for (const policy of ['priority', 'balance']) {
  test(`${policy}: workers prefer free capacity without moving chat assignments or overrides`, async () => {
    const scheduler = new RouterScheduler(); const r = router(policy);
    const eligible = () => true;
    const workerOptions = { preferAvailable: true };
    scheduler.select(r, 'worker', eligible);
    scheduler.select(r, 'parent', (e) => e.id === 'a');
    const release = await scheduler.acquire(r, 'parent', r.entries[0]);
    try {
      assert.equal(scheduler.select(r, 'parent', eligible).id, 'a');
      const chosen = scheduler.select(r, 'worker', eligible, new Set(), workerOptions);
      assert.notEqual(chosen.id, 'a');
      assert.equal(scheduler.select(r, 'worker', eligible, new Set(), workerOptions).id, chosen.id);
      scheduler.override(r, 'pinned-worker', 'a');
      assert.equal(scheduler.select(r, 'pinned-worker', eligible, new Set(), workerOptions).id, 'a');
      assert.equal(scheduler.select(r, 'limited-worker', (e) => e.id === 'a', new Set(), workerOptions).id, 'a');
      assert.equal(scheduler.assignments[scheduler.assignmentKey(r.id, 'parent')].assignedEntryId, 'a');
    } finally { release(); }
  });
}
