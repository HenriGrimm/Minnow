/**
 * P8-C — `plan()` is three rules. Caps gate starting, not continuing.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { derive } from '../../server/sub-agents/derive.js';
import { makeEvent, SUB_AGENT_ROLE } from '../../server/sub-agents/events.js';
import { bundleAbandonmentEvidence } from '../../server/sub-agents/evidence.js';
import {
  defaultCaps,
  nextAction,
  pendingAbandonments,
  plan,
  typeCap,
} from '../../server/sub-agents/plan.js';

function journal(...events) {
  return events.map((e, i) => ({ ...e, seq: i + 1, ts: 1 }));
}

const requested = (runId, agentType = 'explore') =>
  makeEvent('run.requested', {
    runId,
    agentType,
    task: runId,
    parentChatId: 'chat-1',
    cwd: '/tmp',
    requestedAt: 1,
  });

const started = (runId, attemptId, seedKind = 'initial') =>
  makeEvent('attempt.started', {
    runId,
    attemptId,
    seed: { kind: seedKind },
    seedKind,
  });

const ended = (runId, attemptId, outcome, extra = {}) =>
  makeEvent('attempt.ended', { runId, attemptId, outcome, ...extra });

describe('plan — three rules', () => {
  it('a non-terminal run with nothing in flight should be running', () => {
    const state = derive(journal(requested('r1'), requested('r2')));
    const desired = plan(state, defaultCaps());
    assert.deepEqual(
      desired.map((d) => d.taskId),
      ['r1', 'r2'],
    );
    for (const d of desired) {
      assert.equal(d.role, SUB_AGENT_ROLE);
      assert.equal(d.seedKind, 'initial');
    }
  });

  it('never two attempts on one run', () => {
    const state = derive(journal(requested('r1'), started('r1', 'a1')));
    const desired = plan(state, defaultCaps());
    assert.equal(desired.length, 1);
    assert.equal(desired[0].taskId, 'r1');
    assert.equal(nextAction(state, 'r1').kind, 'none');
  });

  it('terminal runs are not desired', () => {
    const state = derive(
      journal(
        requested('r1'),
        started('r1', 'a1'),
        ended('r1', 'a1', 'pass'),
        requested('r2'),
        makeEvent('run.cancelled', { runId: 'r2', reason: 'user' }),
      ),
    );
    assert.deepEqual(plan(state, defaultCaps()), []);
  });

  it('a cancelling run is not desired so the engine can stop it (P10-L)', () => {
    const state = derive(
      journal(
        requested('r1'),
        started('r1', 'a1'),
        makeEvent('run.cancelled', { runId: 'r1', reason: 'user' }),
      ),
    );
    assert.equal(state.runs.get('r1').phase, 'cancelling');
    assert.deepEqual(plan(state, defaultCaps()), []);
    assert.equal(nextAction(state, 'r1').kind, 'none');
  });
});

describe('plan — two caps, start-gate only', () => {
  it('respects the global cap when starting', () => {
    const state = derive(
      journal(requested('r1'), requested('r2'), requested('r3'), requested('r4')),
    );
    // Per-type default is 2; raise it so this case is the global cap binding.
    const caps = { globalMaxConcurrent: 3, maxConcurrentByType: { explore: 4 } };
    const desired = plan(state, caps);
    assert.deepEqual(
      desired.map((d) => d.taskId),
      ['r1', 'r2', 'r3'],
    );
  });

  it('respects the per-type cap when starting', () => {
    const state = derive(
      journal(
        requested('e1', 'explore'),
        requested('e2', 'explore'),
        requested('e3', 'explore'),
        requested('g1', 'generalPurpose'),
      ),
    );
    const caps = {
      globalMaxConcurrent: 3,
      maxConcurrentByType: { explore: 2, generalPurpose: 2 },
    };
    const desired = plan(state, caps);
    assert.deepEqual(
      desired.map((d) => d.taskId),
      ['e1', 'e2', 'g1'],
    );
  });

  it('missing per-type keys are bounded only by the global cap', () => {
    assert.equal(typeCap(defaultCaps(), 'explore'), 3);
    const state = derive(
      journal(requested('a', 'explore'), requested('b', 'explore'), requested('c', 'explore')),
    );
    assert.equal(plan(state, defaultCaps()).length, 3);
  });

  it('lowering the cap does not kill in-flight work', () => {
    const state = derive(
      journal(
        requested('r1'),
        requested('r2'),
        requested('r3'),
        requested('r4'),
        started('r1', 'a1'),
        started('r2', 'a2'),
        started('r3', 'a3'),
      ),
    );
    const caps = { globalMaxConcurrent: 1, maxConcurrentByType: {} };
    const desired = plan(state, caps);
    assert.deepEqual(
      desired.map((d) => d.taskId).sort(),
      ['r1', 'r2', 'r3'],
    );
    assert.ok(!desired.some((d) => d.taskId === 'r4'), 'must not start a fourth under a lowered cap');
  });

  it('in-flight of one type still blocks new starts of that type under the type cap', () => {
    const state = derive(
      journal(
        requested('e1', 'explore'),
        requested('e2', 'explore'),
        requested('e3', 'explore'),
        started('e1', 'a1'),
        started('e2', 'a2'),
      ),
    );
    const caps = { globalMaxConcurrent: 3, maxConcurrentByType: { explore: 2 } };
    const desired = plan(state, caps);
    assert.deepEqual(
      desired.map((d) => d.taskId),
      ['e1', 'e2'],
    );
  });
});

describe('plan — policy handoff', () => {
  it('retries a crash with a continue seed', () => {
    const state = derive(
      journal(requested('r1'), started('r1', 'a1'), ended('r1', 'a1', 'crashed')),
    );
    const next = nextAction(state, 'r1');
    assert.equal(next.kind, 'start');
    assert.equal(next.seedKind, 'continue');
  });

  it('abandons fail past the retry cap with a full, untruncated attempt list', () => {
    const state = derive(
      journal(
        requested('r1'),
        started('r1', 'a1'),
        ended('r1', 'a1', 'fail', { summary: 'one', evidence: { transcriptTail: 't1' } }),
        started('r1', 'a2', 'continue'),
        ended('r1', 'a2', 'fail', { summary: 'two', evidence: { transcriptTail: 't2' } }),
        started('r1', 'a3', 'continue'),
        ended('r1', 'a3', 'fail', { summary: 'three', evidence: { transcriptTail: 't3' } }),
      ),
    );
    const pending = pendingAbandonments(state);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].reason, 'failed');
    assert.equal(pending[0].evidence.attempts.length, 3);
    assert.equal(pending[0].evidence.transcriptTail, 't3');
    const bundled = bundleAbandonmentEvidence(state.runs.get('r1'), pending[0]);
    assert.equal(bundled.attempts.length, 3);
  });
});
