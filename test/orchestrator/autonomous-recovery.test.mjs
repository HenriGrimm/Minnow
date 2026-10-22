import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import { createEngine } from '../../server/orchestrator/engine.js';
import { boardGraph, boardImpliedEvents, boardEventsForAttemptEnd } from '../../server/orchestrator/board-graph.js';
import { createMemoryJournal } from '../../server/orchestrator/testing/memory-journal.js';
import { derive, foldInto } from '../../server/orchestrator/core/derive.js';
import { plan } from '../../server/orchestrator/core/plan.js';
import { makeEvent, validateEvent } from '../../server/orchestrator/core/events.js';
import { makeSnapshot, deriveFrom } from '../../server/orchestrator/core/snapshot.js';
import { boardFailure } from '../../server/orchestrator/failure.js';
import { parseAllowanceResetTime } from '../../server/generations/quota-error.js';

const engines = [];
afterEach(() => { for (const engine of engines.splice(0)) engine.dispose(); });
const task = (id, extra = {}) => ({ id, title: id, wave: 1, dependsOn: [], touches: [`src/${id}/**`], build: 'Implement', test: 'Verify', accept: 'Works', ...extra });
const created = (tasks = [task('A'), task('B')]) => makeEvent('board.created', { boardId: 'recovery', planPath: 'plan.md', tasks, waves: [] });
const started = () => makeEvent('board.started', { concurrency: 2, recoveryVersion: 1 });

async function harness({ preflight, startError, events = [created()] } = {}) {
  let at = 1_800_000_000_000;
  let listener;
  let serial = 0;
  const live = new Map();
  const starts = [];
  const stopped = [];
  const journal = createMemoryJournal();
  await journal.appendEvents('recovery', events);
  const effector = {
    inspect: () => [...live.values()],
    onEnd: (handler) => { listener = handler; },
    preflight,
    async start(want) {
      if (startError) await startError(want);
      const value = { ...want, attemptId: `attempt-${++serial}` };
      live.set(value.attemptId, value);
      starts.push(value);
      return { attemptId: value.attemptId };
    },
    async stop(id) { stopped.push(id); live.delete(id); },
    setPaused() {},
  };
  const engine = createEngine({ boardId: 'recovery', journal, effector, graph: { ...boardGraph, writeReport: undefined }, clock: { now: () => at, setTimer: () => 1, clearTimer() {} } });
  engines.push(engine);
  await engine.load();
  return {
    engine, journal, starts, live, stopped, effector,
    async advance(ms) { at += ms; await engine.tick(); },
    async end(taskId, outcome, extra = {}) {
      const value = [...live.values()].find((entry) => entry.taskId === taskId);
      assert.ok(value, `No live attempt for ${taskId}`);
      // The Effector contract keeps it inspected until onEnd has settled.
      await listener({ ...value, outcome, ...extra });
      live.delete(value.attemptId);
      await engine.tick();
    },
  };
}

test('an outage holds only affected new starts and preserves healthy in-flight work', async () => {
  const h = await harness();
  await h.engine.startBoard(2, { recovery: true });
  const healthy = [...h.live.values()].find((entry) => entry.taskId === 'B');
  await h.end('A', 'crashed', { summary: 'Upstream HTTP 503: Endpoint is unavailable.' });
  assert.equal(h.engine.getState().status, 'running');
  assert.equal(h.engine.getState().recoveryHolds['builder:A'].failure.category, 'unavailable');
  assert.ok(h.live.has(healthy.attemptId));
  assert.ok(!h.stopped.includes(healthy.attemptId));
  assert.equal(h.starts.length, 2);
  await h.advance(6001);
  assert.equal(h.starts.length, 3);
  assert.equal(h.starts.at(-1).taskId, 'A');
  assert.equal(h.starts.at(-1).sameWorktree, true);
  assert.ok([...h.engine.getState().tasks.values()].every((item) => !['abandoned', 'skipped'].includes(item.phase)));
});

