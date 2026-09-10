/**
 * W2-A — fold/plan tables for `server/super-plan/`.
 *
 * Hand-written journals fold to state, and `plan(state)` must return exactly
 * the Desired[] the table says. The pipeline is strictly sequential, so every
 * expected plan is zero or one Desired. This file also pins the event
 * vocabulary, the policy routing table, the review set-difference resolution,
 * the graph surface, and the journal binding path.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import { currentFindings, derive, findingId } from '../../server/super-plan/derive.js';
import {
  EVENT_TYPES,
  makeEvent,
  validateEvent,
} from '../../server/super-plan/events.js';
import {
  createSuperPlanGraph,
  isSuperPlanRole,
} from '../../server/super-plan/graph.js';
import {
  SUPERPLAN_NAMESPACE,
  journalPath,
  runDir,
} from '../../server/super-plan/journal.js';
import { plan, seedKindFor } from '../../server/super-plan/plan.js';
import { decide, formatPolicyTable, POLICY_TABLE } from '../../server/super-plan/policy.js';

// ── journal helpers ──────────────────────────────────────────────────────────

const RUN_ID = 'run-1';
const PROMPT = 'Build a Kanban UI';

/** @param {Record<string, unknown>} [config] */
function created(config) {
  const payload = { runId: RUN_ID, prompt: PROMPT };
  if (config !== undefined) payload.config = config;
  return makeEvent('run.created', payload);
}

const started = makeEvent('run.started', {});
const cancelled = makeEvent('run.cancelled', { reason: 'user' });
const gateExpired = makeEvent('gate.expired', { kind: 'spec' });

/** @param {string} stage @param {string} attemptId */
function startedStage(stage, attemptId) {
  return makeEvent('stage.started', { stage, attemptId });
}

/** @param {string} stage @param {string} attemptId @param {string} outcome @param {Record<string, unknown>} [extra] */
function endedStage(stage, attemptId, outcome, extra = {}) {
  return makeEvent('stage.ended', { stage, attemptId, outcome, ...extra });
}

/** @param {'spec' | 'accept'} kind */
function openedGate(kind) {
  return makeEvent('gate.opened', { kind });
}

/** @param {'spec' | 'accept'} kind @param {string} verdict @param {string[]} [errors] */
function answeredGate(kind, verdict, errors = []) {
  return makeEvent('gate.answered', { kind, verdict, errors });
}

/** @param {number} round @param {Array<{ title: string, severity: string, detail?: string, paths?: string[] }>} findings */
function reviewRound(round, findings) {
  return makeEvent('review.recorded', { round, findings });
}

const interviewOk = endedStage('interview', 'i1', 'ok');
const specOk = endedStage('spec', 's1', 'ok');
const specWritten = makeEvent('spec.written', { path: 'documentation/plans/references/plan-1-spec.md' });
const researchOk = endedStage('research', 'r1', 'ok');
const draftOk = endedStage('draft', 'd1', 'ok');
const planWritten = makeEvent('plan.written', { path: 'documentation/plans/plan-1.md' });

const F1 = {
  title: 'Dependency order is wrong',
  detail: 'W2 depends on W1 but the waves are swapped.',
  severity: 'blocking',
  paths: ['documentation/plans/plan-1.md'],
};
const F2 = {
  title: 'Paths do not match the repo',
  detail: 'The plan references a file that does not exist.',
  severity: 'blocking',
  paths: ['documentation/plans/plan-1.md'],
};

// ── fold/plan tables ─────────────────────────────────────────────────────────

