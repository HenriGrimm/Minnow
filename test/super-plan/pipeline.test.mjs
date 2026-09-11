/**
 * Super Plan end to end on the server: HTTP routes, the engine, the single
 * effector and real `runTurn` + tool dispatch, with a scripted model.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { answerFirstOptions, createScriptedModel, startHarness, validPlan } from '../helpers/super-plan-harness.mjs';

test('a run interviews, confirms the spec, drafts, reviews, revises and is accepted', async () => {
  const scripted = createScriptedModel({
    reviews: [
      [{ title: 'Replay has no ordering guarantee', severity: 'blocker', detail: 'W2-A does not say writes replay in order.', fix: 'State FIFO replay in W2-A.', paths: ['src/sync/connection.ts'] }],
      [],
    ],
  });
  const h = await startHarness({ model: scripted.model });
  try {
    const runId = await h.create({ research: false, polish: 'never', reviewRounds: 2, questionBudget: 6 });

    let current = await h.until(runId, (v) => v.needsInput === 'question', 'the interview question');
    assert.equal(current.status, 'waiting');
    assert.equal(current.question.questions.length, 2);
    assert.equal(current.question.questions[1].options[1].recommended, true, 'a "(Recommended)" label becomes a flag');
    assert.equal(current.question.questions[1].options[1].label, '1000 writes');
    assert.equal((await answerFirstOptions(h, runId, current)).ok, true);

    current = await h.until(runId, (v) => v.needsInput === 'spec', 'the spec checkpoint');
    assert.equal(current.slug, 'offline-write-queue', 'the slug comes from the spec title');
    assert.equal(current.artifacts.spec.path, 'documentation/plans/references/offline-write-queue-spec.md');
    const references = await fs.readdir(path.join(h.workspace, 'documentation/plans/references'));
    assert.deepEqual(references, ['offline-write-queue-spec.md'], 'the interim spec is moved, not copied');
    assert.equal(current.title, 'Offline write queue');

    assert.equal((await h.api('POST', `/${runId}/checkpoint`, { checkpoint: 'spec', verdict: 'confirm' })).ok, true);
    current = await h.until(runId, (v) => v.needsInput === 'accept', 'the accept checkpoint');
    assert.equal(current.reviews.length, 2);
    assert.equal(current.reviews[0].findings[0].severity, 'blocker');
    assert.equal(current.reviewExit.reason, 'clean');
    assert.equal(current.artifacts.plan.path, 'documentation/plans/offline-write-queue.md');
    assert.equal(current.artifacts.plan.tasks, 2);
    const plan = await fs.readFile(path.join(h.workspace, current.artifacts.plan.path), 'utf8');
    assert.match(plan, /Draft 2\./, 'the revision replaced the first draft');

    const draftSeeds = scripted.calls.filter((c) => c.stage === 'draft').map((c) => c.seed);
    assert.ok(draftSeeds.some((seed) => seed.includes('Replay has no ordering guarantee') && seed.includes('State FIFO replay')), 'the revision sees the finding and its fix');

    const transcripts = await h.api('GET', `/${runId}/transcripts`);
    assert.deepEqual(transcripts.transcripts.map((t) => t.key), ['interview-1', 'draft-1', 'review-1', 'draft-2', 'review-2']);
    assert.ok(transcripts.transcripts.every((t) => t.messageCount > 0));
    const interview = await h.api('GET', `/${runId}/transcripts/interview-1`);
    assert.ok(interview.messages.some((m) => m.role === 'tool' && String(m.content).startsWith('The user answered')));

    const accepted = await h.api('POST', `/${runId}/checkpoint`, { checkpoint: 'accept', verdict: 'accept' });
    assert.equal(accepted.view.status, 'done');
    assert.equal(accepted.view.finished, true);
  } finally {
    await h.stop();
  }
});

test('questions survive a pause, and answering resumes the interview from its transcript', async () => {
  const h = await startHarness();
  try {
    const runId = await h.create({ research: false, polish: 'never', reviewRounds: 0 });
    let current = await h.until(runId, (v) => v.needsInput === 'question', 'the question');
    const questionId = current.question.questionId;
    current = (await h.api('POST', `/${runId}/pause`)).view;
    assert.equal(current.status, 'paused');
    assert.equal(current.question?.questionId, questionId, 'pausing keeps the question open');

    const answered = await answerFirstOptions(h, runId, current);
    assert.equal(answered.ok, true);
    current = await h.until(runId, (v) => v.needsInput === 'spec', 'the spec after resuming');
    const interview = await h.api('GET', `/${runId}/transcripts/interview-1`);
    const asks = interview.messages.filter((m) => m.role === 'assistant' && (m.tool_calls ?? []).some((c) => c.function.name === 'ask_question'));
    assert.equal(asks.length, 1, 'the resumed attempt answered the dangling question instead of asking again');
    const answers = interview.messages.filter((m) => m.role === 'tool' && String(m.content).startsWith('The user answered'));
    assert.equal(answers.length, 1);
    assert.equal(current.steps.find((s) => s.id === 'interview').state, 'done');
  } finally {
    await h.stop();
  }
});

test('stop asking makes the interview write the spec with what it has', async () => {
  const h = await startHarness();
  try {
    const runId = await h.create({ research: false, polish: 'never', reviewRounds: 0 });
    await h.until(runId, (v) => v.needsInput === 'question', 'the question');
    const closed = await h.api('POST', `/${runId}/questions/close`);
    assert.equal(closed.ok, true);
    const current = await h.until(runId, (v) => v.needsInput === 'spec', 'the spec');
    assert.equal(current.questions[0].status, 'skipped');
    const interview = await h.api('GET', `/${runId}/transcripts/interview-1`);
    assert.ok(interview.messages.some((m) => m.role === 'tool' && String(m.content).includes('stop asking questions')));
  } finally {
    await h.stop();
  }
});

test('a plan that never parses halts the run, and retry gives it a fresh budget', async () => {
  let broken = true;
  const scripted = createScriptedModel({
    plan: () => (broken
      ? '# Offline queue plan\n\n## Context\nWrites made while offline are lost today; this plan keeps them and replays them later on.\n\n## Approach\nAdd a queue in the sync layer, drain it when the connection returns, and cover both with tests.\n'
      : validPlan()),
  });
  const h = await startHarness({ model: scripted.model });
  try {
    const runId = await h.create({ interview: false, research: false, polish: 'never', reviewRounds: 0 });
    await h.until(runId, (v) => v.needsInput === 'spec', 'the spec');
    await h.api('POST', `/${runId}/checkpoint`, { checkpoint: 'spec', verdict: 'confirm' });
    let current = await h.until(runId, (v) => v.status === 'halted', 'the halt');
    assert.equal(current.halted.stage, 'draft');
    assert.match(current.halted.errors.join('\n'), /does not parse as a board plan/);
    const seeds = scripted.calls.filter((c) => c.stage === 'draft').map((c) => c.seed);
    assert.ok(seeds.some((seed) => seed.startsWith('Your last save did not pass its checks')), 'retries carry the errors');
    assert.equal(current.actions.retry, true);

    broken = false;
    current = (await h.api('POST', `/${runId}/resume`)).view;
    current = await h.until(runId, (v) => v.needsInput === 'accept', 'the accept checkpoint after retry');
    assert.equal(current.artifacts.plan.tasks, 2);
  } finally {
    await h.stop();
  }
});

test('research that finds nothing is recorded as empty and the plan drafts from the spec', async () => {
  const research = {
    startResearch: async () => ({ researchId: 'rs-000000000001' }),
    getResearchStatus: async () => ({ status: 'done', progress: {} }),
    getResearchResult: async () => ({ result: 'No information could be gathered for this question.', sources: [] }),
    cancelResearch: () => true,
    getResearchTask: () => undefined,
  };
  const scripted = createScriptedModel();
  const h = await startHarness({ model: scripted.model, research });
  try {
    const runId = await h.create({ interview: false, research: true, polish: 'never', reviewRounds: 0 });
    await h.until(runId, (v) => v.needsInput === 'spec', 'the spec');
    await h.api('POST', `/${runId}/checkpoint`, { checkpoint: 'spec', verdict: 'confirm' });
    const current = await h.until(runId, (v) => v.needsInput === 'accept', 'the accept checkpoint');
    assert.equal(current.artifacts.research.empty, true);
    assert.equal(current.steps.find((s) => s.id === 'research').detail, 'nothing found');
    await assert.rejects(fs.access(path.join(h.workspace, 'documentation/plans/references/offline-write-queue-research.md')), 'no empty report in the repo');
    const draftSeed = scripted.calls.find((c) => c.stage === 'draft').seed;
    assert.doesNotMatch(draftSeed, /Research:/, 'the drafter is not pointed at an empty report');
  } finally {
    await h.stop();
  }
});

test('requesting changes at acceptance revises the plan without limit, and review again runs one round', async () => {
  const scripted = createScriptedModel({ reviews: [[{ title: 'Note', severity: 'info', detail: 'Optional.' }]] });
  const h = await startHarness({ model: scripted.model });
  try {
    const runId = await h.create({ interview: false, research: false, polish: 'never', reviewRounds: 1 });
    await h.until(runId, (v) => v.needsInput === 'spec', 'the spec');
    await h.api('POST', `/${runId}/checkpoint`, { checkpoint: 'spec', verdict: 'confirm' });
    await h.until(runId, (v) => v.needsInput === 'accept', 'the first accept checkpoint');
    for (let i = 1; i <= 3; i += 1) {
      const revised = await h.api('POST', `/${runId}/checkpoint`, { checkpoint: 'accept', verdict: 'revise', feedback: `Change ${i}` });
      assert.equal(revised.ok, true, JSON.stringify(revised));
      await h.until(runId, (v) => v.needsInput === 'accept' && v.checkpoints.filter((c) => c.checkpoint === 'accept').length === i, `accept after revision ${i}`);
    }
    const feedbackSeeds = scripted.calls.filter((c) => c.stage === 'draft' && c.seed.includes('want these changes'));
    assert.ok(feedbackSeeds.some((c) => c.seed.includes('Change 3')));

    await h.api('POST', `/${runId}/checkpoint`, { checkpoint: 'accept', verdict: 'review' });
    const current = await h.until(runId, (v) => v.needsInput === 'accept' && v.reviews.length === 2, 'accept after another review');
    assert.equal(current.reviews[1].cycle, 2);
    const done = await h.api('POST', `/${runId}/checkpoint`, { checkpoint: 'accept', verdict: 'accept' });
    assert.equal(done.view.status, 'done');
    const reopened = await h.api('POST', `/${runId}/checkpoint`, { checkpoint: 'accept', verdict: 'revise', feedback: 'One more thing' });
    assert.equal(reopened.view.status, 'running', 'an accepted plan can be reopened with notes');
    await h.until(runId, (v) => v.needsInput === 'accept', 'accept after reopening');
  } finally {
    await h.stop();
  }
});

test('skipping review mid-round stops it and moves on; rework from draft replaces the plan', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const base = createScriptedModel();
  const model = async (provider, body) => {
    const system = String(body.messages[0].content);
    if (system.includes('## Your stage: Plan review')) {
      await gate;
    }
    return base.model(provider, body);
  };
  const h = await startHarness({ model });
  try {
    const runId = await h.create({ interview: false, research: false, polish: 'never', reviewRounds: 2 });
    await h.until(runId, (v) => v.needsInput === 'spec', 'the spec');
    await h.api('POST', `/${runId}/checkpoint`, { checkpoint: 'spec', verdict: 'confirm' });
    await h.until(runId, (v) => v.current === 'review', 'the review');
    const skipped = await h.api('POST', `/${runId}/skip`, { stage: 'review' });
    assert.equal(skipped.ok, true, JSON.stringify(skipped));
    let current = await h.until(runId, (v) => v.needsInput === 'accept', 'accept after skipping');
    assert.equal(current.reviewExit.reason, 'skipped');
    release();

    const rework = await h.api('POST', `/${runId}/rework`, { stage: 'draft' });
    assert.equal(rework.ok, true, JSON.stringify(rework));
    current = await h.until(runId, (v) => v.needsInput === 'accept' && v.transcripts.some((t) => t.key === 'draft-2'), 'accept after rework');
    assert.ok(current.reviews.length >= 1, 'the reworked plan was reviewed again');
  } finally {
    release();
    await h.stop();
  }
});