test('first Start persists accepted intent and resumes after a recoverable preflight failure', async () => {
  let unavailable = true;
  const h = await harness({ preflight: async () => { if (unavailable) throw new Error('HTTP 503: model loading'); } });
  await h.engine.startBoard(1, { recovery: true });
  assert.equal(h.starts.length, 0);
  assert.equal(h.engine.getState().status, 'running');
  assert.ok(h.engine.getState().recoveryHolds['preflight:']);
  unavailable = false;
  await h.advance(6001);
  assert.equal(h.starts.filter(item => item.taskId === 'A').length, 1);
});

test('a startup failure is durable without fabricating an attempt-start event', async () => {
  const h = await harness({ startError: async () => { throw new Error('CLI process limit reached'); } });
  await h.engine.startBoard(1, { recovery: true });
  const events = await h.journal.readEvents('recovery');
  assert.equal(events.filter((event) => event.type === 'task.attempt.started').length, 0);
  assert.equal(derive(events).recoveryHolds['builder:A'].stage, 'start');
});

test('Stop and Pause suppress due recovery and retain its evidence', async () => {
  for (const command of ['stopBoard', 'pauseBoard']) {
    const h = await harness();
    await h.engine.startBoard(1, { recovery: true });
    await h.end('A', 'crashed', { summary: 'HTTP 503: loading' });
    await h.engine[command]();
    await h.advance(1_000_000);
    assert.equal(h.starts.length, 1);
    assert.ok(h.engine.getState().recoveryHolds['builder:A']);
  }
});

test('an action acknowledgement resumes without Start and cannot bypass a stopped board', async () => {
  const h = await harness({ events: [created([task('A')])] });
  await h.engine.startBoard(1, { recovery: true });
  await h.end('A', 'blocked', { summary: 'Device unavailable', evidence: { needs: ['Connect device'] } });
  assert.ok(h.engine.getState().recoveryHolds['builder:A'].attention);
  assert.equal(await h.engine.checkRecovery('builder:A'), true);
  assert.equal(h.starts.length, 2);
  await h.end('A', 'blocked', { summary: 'Device unavailable' });
  await h.engine.stopBoard();
  assert.equal(await h.engine.checkRecovery('builder:A'), false);
});

test('reset or edit while a prerequisite check is pending invalidates its callback', async () => {
  const h = await harness({ events: [created([task('A')])] });
  await h.engine.startBoard(1, { recovery: true });
  await h.end('A', 'blocked', { summary: 'Missing credential' });
  let resolve;
  h.effector.preflight = () => new Promise((done) => { resolve = done; });
  const checking = h.engine.checkRecovery('builder:A');
  await Promise.resolve();
  await h.engine.append([makeEvent('task.updated', { taskId: 'A', changes: { build: 'New scope' } })]);
  resolve();
  assert.equal(await checking, false);
  assert.equal(h.starts.length, 1);
});

test('a persisted attempt-end prefix reconstructs its missing recovery hold', async () => {
  const state = derive([created(), started(), makeEvent('task.attempt.started', { taskId: 'A', role: 'builder', attemptId: 'a' })]);
  const events = await boardEventsForAttemptEnd({ taskId: 'A', role: 'builder', attemptId: 'a', outcome: 'crashed', summary: 'HTTP 503: loading' }, { id: 'recovery', state, now: 1000 });
  foldInto(state, events.slice(0, 1));
  const missing = boardImpliedEvents(state);
  assert.equal(missing[0].type, 'recovery.held');
  foldInto(state, missing);
  assert.ok(state.recoveryHolds['builder:A'].retryAt >= 6000 && state.recoveryHolds['builder:A'].retryAt <= 7000);
  foldInto(state, [makeEvent('recovery.released', { key: 'builder:A' })]);
  assert.equal(boardImpliedEvents(state).length, 0);
});