describe('super-plan fold/plan tables', () => {
  it('fresh run plans the interview', () => {
    const state = derive([created(), started]);
    assert.deepEqual(plan(state), [{ taskId: RUN_ID, role: 'interview', seedKind: 'initial' }]);
  });

  it('an interview that passes moves the plan to the spec', () => {
    const state = derive([created(), started, startedStage('interview', 'i1'), interviewOk]);
    assert.deepEqual(plan(state), [{ taskId: RUN_ID, role: 'gate', seedKind: 'spec' }]);
  });

  it('spec written opens the spec gate; the plan is empty apart from the gate', () => {
    const state = derive([
      created(),
      started,
      startedStage('interview', 'i1'),
      interviewOk,
      startedStage('spec', 's1'),
      specOk,
      specWritten,
      openedGate('spec'),
    ]);
    assert.equal(state.gate?.status, 'open');
    assert.deepEqual(plan(state), (state.gate?.status === 'open' || state.pendingGate) && state.status === 'running' && !state.finished ? [{ taskId: RUN_ID, role: 'gate', seedKind: state.gate?.kind ?? state.pendingGate }] : []);
  });

  it('gate confirm sends the plan to research', () => {
    const state = derive([
      created(),
      started,
      interviewOk,
      specOk,
      specWritten,
      openedGate('spec'),
      answeredGate('spec', 'confirm'),
    ]);
    assert.deepEqual(plan(state), [{ taskId: RUN_ID, role: 'research', seedKind: 'initial' }]);
  });

  it('gate revise re-plans the interview, not the draft', () => {
    const state = derive([
      created(),
      started,
      interviewOk,
      specOk,
      specWritten,
      openedGate('spec'),
      answeredGate('spec', 'revise'),
    ]);
    const desired = plan(state);
    assert.deepEqual(desired, [{ taskId: RUN_ID, role: 'interview', seedKind: 'revise' }]);
    assert.equal(desired[0].role, 'interview', 'revise must not replan the draft');
  });

  it('reviewRounds: 0 skips review and goes straight from draft to polish', () => {
    const state = derive([
      created({ reviewRounds: 0 }),
      started,
      interviewOk,
      specOk,
      specWritten,
      openedGate('spec'),
      answeredGate('spec', 'confirm'),
      startedStage('research', 'r1'),
      researchOk,
      startedStage('draft', 'd1'),
      draftOk,
      planWritten,
    ]);
    const desired = plan(state);
    assert.deepEqual(desired, [{ taskId: RUN_ID, role: 'polish', seedKind: 'initial' }]);
    assert.equal(desired[0].role, 'polish', 'review must be skipped entirely');
  });

  it('the review loop exits on no progress (a round resolves nothing)', () => {
    const state = derive([
      created({ research: false }),
      started,
      interviewOk,
      specOk,
      specWritten,
      openedGate('spec'),
      answeredGate('spec', 'confirm'),
      draftOk,
      planWritten,
      reviewRound(1, [F1]),
      endedStage('draft', 'd2', 'ok'),
      makeEvent('plan.written', { path: 'documentation/plans/plan-1.md' }),
      reviewRound(2, [F1]),
    ]);
    const desired = plan(state);
    assert.deepEqual(desired, [{ taskId: RUN_ID, role: 'polish', seedKind: 'initial' }]);
    assert.notEqual(desired[0]?.role, 'draft', 'a no-progress round must not rewrite the draft');
  });

  it('the review loop exits on the round cap', () => {
    const state = derive([
      created({ research: false, reviewRounds: 1 }),
      started,
      interviewOk,
      specOk,
      specWritten,
      openedGate('spec'),
      answeredGate('spec', 'confirm'),
      draftOk,
      planWritten,
      reviewRound(1, [F1]),
      endedStage('draft', 'd2', 'ok'),
      makeEvent('plan.written', { path: 'documentation/plans/plan-1.md' }),
    ]);
    const desired = plan(state);
    assert.deepEqual(desired, [{ taskId: RUN_ID, role: 'polish', seedKind: 'initial' }]);
    assert.notEqual(desired[0]?.role, 'review', 'the cap must stop further review rounds');
  });

  it('research disabled skips research entirely', () => {
    const state = derive([
      created({ research: false }),
      started,
      interviewOk,
      specOk,
      specWritten,
      openedGate('spec'),
      answeredGate('spec', 'confirm'),
    ]);
    assert.deepEqual(plan(state), [{ taskId: RUN_ID, role: 'draft', seedKind: 'initial' }]);
  });

  it('polish skipped sends the draft to the accept gate', () => {
    const state = derive([
      created({ research: false, reviewRounds: 0, polish: 'never' }),
      started,
      interviewOk,
      specOk,
      specWritten,
      openedGate('spec'),
      answeredGate('spec', 'confirm'),
      draftOk,
      planWritten,
    ]);
    assert.deepEqual(plan(state), (state.gate?.status === 'open' || state.pendingGate) && state.status === 'running' && !state.finished ? [{ taskId: RUN_ID, role: 'gate', seedKind: state.gate?.kind ?? state.pendingGate }] : []);
    const graph = createSuperPlanGraph();
    assert.deepEqual(graph.impliedEvents(state), []);
  });

  it('a cancelled run plans nothing and stops', () => {
    const state = derive([created(), started, cancelled]);
    assert.deepEqual(plan(state), (state.gate?.status === 'open' || state.pendingGate) && state.status === 'running' && !state.finished ? [{ taskId: RUN_ID, role: 'gate', seedKind: state.gate?.kind ?? state.pendingGate }] : []);
    assert.equal(state.finished, true);
    assert.equal(state.stopReason, 'cancelled');
  });

  it('an expired gate plans nothing and stops the run', () => {
    const state = derive([
      created(),
      started,
      interviewOk,
      specOk,
      specWritten,
      openedGate('spec'),
      gateExpired,
    ]);
    assert.deepEqual(plan(state), (state.gate?.status === 'open' || state.pendingGate) && state.status === 'running' && !state.finished ? [{ taskId: RUN_ID, role: 'gate', seedKind: state.gate?.kind ?? state.pendingGate }] : []);
    assert.equal(state.finished, true);
    assert.equal(state.stopReason, 'gate-expired');
  });

  it('interview disabled starts at the spec', () => {
    const state = derive([created({ interview: false }), started]);
    assert.deepEqual(plan(state), [{ taskId: RUN_ID, role: 'gate', seedKind: 'spec' }]);
  });
});

