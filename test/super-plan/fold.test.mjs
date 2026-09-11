/** Pure fold, scheduler and policy tables for the Super Plan core. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { derive, normalizeFindings, readConfig } from '../../server/super-plan/derive.js';
import { eventsForAttemptEnd, reapVanished } from '../../server/super-plan/graph.js';
import { plan, seedKindFor, taskIdFor } from '../../server/super-plan/plan.js';
import { decide, formatPolicyTable } from '../../server/super-plan/policy.js';
import { projectChatSummary, projectRunView } from '../../server/super-plan/projection.js';

/** Build a journal with sequential seq/ts. */
function journal(...events) {
  return events.map((event, index) => ({ v: 1, seq: index + 1, ts: 1000 + index, ...event }));
}

const created = (config = {}) => ({ type: 'run.created', runId: 'run', prompt: 'Build a queue', workspacePath: '/w', config: { engine: 3, ...config } });
const started = { type: 'run.started' };
const start = (stage, attemptId) => ({ type: 'stage.started', stage, attemptId });
const ok = (stage, attemptId, evidence = {}) =>
  eventsForAttemptEnd({ attemptId, taskId: 'run~0', role: stage, outcome: 'ok', evidence });
const fail = (stage, attemptId, outcome = 'crashed') => ({ type: 'stage.ended', stage, attemptId, outcome, summary: 'boom', errors: ['e'] });
const specOk = (id = 'i1') => ok('interview', id, { artifact: { kind: 'spec', path: 'documentation/plans/references/q-spec.md' }, slug: { slug: 'q', title: 'Queue' } });
const planOk = (id, ui = false) => ok('draft', id, { artifact: { kind: 'plan', path: 'documentation/plans/q.md', involvesUi: ui, tasks: 2 } });
const reviewOk = (id, findings) => ok('review', id, { review: { summary: 's', findings } });