test('final failures create independent bounded integration repairs', async () => {
  const state = derive([created([task('A')]), started(), makeEvent('merge.succeeded', { taskId: 'A', sha: 'abc' }), makeEvent('final.test.ended', { outcome: 'fail', evidence: { integrationSha: 'abc', output: 'TS2322 type error' } })]);
  const next = boardImpliedEvents(state);
  assert.equal(next[0].type, 'task.added');
  assert.match(next[0].task.id, /^AUTO-FIX-/);
  assert.equal(next[1].type, 'final.repair.created');
  foldInto(state, next.slice(0, 1));
  const remainder = boardImpliedEvents(state);
  assert.equal(remainder.length, 1);
  foldInto(state, remainder);
  assert.equal(state.finalTest, null);
  assert.equal(state.tasks.get('A').phase, 'merged');
  assert.equal(plan(state)[0].taskId, state.finalRepairs[0].taskId);
});

test('a final pass cannot complete unresolved required work', async () => {
  const h = await harness({ events: [created(), started(), makeEvent('merge.succeeded', { taskId: 'A', sha: 'abc' }), makeEvent('task.abandoned', { taskId: 'B', reason: 'user' }), makeEvent('final.test.ended', { outcome: 'pass' })] });
  await h.engine.tick();
  assert.equal(h.engine.getState().finished, false);
});

test('a final result delivered during start remains bound to its starting integration', async () => {
  const h = await harness({ events: [created([task('A')]), makeEvent('merge.succeeded', { taskId: 'A', sha: 'abc' })] });
  h.effector.start = async (want) => {
    const entry = { ...want, attemptId: 'synchronous-final' };
    h.live.set(entry.attemptId, entry);
    await h.end(null, 'pass');
    return { attemptId: entry.attemptId };
  };
  await h.engine.startBoard(1, { recovery: true });
  assert.equal(h.engine.getState().finalTest.evidence.integrationSha, 'abc');
  assert.equal(h.engine.getState().finished, true);
});

test('snapshot plus tail and complete replay agree for held and resumed recovery', async () => {
  const initial = [created(), started()];
  const state = derive(initial);
  const end = await boardEventsForAttemptEnd({ taskId: 'A', role: 'builder', attemptId: 'a', outcome: 'crashed', summary: 'HTTP 503: loading' }, { id: 'recovery', state, now: 1000 });
  const events = [...initial, ...end, makeEvent('recovery.released', { key: 'builder:A' })].map((event, index) => ({ ...event, seq: index + 1, ts: index }));
  const snapshot = makeSnapshot('recovery', derive(events.slice(0, 4)), 4);
  assert.deepEqual(deriveFrom(snapshot, events.slice(4)), derive(events));
});

test('historical shapes preserve category, reset timezone and request-versus-host capacity', () => {
  assert.equal(boardFailure({ message: 'Upstream HTTP 503: Endpoint unavailable' }).category, 'unavailable');
  assert.equal(boardFailure({ message: 'Upstream HTTP 429: Endpoint unavailable' }).category, 'rate_limit');
  assert.equal(boardFailure({ message: 'Upstream HTTP 403: invalid JSON' }).category, 'unknown');
  assert.equal(boardFailure({ message: 'Generation request exceeds host memory budget', failure: { status: 413 } }).category, 'context');
  assert.equal(boardFailure({ message: 'Generation request exceeds host memory budget', failure: { status: 503 } }).category, 'capacity');
  const now = Date.parse('2026-10-22T22:00:00Z');
  assert.equal(parseAllowanceResetTime("You've hit your session limit · resets 11pm (America/Los_Angeles)", now), Date.parse('2026-10-23T06:00:00Z'));
  assert.equal(parseAllowanceResetTime('resets 11pm (invalid-zone)', now), undefined);
});