// ── review set-difference ────────────────────────────────────────────────────

describe('super-plan review finding resolution', () => {
  it('resolves findings as union-of-previous minus open across rounds', () => {
    const I1 = { title: 'Naming nit', detail: 'Rename the helper.', severity: 'info', paths: [] };
    const state = derive([
      created(),
      started,
      reviewRound(1, [F1, I1]),
      reviewRound(2, [F2]),
    ]);
    const { blocking, resolved } = currentFindings(state);
    assert.deepEqual(blocking, [findingId(F2.title, F2.paths)]);
    // open = round 2 = {F2}; resolved = union(round 1) − open = {F1, I1}.
    assert.deepEqual(resolved, [
      findingId(F1.title, F1.paths),
      findingId(I1.title, I1.paths),
    ]);
  });

  it('derives stable finding ids from title + sorted paths', () => {
    const same = derive([
      created(),
      started,
      reviewRound(1, [F1]),
      reviewRound(2, [F1]),
    ]);
    const first = same.reviews[0].findings[0].id;
    const second = same.reviews[1].findings[0].id;
    assert.equal(second, first, 'same finding text across rounds must keep the id');
    assert.equal(second, findingId(F1.title, F1.paths));

    const changed = derive([
      created(),
      started,
      reviewRound(1, [F1]),
      reviewRound(2, [{ ...F1, title: 'Dependency order is now correct' }]),
    ]);
    assert.notEqual(
      changed.reviews[1].findings[0].id,
      changed.reviews[0].findings[0].id,
      'a changed title must change the id',
    );
  });

  it('a draft rewrite after blocking findings carries the findings seed', () => {
    const state = derive([
      created({ research: false }),
      started,
      interviewOk,
      specOk,
      specWritten,
      openedGate('spec'),
      answeredGate('spec', 'confirm'),
      draftOk,
      planWritten,
      reviewRound(1, [F1]),
    ]);
    assert.equal(seedKindFor(state, 'draft'), 'findings');
    assert.deepEqual(plan(state), [{ taskId: RUN_ID, role: 'draft', seedKind: 'findings' }]);
  });
});

// ── accept gate ──────────────────────────────────────────────────────────────

