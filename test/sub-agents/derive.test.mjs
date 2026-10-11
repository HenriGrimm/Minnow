/**
 * P8-C — the pure fold from journal to sub-agent state.
 *
 * Replay twice is identical. Attempt counts are a filter. No retry counter.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  attemptCount,
  derive,
  emptyState,
  foldInto,
  isStoppedForScheduling,
  isTerminal,
  lastEndedAttempt,
  pendingDeliveries,
  serializeState,
} from '../../server/sub-agents/derive.js';
import { makeEvent } from '../../server/sub-agents/events.js';

function journal(...events) {
  return events.map((e, i) => ({ ...e, seq: i + 1, ts: 1_700_000_000_000 + i }));
}

const requested = (runId, extra = {}) =>
  makeEvent('run.requested', {
    runId,
    agentType: extra.agentType ?? 'explore',
    task: extra.task ?? 'do the thing',
    parentChatId: extra.parentChatId ?? 'chat-1',
    cwd: extra.cwd ?? '/tmp/ws',
    requestedAt: extra.requestedAt ?? 1_700_000_000_000,
  });

const started = (runId, attemptId, extra = {}) =>
  makeEvent('attempt.started', {
    runId,
    attemptId,
    seed: extra.seed ?? { kind: extra.seedKind ?? 'initial' },
    ...(extra.seedKind ? { seedKind: extra.seedKind } : {}),
    ...(extra.model ? { model: extra.model } : {}),
  });

const ended = (runId, attemptId, outcome, extra = {}) =>
  makeEvent('attempt.ended', {
    runId,
    attemptId,
    outcome,
    ...extra,
  });

describe('derive — shape', () => {
  it('retains the journal settlement time through serialization and replay', () => {
    const events = journal(requested('r1'), started('r1', 'a1'), ended('r1', 'a1', 'pass'));
    events[2].ts += 65_000;
    const state = derive(events);
    assert.equal(state.runs.get('r1').endedAt, events[2].ts);
    assert.equal(JSON.parse(serializeState(state)).runs[0].endedAt, events[2].ts);
    assert.equal(serializeState(derive(events)), serializeState(state));
  });

  it('builds independent runs from run.requested in journal order', () => {
    const state = derive(journal(requested('r1'), requested('r2', { agentType: 'researcher' })));
    assert.equal(state.parentChatId, 'chat-1');
    assert.deepEqual(state.runOrder, ['r1', 'r2']);
    assert.equal(state.runs.get('r1').type, 'explore');
    assert.equal(state.runs.get('r2').type, 'researcher');
    assert.equal(state.runs.get('r1').phase, 'idle');
    assert.equal(state.status, 'running');
    assert.equal('dependsOn' in state.runs.get('r1'), false);
    assert.equal('touches' in state.runs.get('r1'), false);
    assert.equal('wave' in state.runs.get('r1'), false);
  });

  it('a later run.requested for the same id is a no-op', () => {
    const state = derive(
      journal(requested('r1', { task: 'first' }), requested('r1', { task: 'second' })),
    );
    assert.equal(state.runs.get('r1').task, 'first');
    assert.equal(state.runOrder.length, 1);
  });
});

describe('derive — attempts and phases', () => {
  it('opens and closes an attempt without storing a retry counter', () => {
    const state = derive(
      journal(
        requested('r1'),
        started('r1', 'a1'),
        ended('r1', 'a1', 'fail', { summary: 'nope' }),
      ),
    );
    const run = state.runs.get('r1');
    assert.equal(run.phase, 'idle');
    assert.equal(run.attempts.length, 1);
    assert.equal(run.attempts[0].ended, true);
    assert.equal(run.attempts[0].outcome, 'fail');
    assert.equal(attemptCount(state, 'r1'), 1);
    assert.equal('attempt' in run, false);
    assert.equal('retryCount' in run, false);
  });

  it('pass is terminal for scheduling even before result.delivered', () => {
    const pending = derive(journal(requested('r1'), started('r1', 'a1'), ended('r1', 'a1', 'pass')));
    assert.equal(pending.runs.get('r1').phase, 'passed');
    assert.equal(pending.runs.get('r1').delivered, false);
    assert.equal(isTerminal(pending.runs.get('r1')), true);
    assert.deepEqual(
      pendingDeliveries(pending).map((r) => r.runId),
      ['r1'],
    );

    const delivered = derive(
      journal(
        requested('r1'),
        started('r1', 'a1'),
        ended('r1', 'a1', 'pass'),
        makeEvent('result.delivered', { runId: 'r1', parentChatId: 'chat-1' }),
      ),
    );
    assert.equal(delivered.runs.get('r1').delivered, true);
    assert.equal(delivered.runs.get('r1').phase, 'passed');
    assert.deepEqual(pendingDeliveries(delivered), []);
  });

  it('run.nudged is once-per-run and does not change phase', () => {
    const before = derive(journal(requested('r1'), started('r1', 'a1')));
    assert.equal(before.runs.get('r1').nudged, false);
    assert.equal(before.runs.get('r1').phase, 'running');

    const after = derive(
      journal(
        requested('r1'),
        started('r1', 'a1'),
        makeEvent('run.nudged', { runId: 'r1', parentChatId: 'chat-1' }),
      ),
    );
    assert.equal(after.runs.get('r1').nudged, true);
    assert.equal(after.runs.get('r1').phase, 'running');
    assert.equal(isTerminal(after.runs.get('r1')), false);
  });

  it('pendingDeliveries is the terminal-and-not-delivered fold, not a Set', () => {
    const pending = derive(
      journal(requested('r1'), started('r1', 'a1'), ended('r1', 'a1', 'pass')),
    );
    assert.deepEqual(
      pendingDeliveries(pending).map((r) => r.runId),
      ['r1'],
    );

    const skipped = derive(
      journal(
        requested('r1'),
        started('r1', 'a1'),
        ended('r1', 'a1', 'pass'),
        makeEvent('result.delivered', {
          runId: 'r1',
          parentChatId: 'chat-1',
          skipReason: 'missing_chat',
        }),
      ),
    );
    assert.equal(skipped.runs.get('r1').delivered, true);
    assert.equal(skipped.runs.get('r1').deliveredSkipReason, 'missing_chat');
    assert.deepEqual(pendingDeliveries(skipped), []);
  });

  it('cancel with an open attempt is cancelling until the attempt ends (P10-L)', () => {
    const mid = derive(
      journal(
        requested('r1'),
        started('r1', 'a1'),
        makeEvent('run.cancelled', { runId: 'r1', reason: 'user' }),
      ),
    );
    const run = mid.runs.get('r1');
    assert.equal(run.phase, 'cancelling');
    assert.equal(run.cancelledReason, 'user');
    assert.equal(run.attempts[0].ended, false);
    assert.equal(isTerminal(run), false);
    assert.equal(isStoppedForScheduling(run), true);
    assert.deepEqual(pendingDeliveries(mid), []);

    const settled = derive(
      journal(
        requested('r1'),
        started('r1', 'a1'),
        makeEvent('run.cancelled', { runId: 'r1', reason: 'user' }),
        ended('r1', 'a1', 'crashed', { summary: 'the user cancelled this run' }),
      ),
    );
    const done = settled.runs.get('r1');
    assert.equal(done.phase, 'cancelled');
    assert.equal(done.attempts[0].ended, true);
    assert.equal(isTerminal(done), true);
    assert.deepEqual(
      pendingDeliveries(settled).map((r) => r.runId),
      ['r1'],
    );
  });

  it('cancel with zero attempts is cancelled immediately', () => {
    const state = derive(
      journal(requested('r1'), makeEvent('run.cancelled', { runId: 'r1', reason: 'user' })),
    );
    const run = state.runs.get('r1');
    assert.equal(run.phase, 'cancelled');
    assert.equal(run.cancelledReason, 'user');
    assert.equal(run.attempts.length, 0);
    assert.equal(isTerminal(run), true);
  });

  it('abandon records the bundle and is terminal', () => {
    const evidence = { attempts: [{ attemptId: 'a1', outcome: 'fail' }] };
    const state = derive(
      journal(
        requested('r1'),
        started('r1', 'a1'),
        ended('r1', 'a1', 'fail'),
        makeEvent('run.abandoned', { runId: 'r1', reason: 'failed', evidence }),
      ),
    );
    const run = state.runs.get('r1');
    assert.equal(run.phase, 'abandoned');
    assert.equal(run.abandonedReason, 'failed');
    assert.deepEqual(run.abandonedEvidence, evidence);
  });

  it('records a missing started line on ended so the count is not short', () => {
    const state = derive(journal(requested('r1'), ended('r1', 'a9', 'crashed')));
    assert.equal(attemptCount(state, 'r1'), 1);
    assert.equal(lastEndedAttempt(state.runs.get('r1')).attemptId, 'a9');
  });

  it('skips unknown types and malformed known events', () => {
    const state = derive(
      journal(
        requested('r1'),
        { v: 1, type: 'agents.future', runId: 'nope' },
        { v: 1, type: 'run.cancelled', runId: 'r1', reason: 'timeout' },
        started('r1', 'a1'),
      ),
    );
    assert.equal(state.runs.get('r1').phase, 'running');
    assert.equal(state.runs.get('r1').cancelledReason, null);
  });
});

describe('derive — replay identity', () => {
  it('replaying a journal twice gives identical state, byte for byte', () => {
    const events = journal(
      requested('r1'),
      requested('r2', { agentType: 'researcher' }),
      started('r1', 'a1', { model: { providerId: 'local', id: 'm' } }),
      ended('r1', 'a1', 'fail', { summary: 'x', evidence: { transcriptTail: 'tail' } }),
      started('r1', 'a2', { seedKind: 'continue', seed: { kind: 'continue' } }),
      ended('r1', 'a2', 'pass'),
      makeEvent('result.delivered', { runId: 'r1', parentChatId: 'chat-1' }),
      makeEvent('run.cancelled', { runId: 'r2', reason: 'user' }),
    );
    const a = derive(events);
    const b = derive(events);
    assert.equal(serializeState(a), serializeState(b));
    assert.notEqual(a, b);
    assert.notEqual(a.runs, b.runs);

    const folded = foldInto(emptyState(), events);
    assert.equal(serializeState(folded), serializeState(a));
  });

  it('uses requestedAt rather than the request envelope timestamp for the start', () => {
    const events = journal(requested('r1'));
    events[0].ts = 1;
    const a = serializeState(derive(events));
    events[0].ts = 99_999;
    const b = serializeState(derive(events));
    assert.equal(a, b);
  });
});