test('a proven optional request-field rejection gets one automatic adaptation, without weakening tools', async () => {
  const h = await harness({ events: [created([task('A')])] });
  await h.engine.startBoard(1, { recovery: true });
  const summary = 'Upstream HTTP 400: unsupported field thinking';
  await h.end('A', 'crashed', { summary });
  assert.equal(h.engine.getState().recoveryHolds['builder:A'].attention, false);
  assert.equal(h.engine.getState().recoveryHolds['builder:A'].failure.omitField, 'thinking');
  await h.advance(6001);
  await h.end('A', 'crashed', { summary });
  assert.equal(h.engine.getState().recoveryHolds['builder:A'].attention, true);
  assert.equal(h.engine.getState().recoveryFailures.length, 0);
  assert.equal(boardFailure({ message: 'unsupported field tools' }).omitField, undefined);
});

test('reject malformed recovery observations at the journal boundary', () => {
  assert.equal(validateEvent(makeEvent('recovery.held', { hold: { key: 'builder:A' } })).ok, false);
});

test('repeated code failures diagnose once, preserve work and stop at a bounded hold', async () => {
  const h = await harness({ events: [created([task('A')])] });
  await h.engine.startBoard(1, { recovery: true });
  for (let count = 0; count < 5; count += 1) await h.end('A', 'fail', { summary: 'One assertion still fails', evidence: { blockers: ['expected 1, got 0'] } });
  assert.equal(h.starts.length, 5);
  assert.equal(h.starts.filter((attempt) => attempt.seedKind === 'diagnose').length, 1);
  assert.ok(h.starts.slice(1).every((attempt) => attempt.sameWorktree));
  assert.equal(h.engine.getState().tasks.get('A').phase, 'idle');
  assert.ok(h.engine.getState().recoveryHolds['builder:A'].attention);
  await h.advance(86_400_000);
  assert.equal(h.starts.length, 5);
  assert.equal(await h.engine.checkRecovery('builder:A'), false);
});

test('typecheck then lint final failures repair and complete without Reopen', async () => {
  const h = await harness({ events: [created([task('A')]), started(), makeEvent('merge.succeeded', { taskId: 'A', sha: 'base' })] });
  await h.engine.tick();
  for (const [index, rung] of ['typecheck', 'lint'].entries()) {
    await h.end(null, 'fail', { summary: `${rung} failed`, evidence: { failedRung: rung, output: `${rung}: failure` } });
    const fix = h.engine.getState().finalRepairs[index].taskId;
    await h.end(fix, 'pass', { summary: 'Fixed' });
    await h.end(fix, 'pass', { summary: 'Verified' });
    await h.end(fix, 'pass', { sha: `fixed-${index}` });
  }
  await h.end(null, 'pass', { evidence: { integrationSha: 'fixed-1' } });
  assert.equal(h.engine.getState().finished, true);
  assert.equal(h.engine.getState().finalRepairs.length, 2);
  assert.ok([...h.engine.getState().tasks.values()].every((item) => item.phase === 'merged'));
});

test('a completed rebase requires fresh tester approval before merging', () => {
  const state = derive([created([task('A')]), started(), makeEvent('merge.enqueued', { taskId: 'A' }), makeEvent('merge.rebased', { taskId: 'A', sha: 'changed' })]);
  assert.equal(plan(state)[0].role, 'tester');
  assert.equal(state.mergeQueue.length, 0);
});

test('changed account identity releases a quota hold without waiting for the old reset', async () => {
  const h = await harness({ events: [created([task('A')])] });
  await h.engine.startBoard(1, { recovery: true });
  await h.end('A', 'crashed', { summary: 'Quota exceeded', evidence: { failure: { kind: 'quota', identity: 'old-account', providerId: 'provider', modelId: 'model', resetAt: 1_900_000_000_000 } } });
  assert.equal(h.starts.length, 1);
  h.effector.recoveryReady = async () => true;
  await h.engine.tick();
  assert.equal(h.starts.length, 2);
  assert.equal(h.engine.getState().recoveryHolds['builder:A'], undefined);
});