describe('super-plan accept gate routing', () => {
  const base = [
    created({ research: false, reviewRounds: 0, polish: 'never' }),
    started,
    interviewOk,
    specOk,
    specWritten,
    openedGate('spec'),
    answeredGate('spec', 'confirm'),
    draftOk,
    planWritten,
    openedGate('accept'),
  ];

  it('a first rejection retries the draft with the errors in the seed', () => {
    const state = derive([...base, answeredGate('accept', 'reject', ['paths are wrong'])]);
    assert.deepEqual(plan(state), [{ taskId: RUN_ID, role: 'draft', seedKind: 'errors' }]);
  });

  it('a second rejection fails the run', () => {
    const state = derive([
      ...base,
      answeredGate('accept', 'reject', ['paths are wrong']),
      endedStage('draft', 'd2', 'ok'),
      makeEvent('plan.written', { path: 'documentation/plans/plan-1.md' }),
      openedGate('accept'),
      answeredGate('accept', 'reject', ['still wrong']),
    ]);
    assert.deepEqual(plan(state), (state.gate?.status === 'open' || state.pendingGate) && state.status === 'running' && !state.finished ? [{ taskId: RUN_ID, role: 'gate', seedKind: state.gate?.kind ?? state.pendingGate }] : []);
    const graph = createSuperPlanGraph();
    assert.deepEqual(graph.impliedEvents(state), [
      makeEvent('run.finished', {
        outcome: 'fail',
        summary: 'the pipeline exhausted its retries',
      }),
    ]);
  });

  it('an accepted plan finishes the run', () => {
    const state = derive([...base, answeredGate('accept', 'accept')]);
    const graph = createSuperPlanGraph();
    assert.deepEqual(graph.impliedEvents(state), [
      makeEvent('run.finished', {
        outcome: 'pass',
        summary: 'the plan passed the accept gate',
      }),
    ]);
  });
});

// ── event vocabulary ─────────────────────────────────────────────────────────

describe('super-plan event vocabulary', () => {
  it('has no .requested or .pending event names', () => {
    const offenders = EVENT_TYPES.filter(
      (type) => type.endsWith('.requested') || type.endsWith('.pending'),
    );
    assert.deepEqual(offenders, []);
  });

  it('validates known events and tolerates unknown ones', () => {
    const ok = validateEvent(makeEvent('gate.answered', { kind: 'spec', verdict: 'confirm' }));
    assert.equal(ok.ok, true);
    assert.equal(ok.known, true);

    const bad = validateEvent(
      makeEvent('stage.ended', { stage: 'draft', attemptId: 'a1' }),
    );
    assert.equal(bad.ok, false);
    assert.match(bad.error, /stage.ended.outcome: is required/);

    const unknown = validateEvent(makeEvent('run.magic', {}));
    assert.equal(unknown.ok, true);
    assert.equal(unknown.known, false);
  });

  it('makeEvent stamps the envelope version', () => {
    const event = makeEvent('run.renamed', { slug: 'oauth-login-flow' });
    assert.equal(event.v, 1);
    assert.equal(event.type, 'run.renamed');
  });

  it('run.renamed finalizes the identity', () => {
    const state = derive([
      created(),
      started,
      makeEvent('run.renamed', { slug: 'oauth-login-flow' }),
    ]);
    assert.equal(state.slug, 'oauth-login-flow');
  });

  it('lifecycle fields are exposed on derived state', () => {
    const running = derive([created(), started]);
    assert.equal(running.status, 'running');
    assert.equal(running.finished, false);
    assert.equal(running.stopReason, null);

    const cancelledState = derive([created(), started, cancelled]);
    assert.equal(cancelledState.status, 'stopped');
    assert.equal(cancelledState.finished, true);
    assert.equal(cancelledState.stopReason, 'cancelled');

    const passed = derive([created(), started, makeEvent('run.finished', { outcome: 'pass', summary: 'ok' })]);
    assert.equal(passed.finished, true);
    assert.equal(passed.stopReason, 'complete');

    const failed = derive([created(), started, makeEvent('run.finished', { outcome: 'fail', summary: 'no' })]);
    assert.equal(failed.finished, true);
    assert.equal(failed.stopReason, 'failed');
  });
});

