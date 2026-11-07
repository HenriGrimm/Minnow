import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRunnerTiming, createRunnerTimingJournal } from '../../server/runner/timing.js';

test('timing offsets distinguish overlapping intervals despite a wall clock adjustment', () => {
  let mono = 20, wall = 1000;
  const events = [];
  const timing = createRunnerTiming(event => events.push(event), () => mono, () => wall);
  const outer = timing.start();
  mono = 30;
  const inner = timing.start();
  mono = 40; wall = 500;
  timing.end('tool', inner, { id: 'call-1', category: 'execution', count: 1 });
  mono = 50;
  timing.end('tool_batch', outer);
  assert.deepEqual(events.map(({ startOffsetMs, endOffsetMs, durationMs }) => [startOffsetMs, endOffsetMs, durationMs]),
    [[10, 20, 10], [0, 30, 30]]);
  assert.equal(events[0].at, 500);
  assert.equal(events[0].clockId, events[1].clockId);
  const other = [];
  createRunnerTiming(event => other.push(event), () => mono, () => 1000).end('turn', mono);
  assert.notEqual(other[0].clockId, events[0].clockId);
});

test('timings whitelist bounded metadata and cannot override authoritative fields', () => {
  const events = [];
  const timing = createRunnerTiming(event => events.push(event), () => 10, () => 100);
  timing.end('request', 10, { id: 'x'.repeat(1000), text: 'private', arguments: { token: 'private' },
    stage: 'forged', durationMs: -1, at: 0, count: Infinity });
  assert.equal(events[0].id.length, 160);
  assert.equal(events[0].stage, 'request');
  assert.equal(events[0].durationMs, 0);
  assert.equal(events[0].at, 100);
  for (const key of ['text', 'arguments', 'count']) assert.equal(Object.hasOwn(events[0], key), false);
  assert.equal(JSON.stringify(events).includes('private'), false);
});

test('execution timing journal bounds history and stages while removing request/response payloads', () => {
  const journal = createRunnerTimingJournal(10);
  for (let i = 0; i < 400; i++) journal.record({ stage: 'stage_' + i, durationMs: 2, text: 'private', arguments: { token: 'private' } });
  assert.equal(journal.report.events.length, 10); assert.equal(journal.report.dropped, 390);
  assert.equal(Object.keys(journal.report.totals).length, 64);
  assert.equal(JSON.stringify(journal.report).includes('private'), false);
  assert.equal(journal.report.intervalsOverlap, true);
});

test('throwing and rejecting diagnostics do not interrupt a turn', async () => {
  assert.doesNotThrow(() => createRunnerTiming(() => { throw Error('closed observer'); }).end('turn', 0));
  createRunnerTiming(async () => { throw Error('closed observer'); }).end('turn', 0);
  await new Promise(resolve => setImmediate(resolve));
});