describe('fold', () => {
  it('starts at the interview and runs it', () => {
    const state = derive(journal(created(), started));
    assert.deepEqual(plan(state), [{ taskId: 'run~0', role: 'interview', seedKind: 'initial' }]);
  });

  it('a spec opens the spec checkpoint, which wants nothing from the engine', () => {
    const state = derive(journal(created(), started, start('interview', 'i1'), ...specOk()));
    assert.deepEqual(state.step, { kind: 'checkpoint', checkpoint: 'spec', since: 1005 });
    assert.equal(state.slug, 'q');
    assert.equal(state.title, 'Queue');
    assert.deepEqual(plan(state), []);
    assert.equal(projectRunView(state).needsInput, 'spec');
  });

  it('confirming skips research when it is off; revising re-interviews with the notes', () => {
    const base = [created({ research: false }), started, start('interview', 'i1'), ...specOk()];
    const confirmed = derive(journal(...base, { type: 'checkpoint.answered', checkpoint: 'spec', verdict: 'confirm' }));
    assert.equal(plan(confirmed)[0].role, 'draft');
    const revised = derive(journal(...base, { type: 'checkpoint.answered', checkpoint: 'spec', verdict: 'revise', feedback: 'Add limits' }));
    assert.deepEqual(plan(revised)[0], { taskId: 'run~0', role: 'interview', seedKind: 'revise' });
    assert.equal(revised.feedback.spec, 'Add limits');
  });

  it('review findings drive a revision; a clean round ends the cycle at the accept checkpoint', () => {
    const state = derive(journal(
      created({ research: false, reviewRounds: 2, polish: 'never' }), started,
      start('interview', 'i1'), ...specOk(),
      { type: 'checkpoint.answered', checkpoint: 'spec', verdict: 'confirm' },
      start('draft', 'd1'), ...planOk('d1'),
      start('review', 'r1'), ...reviewOk('r1', [{ title: 'Missing tests', severity: 'warn', detail: 'd' }]),
    ));
    assert.deepEqual(plan(state)[0], { taskId: 'run~0', role: 'draft', seedKind: 'findings' });
    const after = derive(journal(
      created({ research: false, reviewRounds: 2, polish: 'never' }), started,
      start('interview', 'i1'), ...specOk(),
      { type: 'checkpoint.answered', checkpoint: 'spec', verdict: 'confirm' },
      start('draft', 'd1'), ...planOk('d1'),
      start('review', 'r1'), ...reviewOk('r1', [{ title: 'Missing tests', severity: 'warn', detail: 'd' }]),
      start('draft', 'd2'), ...planOk('d2'),
      start('review', 'r2'), ...reviewOk('r2', [{ title: 'Nit', severity: 'info', detail: 'd' }]),
    ));
    assert.deepEqual(after.step, { kind: 'checkpoint', checkpoint: 'accept', since: after.step.since });
    assert.equal(after.reviewExit.reason, 'clean');
  });

  it('the same actionable findings twice end the cycle as no progress', () => {
    const findings = [{ id: 'f-1', title: 'Missing tests', severity: 'blocker', detail: 'd' }];
    const state = derive(journal(
      created({ research: false, reviewRounds: 4, polish: 'never' }), started,
      start('interview', 'i1'), ...specOk(), { type: 'checkpoint.answered', checkpoint: 'spec', verdict: 'confirm' },
      start('draft', 'd1'), ...planOk('d1'),
      start('review', 'r1'), ...reviewOk('r1', findings),
      start('draft', 'd2'), ...planOk('d2'),
      start('review', 'r2'), ...reviewOk('r2', findings),
    ));
    assert.equal(state.reviewExit.reason, 'no-progress');
    assert.equal(state.step.kind, 'checkpoint');
  });

  it('the round cap ends the cycle after the last revision and polish runs for UI plans', () => {
    const findings = (n) => [{ title: `Issue ${n}`, severity: 'warn', detail: 'd' }];
    const state = derive(journal(
      created({ research: false, reviewRounds: 1, polish: 'auto' }), started,
      start('interview', 'i1'), ...specOk(), { type: 'checkpoint.answered', checkpoint: 'spec', verdict: 'confirm' },
      start('draft', 'd1'), ...planOk('d1', true),
      start('review', 'r1'), ...reviewOk('r1', findings(1)),
      start('draft', 'd2'), ...planOk('d2', true),
    ));
    assert.equal(state.reviewExit.reason, 'round-cap');
    assert.deepEqual(plan(state)[0].role, 'polish');
  });

  it('retries failures with the same transcript, then halts a required stage and skips an optional one', () => {
    const draftFailures = derive(journal(
      created({ research: false }), started, start('interview', 'i1'), ...specOk(), { type: 'checkpoint.answered', checkpoint: 'spec', verdict: 'confirm' },
      start('draft', 'd1'), fail('draft', 'd1', 'rejected'),
    ));
    assert.equal(seedKindFor(draftFailures), 'errors');
    const halted = derive(journal(
      created({ research: false }), started, start('interview', 'i1'), ...specOk(), { type: 'checkpoint.answered', checkpoint: 'spec', verdict: 'confirm' },
      start('draft', 'd1'), fail('draft', 'd1'), start('draft', 'd2'), fail('draft', 'd2', 'timeout'), start('draft', 'd3'), fail('draft', 'd3'),
    ));
    assert.equal(halted.stopReason, 'halted');
    assert.equal(halted.finished, false);
    assert.deepEqual(plan(halted), []);
    const retried = derive(journal(
      created({ research: false }), started, start('interview', 'i1'), ...specOk(), { type: 'checkpoint.answered', checkpoint: 'spec', verdict: 'confirm' },
      start('draft', 'd1'), fail('draft', 'd1'), start('draft', 'd2'), fail('draft', 'd2'), start('draft', 'd3'), fail('draft', 'd3'),
      { type: 'run.resumed' },
    ));
    assert.deepEqual(plan(retried), [{ taskId: 'run~1', role: 'draft', seedKind: 'continue' }]);

    const researchSkipped = derive(journal(
      created(), started, start('interview', 'i1'), ...specOk(), { type: 'checkpoint.answered', checkpoint: 'spec', verdict: 'confirm' },
      start('research', 'x1'), fail('research', 'x1'), start('research', 'x2'), fail('research', 'x2'), start('research', 'x3'), fail('research', 'x3'),
    ));
    assert.equal(plan(researchSkipped)[0].role, 'draft');
    assert.equal(researchSkipped.skipped[0].reason, 'failed');
  });

  it('an interrupted attempt continues and never counts as a failure', () => {
    let events = [created(), started];
    for (let i = 0; i < 5; i += 1) {
      events = [...events, start('interview', `i${i}`), ...reapVanished(derive(journal(...events, start('interview', `i${i}`))), new Set(), new Set())];
    }
    const state = derive(journal(...events));
    assert.equal(state.stopReason, null);
    assert.equal(seedKindFor(state), 'continue');
  });

  it('pause ends the live attempt in the fold; resume continues it under a new epoch', () => {
    const paused = derive(journal(created(), started, start('interview', 'i1'), { type: 'run.paused' }));
    assert.equal(paused.attempts[0].outcome, 'paused');
    assert.deepEqual(plan(paused), []);
    const resumed = derive(journal(created(), started, start('interview', 'i1'), { type: 'run.paused' }, { type: 'run.resumed' }));
    assert.deepEqual(plan(resumed), [{ taskId: 'run~1', role: 'interview', seedKind: 'continue' }]);
    const stray = derive(journal(created(), started, { type: 'run.resumed' }));
    assert.equal(stray.epoch, 0, 'resuming a running run changes nothing');
  });

  it('a late end for a paused or superseded attempt is ignored', () => {
    const state = derive(journal(
      created(), started, start('interview', 'i1'), { type: 'run.paused' },
      ...specOk('i1'),
    ));
    assert.equal(state.step.kind, 'stage');
    assert.equal(state.step.stage, 'interview');
  });

  it('skip and rework replace running work; cancel is terminal', () => {
    const base = [created({ reviewRounds: 2 }), started, start('interview', 'i1'), ...specOk(), { type: 'checkpoint.answered', checkpoint: 'spec', verdict: 'confirm' }, start('research', 'x1')];
    const skipped = derive(journal(...base, { type: 'stage.skipped', stage: 'research', reason: 'user' }));
    assert.equal(skipped.attempts.find((a) => a.attemptId === 'x1').outcome, 'superseded');
    assert.deepEqual(plan(skipped), [{ taskId: 'run~1', role: 'draft', seedKind: 'initial' }]);
    const reworked = derive(journal(...base, { type: 'stage.reopened', stage: 'interview' }));
    assert.deepEqual(plan(reworked), [{ taskId: 'run~1', role: 'interview', seedKind: 'rework' }]);
    const cancelled = derive(journal(...base, { type: 'run.cancelled', reason: 'user' }, { type: 'stage.reopened', stage: 'draft' }));
    assert.equal(cancelled.finished, true);
    assert.deepEqual(plan(cancelled), []);
  });

  it('interview questions: open, answered, closed', () => {
    const questions = [{ id: 'q', prompt: 'Which?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }];
    const asked = derive(journal(created(), started, start('interview', 'i1'), { type: 'question.asked', questionId: 'interview-1-q1', attemptId: 'i1', questions }));
    const view = projectRunView(asked);
    assert.equal(view.needsInput, 'question');
    assert.equal(view.status, 'waiting');
    assert.equal(view.question.questionId, 'interview-1-q1');
    assert.equal(asked.questions[0].transcriptKey, 'interview-1');
    const closed = derive(journal(created(), started, start('interview', 'i1'), { type: 'question.asked', questionId: 'interview-1-q1', attemptId: 'i1', questions }, { type: 'questions.closed' }));
    assert.equal(closed.questions[0].status, 'skipped');
    assert.equal(closed.questionsClosed, true);
  });

  it('accepting finishes; revising an accepted plan reopens it', () => {
    const base = [created({ research: false, reviewRounds: 0, polish: 'never' }), started, start('interview', 'i1'), ...specOk(), { type: 'checkpoint.answered', checkpoint: 'spec', verdict: 'confirm' }, start('draft', 'd1'), ...planOk('d1')];
    const accepted = derive(journal(...base, { type: 'checkpoint.answered', checkpoint: 'accept', verdict: 'accept' }));
    assert.equal(accepted.finished, true);
    assert.equal(accepted.stopReason, 'complete');
    assert.equal(projectChatSummary(accepted).status, 'done');
    const reopened = derive(journal(...base, { type: 'checkpoint.answered', checkpoint: 'accept', verdict: 'accept' }, { type: 'checkpoint.answered', checkpoint: 'accept', verdict: 'revise', feedback: 'More tests' }));
    assert.equal(reopened.finished, false);
    assert.deepEqual(plan(reopened)[0], { taskId: 'run~0', role: 'draft', seedKind: 'feedback' });
  });

  it('a v2 journal folds read-only', () => {
    const v2 = derive(journal(
      { type: 'run.created', runId: 'old', prompt: 'p', config: { interview: true } },
      { type: 'run.started' },
      { type: 'stage.started', stage: 'gate', attemptId: 'gate-1', seedKind: 'spec' },
      { type: 'spec.written', path: 'documentation/plans/references/old-spec.md' },
    ));
    assert.equal(v2.legacy, true);
    assert.deepEqual(plan(v2), []);
    assert.equal(projectRunView(v2).status, 'legacy');
    const cancelled = derive(journal({ type: 'run.created', runId: 'old', prompt: 'p' }, { type: 'run.started' }, { type: 'run.cancelled', reason: 'user' }));
    assert.equal(projectRunView(cancelled).status, 'cancelled');
  });

  it('taskIdFor carries the epoch', () => {
    assert.equal(taskIdFor({ runId: 'r', epoch: 3 }), 'r~3');
  });
});

describe('config', () => {
  it('reads the renderer Settings keys and clamps numbers', () => {
    const config = readConfig({ grillEnabled: false, researchEnabled: false, impeccable: 'always', grillQuestionBudget: 99, reviewRounds: 9, plannerModel: { providerId: '', modelId: 'libgguf:x' } });
    assert.equal(config.interview, false);
    assert.equal(config.research, false);
    assert.equal(config.polish, 'always');
    assert.equal(config.questionBudget, 40);
    assert.equal(config.reviewRounds, 4);
    assert.deepEqual(config.plannerModel, { providerId: 'lib', modelId: 'gguf:x' });
  });
});

describe('findings', () => {
  it('keeps reviewer ids, derives the rest, and normalises severity words', () => {
    const findings = normalizeFindings([
      { id: 'f-keep', title: 'A', severity: 'critical', detail: 'x' },
      { title: 'B', severity: 'warning', detail: 'y', paths: ['b.ts', 'a.ts'] },
      { title: '' },
    ]);
    assert.equal(findings.length, 2);
    assert.equal(findings[0].id, 'f-keep');
    assert.equal(findings[0].severity, 'blocker');
    assert.equal(findings[1].severity, 'warn');
    assert.match(findings[1].id, /^f[0-9a-f]+$/);
    assert.equal(normalizeFindings([{ title: 'B', paths: ['a.ts', 'b.ts'] }])[0].id, findings[1].id, 'path order does not change the id');
  });
});

describe('policy', () => {
  it('retries twice, then skips optional stages and halts required ones', () => {
    assert.equal(decide({ stage: 'draft', outcome: 'crashed', attemptCount: 2 }).kind, 'retry');
    assert.equal(decide({ stage: 'draft', outcome: 'crashed', attemptCount: 3 }).kind, 'halt');
    assert.equal(decide({ stage: 'review', outcome: 'rejected', attemptCount: 3 }).kind, 'skip');
    assert.match(formatPolicyTable(), /\| optional \| — \| skip \|/);
  });
});