// ── policy table ─────────────────────────────────────────────────────────────

describe('super-plan policy table', () => {
  it('routes ok to accept', () => {
    assert.deepEqual(decide({ stage: 'interview', outcome: 'ok', attemptCount: 1 }), {
      kind: 'accept',
    });
    assert.deepEqual(decide({ stage: 'draft', outcome: 'ok', attemptCount: 2 }), { kind: 'accept' });
  });

  it('retries crashed/timeout below three attempts', () => {
    assert.deepEqual(decide({ stage: 'interview', outcome: 'crashed', attemptCount: 1 }), {
      kind: 'retry',
      seedKind: 'continue',
    });
    assert.deepEqual(decide({ stage: 'draft', outcome: 'timeout', attemptCount: 2 }), {
      kind: 'retry',
      seedKind: 'continue',
    });
  });

  it('fails the run once interview/draft retries are exhausted', () => {
    assert.deepEqual(decide({ stage: 'interview', outcome: 'crashed', attemptCount: 3 }), {
      kind: 'fail',
    });
    assert.deepEqual(decide({ stage: 'draft', outcome: 'timeout', attemptCount: 3 }), {
      kind: 'fail',
    });
  });

  it('skips research/polish/review once retries are exhausted', () => {
    assert.deepEqual(decide({ stage: 'research', outcome: 'crashed', attemptCount: 3 }), {
      kind: 'skip',
    });
    assert.deepEqual(decide({ stage: 'review', outcome: 'timeout', attemptCount: 3 }), {
      kind: 'skip',
    });
    assert.deepEqual(decide({ stage: 'polish', outcome: 'crashed', attemptCount: 3 }), {
      kind: 'skip',
    });
  });

  it('retries a draft rejected by the accept gate below two rejections, then fails', () => {
    assert.deepEqual(decide({ stage: 'draft', outcome: 'rejected', attemptCount: 1 }), {
      kind: 'retry',
      seedKind: 'errors',
    });
    assert.deepEqual(decide({ stage: 'draft', outcome: 'rejected', attemptCount: 2 }), {
      kind: 'fail',
    });
  });

  it('stops on gate expiry', () => {
    assert.deepEqual(decide({ stage: 'gate', outcome: 'expired', attemptCount: 1 }), {
      kind: 'stop',
    });
  });

  it('is total over every stage/outcome combination', () => {
    for (const stage of ['interview', 'spec', 'research', 'draft', 'review', 'polish', 'gate']) {
      for (const outcome of ['ok', 'crashed', 'timeout', 'rejected', 'expired', 'mystery']) {
        const action = decide({ stage, outcome, attemptCount: 0 });
        assert.ok(['accept', 'retry', 'skip', 'fail', 'stop'].includes(action.kind), `${stage}/${outcome}`);
      }
    }
  });

  it('renders the documented rows', () => {
    const md = formatPolicyTable();
    assert.match(md, /\| interview \| crashed \| < 3 \| retry, continue seed \|/);
    assert.match(md, /\| draft \| rejected \| < 2 \| retry, errors seed \|/);
    assert.match(md, /\| research \| timeout \| — \| skip \|/);
    assert.match(md, /\| gate \| expired \| — \| stop \|/);
    assert.ok(Array.isArray(POLICY_TABLE));
    assert.equal(POLICY_TABLE[POLICY_TABLE.length - 1].outcome, '*');
  });
});

// ── graph surface ────────────────────────────────────────────────────────────

