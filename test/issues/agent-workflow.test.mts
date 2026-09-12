/**
 * Phase 4: the agent slot, the board→phase translation, and the dock badge.
 *
 * The store lifecycle and the board reading are tested separately from the
 * dispatch itself, because dispatch launches an app and the pieces that decide
 * *what the user sees* are the ones that must not drift.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import {
  addIssue,
  addIssueComment,
  appendIssueActivity,
  clearIssueAgentRun,
  deleteIssueComment,
  findIssueById,
  isIssueAgentActive,
  listIssuesWithActiveAgents,
  setIssuesStateForTests,
  startIssueAgentRun,
  updateIssueAgentRun,
} from '../../src/state/issues-store.ts';
import {
  computeIssuesDockBadge,
  issuesDockBadgeLabel,
  issuesDockBadgeText,
} from '../../src/issues/dock-badge.ts';
import {
  failureReasonForTasks,
  phaseForBoardTasks,
  stepLabelForTask,
} from '../../src/chat/issues/agent-watch.ts';
import { buildSingleTaskPlan } from '../../src/chat/issues/agent-dispatch.ts';
import { ISSUE_ACTIVITY_CAP, type BoardTask, type IssueCard } from '../../src/types.ts';

function task(partial: Partial<BoardTask>): BoardTask {
  return {
    id: partial.id ?? 't1',
    title: partial.title ?? 'Task',
    wave: partial.wave ?? 1,
    category: partial.category ?? ('build' as BoardTask['category']),
    status: partial.status ?? 'planned',
    ...partial,
  } as BoardTask;
}

beforeEach(() => {
  setIssuesStateForTests({ version: 2, schemaRevision: 3, nextId: 1, issues: [] });
});

afterEach(() => {
  setIssuesStateForTests(null);
});

describe('agent slot lifecycle', () => {
  test('starting a run fills the slot and records activity', () => {
    const issue = addIssue({ title: 'Broken thing' });
    const run = startIssueAgentRun(issue.id, { agentId: 'builder', step: 'Building' });

    assert.equal(run?.phase, 'running');
    assert.equal(run?.agentId, 'builder');
    const stored = findIssueById(issue.id);
    assert.equal(stored?.activity?.at(-1)?.kind, 'agent_started');
  });

  test('a terminal phase clears the live step so no stale chip survives', () => {
    const issue = addIssue({ title: 'x' });
    startIssueAgentRun(issue.id, { step: 'Running tests' });
    updateIssueAgentRun(issue.id, { phase: 'failed', error: 'tests failed' });

    const run = findIssueById(issue.id)?.agent;
    assert.equal(run?.phase, 'failed');
    assert.equal(run?.step, undefined);
    assert.equal(run?.error, 'tests failed');
  });

  test('a terminal phase clears a pending question', () => {
    const issue = addIssue({ title: 'x' });
    startIssueAgentRun(issue.id, {});
    updateIssueAgentRun(issue.id, { phase: 'awaiting_input', pendingQuestionId: 'q1' });
    assert.equal(findIssueById(issue.id)?.agent?.pendingQuestionId, 'q1');

    updateIssueAgentRun(issue.id, { phase: 'review' });
    assert.equal(findIssueById(issue.id)?.agent?.pendingQuestionId, undefined);
  });

  test('active means queued, running, or waiting — never review or failed', () => {
    const issue = addIssue({ title: 'x' });
    startIssueAgentRun(issue.id, {});
    assert.equal(isIssueAgentActive(findIssueById(issue.id) as IssueCard), true);
    assert.equal(listIssuesWithActiveAgents().length, 1);

    updateIssueAgentRun(issue.id, { phase: 'review' });
    assert.equal(isIssueAgentActive(findIssueById(issue.id) as IssueCard), false);
    assert.equal(listIssuesWithActiveAgents().length, 0);
  });

  test('clearing removes the slot entirely', () => {
    const issue = addIssue({ title: 'x' });
    startIssueAgentRun(issue.id, {});
    assert.equal(clearIssueAgentRun(issue.id), true);
    assert.equal(findIssueById(issue.id)?.agent, undefined);
    assert.equal(clearIssueAgentRun(issue.id), false);
  });
});

describe('comments and activity', () => {
  test('comments append rather than overwrite', () => {
    const issue = addIssue({ title: 'x' });
    addIssueComment(issue.id, { body: 'first' });
    addIssueComment(issue.id, { body: 'second', authorKind: 'agent', author: 'builder' });

    const comments = findIssueById(issue.id)?.comments ?? [];
    assert.deepEqual(comments.map((c) => c.body), ['first', 'second']);
    assert.equal(comments[1].authorKind, 'agent');
    assert.equal(comments[1].author, 'builder');
  });

  test('an empty comment is rejected', () => {
    const issue = addIssue({ title: 'x' });
    assert.equal(addIssueComment(issue.id, { body: '   ' }), null);
    assert.equal(findIssueById(issue.id)?.comments, undefined);
  });

  test('a comment can be removed by id', () => {
    const issue = addIssue({ title: 'x' });
    const comment = addIssueComment(issue.id, { body: 'oops' });
    assert.ok(comment);
    assert.equal(deleteIssueComment(issue.id, comment.id), true);
    assert.equal(findIssueById(issue.id)?.comments?.length, 0);
  });

  test('activity is capped, dropping the oldest first', () => {
    const issue = addIssue({ title: 'x' });
    for (let i = 0; i < ISSUE_ACTIVITY_CAP + 10; i += 1) {
      appendIssueActivity(issue.id, { kind: `k${i}` });
    }
    const activity = findIssueById(issue.id)?.activity ?? [];
    assert.equal(activity.length, ISSUE_ACTIVITY_CAP);
    assert.equal(activity[0].kind, 'k10');
    assert.equal(activity.at(-1)?.kind, `k${ISSUE_ACTIVITY_CAP + 9}`);
  });
});

describe('board → agent phase', () => {
  test('any failure wins over any progress', () => {
    assert.equal(
      phaseForBoardTasks([task({ status: 'in_progress' }), task({ id: 't2', status: 'failed' })]),
      'failed',
    );
    assert.equal(phaseForBoardTasks([task({ status: 'quarantined' })]), 'failed');
  });

  test('all complete means ready for review', () => {
    assert.equal(
      phaseForBoardTasks([task({ status: 'complete' }), task({ id: 't2', status: 'complete' })]),
      'review',
    );
  });

  test('anything in flight is running', () => {
    for (const status of ['in_progress', 'testing', 'merging'] as const) {
      assert.equal(phaseForBoardTasks([task({ status })]), 'running');
    }
  });

  test('an empty board yields no phase rather than a wrong one', () => {
    assert.equal(phaseForBoardTasks([]), null);
  });

  test('step labels stay in Issues vocabulary, not board vocabulary', () => {
    assert.equal(stepLabelForTask(task({ status: 'in_progress' })), 'Building');
    assert.equal(stepLabelForTask(task({ status: 'testing' })), 'Running tests');
    assert.equal(stepLabelForTask(task({ status: 'merging' })), 'Merging');
    assert.equal(stepLabelForTask(task({ status: 'planned' })), 'Queued');
    assert.equal(stepLabelForTask(task({ status: 'complete' })), undefined);
  });

  test('the first real error is the failure reason', () => {
    assert.equal(
      failureReasonForTasks([task({ status: 'complete' }), task({ id: 't2', error: 'boom' })]),
      'boom',
    );
    assert.equal(failureReasonForTasks([task({ status: 'complete' })]), undefined);
  });
});

describe('dock badge', () => {
  function card(partial: Partial<IssueCard>): IssueCard {
    return { source: 'user', ...partial } as IssueCard;
  }

  test('counts unreviewed triage and agents waiting on you', () => {
    const badge = computeIssuesDockBadge([
      card({ source: 'crash' }),
      card({ source: 'agent' }),
      card({ source: 'github', triagedAt: 1 }),
      card({ agent: { agentId: 'b', phase: 'awaiting_input', startedAt: 0, updatedAt: 0 } }),
    ]);
    assert.equal(badge.triage, 2);
    assert.equal(badge.awaitingInput, 1);
    assert.equal(badge.count, 3);
    assert.equal(badge.urgent, true);
  });

  test('closed issues never hold the badge up', () => {
    const isClosed = (issue: IssueCard): boolean =>
      issue.status === 'done' || issue.status === 'canceled';
    const badge = computeIssuesDockBadge(
      [
        card({ source: 'crash', status: 'done' }),
        card({ source: 'crash', status: 'backlog' }),
        card({
          status: 'canceled',
          agent: { agentId: 'b', phase: 'awaiting_input', startedAt: 0, updatedAt: 0 },
        }),
      ],
      { isClosed },
    );
    assert.equal(badge.triage, 1);
    assert.equal(badge.awaitingInput, 0);
    assert.equal(badge.count, 1);
    assert.equal(badge.urgent, false);
  });

  test('a running agent is deliberately not counted', () => {
    // A badge that never goes down while work is in flight teaches the user to
    // stop reading it.
    const badge = computeIssuesDockBadge([
      card({ agent: { agentId: 'b', phase: 'running', startedAt: 0, updatedAt: 0 } }),
    ]);
    assert.equal(badge.count, 0);
    assert.equal(badge.urgent, false);
  });

  test('badge text is capped and empty at zero', () => {
    assert.equal(issuesDockBadgeText({ count: 0, triage: 0, awaitingInput: 0, urgent: false }), '');
    assert.equal(issuesDockBadgeText({ count: 7, triage: 7, awaitingInput: 0, urgent: false }), '7');
    assert.equal(
      issuesDockBadgeText({ count: 250, triage: 250, awaitingInput: 0, urgent: false }),
      '99+',
    );
  });

  test('the label leads with what is blocking', () => {
    const label = issuesDockBadgeLabel({ count: 3, triage: 2, awaitingInput: 1, urgent: true });
    assert.equal(label, '1 agent waiting on you, 2 issues to triage');
    assert.equal(issuesDockBadgeLabel({ count: 0, triage: 0, awaitingInput: 0, urgent: false }), '');
  });
});

describe('single-task plan', () => {
  test('carries the issue body, its code refs, and the PR-and-stop handoff', () => {
    const issue = addIssue({
      title: 'Fix the parser',
      description: 'It drops the second frame.',
    });
    const withRef = { ...issue, codeRefs: [{ path: 'src/a.ts', startLine: 3, endLine: 9 }] };
    const plan = buildSingleTaskPlan(withRef);

    assert.match(plan, /^---\n/);
    assert.match(plan, /todos:\n {2}- id: t1/);
    assert.ok(plan.includes('It drops the second frame.'));
    assert.ok(plan.includes('`src/a.ts:3-9`'));
    assert.ok(plan.includes('open a pull request with `gh`'));
    assert.ok(plan.includes('Do not'));
  });

  test('quotes a title containing a double quote rather than breaking the YAML', () => {
    const issue = addIssue({ title: 'The "obvious" bug' });
    const plan = buildSingleTaskPlan(issue);
    assert.ok(plan.includes('\\"obvious\\"'));
  });

  test('says so plainly when the issue has no description', () => {
    const issue = addIssue({ title: 'Bare' });
    assert.ok(buildSingleTaskPlan(issue).includes('_No description was written on the issue._'));
  });
});