test('a resolved machine-checkable prerequisite continues automatically without acknowledgement', async () => {
  const h = await harness({ events: [created([task('A')])] });
  let ready = false;
  h.effector.recoveryReady = async () => ready;
  await h.engine.startBoard(1, { recovery: true });
  await h.end('A', 'blocked', { summary: 'Missing reference', evidence: { needs: ['inputs/prototype.html'], prerequisites: [{ kind: 'file', path: 'inputs/prototype.html' }] } });
  assert.equal(h.engine.getState().recoveryHolds['builder:A'].attention, true);
  await h.advance(30_001);
  assert.equal(h.starts.filter(item => item.taskId === 'A').length, 1);
  ready = true;
  await h.advance(30_001);
  assert.equal(h.engine.getState().recoveryHolds['builder:A'], undefined);
  assert.equal(h.starts.at(-1).taskId, 'A');
});

test('resolving one setup prerequisite rechecks all preflight requirements before work starts', async () => {
  let stage = 0; let calls = 0;
  const h = await harness({ events: [created([task('A')])], preflight: async () => {
    calls++;
    if (stage < 2) throw Object.assign(new Error(stage === 0 ? 'Reference missing' : 'Verifier missing'), { failure: { category: 'prerequisite', prerequisites: [{ kind: 'file', path: stage === 0 ? 'input.html' : 'verifier.txt' }] } });
  } });
  h.effector.recoveryReady = async () => true;
  await h.engine.startBoard(1, { recovery: true });
  stage = 1;
  await h.advance(30_001);
  assert.equal(h.starts.length, 0);
  assert.match(h.engine.getState().recoveryHolds['preflight:'].failure.message, /Verifier/);
  stage = 2;
  await h.advance(30_001);
  assert.ok(calls >= 3);
  assert.equal(h.starts.length, 1);
});

test('an explicit continuation upgrades legacy failures while preserving user waivers and stops', async () => {
  const h = await harness({ events: [created([task('A'), task('B', { dependsOn: ['A'] }), task('C')]), makeEvent('board.started', { concurrency: 1 }),
    makeEvent('task.abandoned', { taskId: 'A', reason: 'retry-budget-exhausted' }), makeEvent('task.skipped', { taskId: 'B', blockedBy: 'A' }), makeEvent('task.waived', { taskId: 'C', by: 'user' }), makeEvent('board.stopped', { reason: 'user' })] });
  assert.equal(h.starts.length, 0);
  await h.engine.startBoard(1, { recovery: true });
  assert.equal(h.engine.getState().recoveryVersion, 1);
  assert.equal(h.engine.getState().tasks.get('A').abandonedReason, null);
  assert.equal(h.engine.getState().tasks.get('B').skippedBy, null);
  assert.equal(h.engine.getState().tasks.get('C').waived, true);
  assert.equal(h.starts[0].taskId, 'A');
});

test('explicitly reopening an old failed board adopts durable continuation before preflight', async () => {
  let ready = false;
  const h = await harness({ events: [created([task('A')]), makeEvent('task.abandoned', { taskId: 'A', reason: 'failed' }), makeEvent('run.finished', { summary: 'Failed legacy board' }), makeEvent('board.stopped', { reason: 'terminal' })], preflight: async () => { if (!ready) throw new Error('No model bound'); } });
  const result = await h.engine.reopen({ recovery: true });
  assert.equal(result.ok, true);
  assert.equal(h.engine.getState().recoveryVersion, 1);
  assert.ok(h.engine.getState().recoveryHolds['preflight:']);
  assert.equal(h.starts.length, 0);
  ready = true;
  assert.equal(await h.engine.checkRecovery('preflight:'), true);
  assert.equal(h.starts.length, 1);
});

test('a reset preserves the board recovery spending ledger', () => {
  const state = derive([created([task('A')]), started(), makeEvent('task.attempt.ended', { taskId: 'A', attemptId: 'failed', role: 'builder', outcome: 'fail' }), makeEvent('task.reset', { taskIds: ['A'], reason: 'user' })]);
  assert.equal(state.tasks.get('A').attempts.length, 0);
  assert.deepEqual(state.recoveryFailures, ['A:failed']);
});