describe('super-plan graph surface', () => {
  it('createSuperPlanGraph exposes the engine-facing surface', () => {
    const graph = createSuperPlanGraph();
    assert.equal(typeof graph.foldInto, 'function');
    assert.equal(typeof graph.plan, 'function');
    assert.equal(typeof graph.impliedEvents, 'function');
    assert.equal(typeof graph.isAlreadyEnded, 'function');
    assert.equal(typeof graph.reapVanished, 'function');
    assert.equal(typeof graph.eventsForStart, 'function');
    assert.equal(typeof graph.eventsForAttemptEnd, 'function');
    assert.equal(graph.defaultConcurrency, 1);
  });

  it('isSuperPlanRole accepts pipeline stages only', () => {
    assert.equal(isSuperPlanRole('interview'), true);
    assert.equal(isSuperPlanRole('draft'), true);
    assert.equal(isSuperPlanRole('builder'), false);
    assert.equal(isSuperPlanRole('merge'), false);
  });

  it('eventsForStart journals stage.started', () => {
    const graph = createSuperPlanGraph();
    assert.deepEqual(
      graph.eventsForStart({ taskId: RUN_ID, role: 'draft', seedKind: 'findings' }, { attemptId: 'a1' }),
      [makeEvent('stage.started', { stage: 'draft', attemptId: 'a1', seedKind: 'findings' })],
    );
  });

  it('eventsForAttemptEnd maps runner outcomes onto the stage vocabulary', () => {
    const graph = createSuperPlanGraph();
    assert.deepEqual(
      graph.eventsForAttemptEnd({ attemptId: 'a1', taskId: RUN_ID, role: 'draft', outcome: 'pass' }),
      [makeEvent('stage.ended', { stage: 'draft', attemptId: 'a1', outcome: 'ok' })],
    );
    assert.deepEqual(
      graph.eventsForAttemptEnd({
        attemptId: 'a2',
        taskId: RUN_ID,
        role: 'draft',
        outcome: 'fail',
        evidence: { errors: ['paths are wrong'] },
      }),
      [
        makeEvent('stage.ended', {
          stage: 'draft',
          attemptId: 'a2',
          outcome: 'rejected',
          errors: ['paths are wrong'],
        }),
      ],
    );
  });

  it('reapVanished closes attempts that are neither live nor buffered', () => {
    const graph = createSuperPlanGraph();
    const state = derive([created(), started, startedStage('draft', 'a1')]);
    assert.deepEqual(
      graph.reapVanished(state, new Set(), new Set()),
      [
        makeEvent('stage.ended', {
          stage: 'draft',
          attemptId: 'a1',
          outcome: 'crashed',
          summary: 'the process was no longer running',
        }),
      ],
    );
    assert.deepEqual(graph.reapVanished(state, new Set(['a1']), new Set()), []);
  });

  it('isAlreadyEnded reads the attempt list', () => {
    const graph = createSuperPlanGraph();
    const state = derive([
      created(),
      started,
      startedStage('draft', 'a1'),
      endedStage('draft', 'a1', 'ok'),
    ]);
    assert.equal(graph.isAlreadyEnded(state, 'a1'), true);
    assert.equal(graph.isAlreadyEnded(state, 'ghost'), false);
  });

  it('impliedEvents opens gates and finishes runs', () => {
    const graph = createSuperPlanGraph();
    const atSpecGate = derive([created(), started, interviewOk, specOk, specWritten]);
    assert.deepEqual(graph.impliedEvents(atSpecGate), []);
    assert.deepEqual(plan(atSpecGate), [{ taskId: RUN_ID, role: 'gate', seedKind: 'spec' }]);
    const atAcceptGate = derive([
      created({ research: false, reviewRounds: 0, polish: 'never' }),
      started,
      interviewOk,
      specOk,
      specWritten,
      openedGate('spec'),
      answeredGate('spec', 'confirm'),
      draftOk,
      planWritten,
    ]);
    assert.deepEqual(graph.impliedEvents(atAcceptGate), []);
    assert.deepEqual(plan(atAcceptGate), [{ taskId: RUN_ID, role: 'gate', seedKind: 'accept' }]);
  });
});

// ── journal binding ──────────────────────────────────────────────────────────

describe('super-plan journal binding', () => {
  it('resolves to ~/.minnow/superplan/<runId>/journal.jsonl', () => {
    assert.equal(SUPERPLAN_NAMESPACE, 'superplan');
    const file = journalPath('run-1');
    assert.ok(file.endsWith(path.join('superplan', 'run-1', 'journal.jsonl')), file);
    assert.equal(runDir('run-1'), path.dirname(file));
  });
});