import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { ChatLeaseRequestError, ChatOwnershipError, createTurnLease } from '../../src/chat/turn-lease.ts';

function harness(t: TestContext, request?: (signal: AbortSignal) => Promise<{ leaseMs: number; startedAt: number } | null>) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let clock = 0, calls = 0, releases = 0;
  const events: string[] = [];
  const lease = createTurnLease({ chatId: 'chat', now: () => clock,
    grant: { leaseMs: 30_000, startedAt: clock },
    request: async signal => { calls++; return request ? request(signal) : { leaseMs: 30_000, startedAt: clock }; },
    release: async () => { releases++; }, diagnose: event => events.push(event),
  });
  return { lease, events, calls: () => calls, releases: () => releases, now: () => clock,
    async tick(ms: number) { clock += ms; t.mock.timers.tick(ms); await new Promise(resolve => setImmediate(resolve)); },
  };
}

test('one temporary renewal failure recovers without aborting or dispatch-triggered retry storms', async t => {
  let first = true;
  const h = harness(t, async () => {
    if (first) { first = false; throw new TypeError('Failed to fetch'); }
    return { leaseMs: 30_000, startedAt: h.now() };
  });
  await h.tick(5_000);
  await h.lease.check(); await h.lease.check();
  assert.equal(h.calls(), 1);
  assert.equal(h.lease.signal.aborted, false);
  await h.tick(1_000);
  assert.equal(h.calls(), 2);
  assert.deepEqual(h.events, ['renewal-failed', 'recovered']);
  await h.lease.release();
});

test('a persistent outage stops by the confirmed deadline without requiring another dispatch', async t => {
  const h = harness(t, async () => { throw new Error('offline'); });
  await h.tick(5_000);
  await h.tick(25_000);
  assert.equal(h.lease.signal.aborted, true);
  assert.ok(h.lease.signal.reason instanceof ChatOwnershipError);
  assert.equal(h.lease.signal.reason.kind, 'unavailable');
  await assert.rejects(h.lease.check(), { name: 'ChatOwnershipError' });
  await h.lease.release();
});

for (const failure of ['conflict', 'permanent'] as const) test(`${failure} ends the lease immediately`, async t => {
  const h = harness(t, async () => {
    if (failure === 'permanent') throw new ChatLeaseRequestError(false);
    return null;
  });
  await h.tick(5_000);
  assert.equal(h.lease.signal.reason.kind, failure === 'conflict' ? 'lost' : 'unavailable');
  await h.lease.release();
});

test('a renewal received after expiry cannot revive the turn', async t => {
  let complete!: (value: { startedAt: number; leaseMs: number }) => void;
  const h = harness(t, () => new Promise(resolve => { complete = resolve; }));
  await h.tick(5_000);
  await h.tick(25_000);
  complete({ startedAt: 5_000, leaseMs: 30_000 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.lease.signal.aborted, true);
  await h.lease.release();
});

test('release cancels a pending request and ignores its late success', async t => {
  let complete!: (value: { startedAt: number; leaseMs: number }) => void;
  let signal!: AbortSignal;
  const h = harness(t, s => { signal = s; return new Promise(resolve => { complete = resolve; }); });
  await h.tick(5_000);
  await h.lease.release(); await h.lease.release();
  assert.equal(signal.aborted, true);
  complete({ startedAt: 5_000, leaseMs: 30_000 });
  await h.tick(60_000);
  assert.equal(h.calls(), 1);
  assert.equal(h.releases(), 1);
});

test('a suspended renderer checks expiry before renewing or dispatching work', async t => {
  const h = harness(t);
  await h.tick(31_000);
  await assert.rejects(h.lease.check(), { name: 'ChatOwnershipError' });
  assert.equal(h.calls(), 0);
  await h.lease.release();
});

test('response latency consumes the grant rather than extending it', async t => {
  let complete!: (value: { startedAt: number; leaseMs: number }) => void;
  const h = harness(t, () => new Promise(resolve => { complete = resolve; }));
  await h.tick(5_000);
  await h.tick(10_000);
  complete({ startedAt: 5_000, leaseMs: 30_000 });
  await new Promise(resolve => setImmediate(resolve));
  await h.tick(20_000);
  assert.equal(h.lease.signal.aborted, true);
  await h.lease.release();
});
