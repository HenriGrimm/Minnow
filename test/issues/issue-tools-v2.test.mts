/**
 * The Phase 4 agent tools.
 *
 * Each of these exists because one of the original five made an agent do
 * something lossy, so the tests are written against that: paging instead of
 * dumping, appending instead of clobbering, and removing a link that
 * `issue_link` could only add.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import {
  addIssue,
  appendIssueLinks,
  findIssueById,
  setIssuesStateForTests,
  updateIssue,
} from '../../src/state/issues-store.ts';
import {
  executeIssueV2Tool,
  isIssueV2Tool,
} from '../../src/tools/issue-tools-v2.ts';

function parse(text: string): Record<string, unknown> {
  assert.ok(!text.startsWith('Error:'), text);
  return JSON.parse(text) as Record<string, unknown>;
}

beforeEach(() => {
  setIssuesStateForTests({ version: 2, schemaRevision: 3, nextId: 1, issues: [] });
});

afterEach(() => {
  setIssuesStateForTests(null);
});

describe('tool routing', () => {
  test('recognizes exactly the five new names', () => {
    for (const name of ['issue_search', 'issue_comment', 'issue_assign', 'issue_unlink', 'issue_move']) {
      assert.equal(isIssueV2Tool(name), true, name);
    }
    assert.equal(isIssueV2Tool('issue_add'), false);
    assert.equal(isIssueV2Tool('nonsense'), false);
  });
});

describe('issue_search', () => {
  beforeEach(() => {
    addIssue({ title: 'Parser drops a frame', description: 'stack trace here', labels: ['bug'] });
    addIssue({ title: 'Add dark mode', labels: ['ui'] });
    addIssue({ title: 'Parser is slow' });
  });

  test('returns a compact default projection, not whole records', async () => {
    const out = parse(await executeIssueV2Tool('issue_search', {}));
    assert.equal(out.total, 3);
    const first = (out.issues as Record<string, unknown>[])[0];
    assert.deepEqual(Object.keys(first).sort(), [
      'id',
      'priority',
      'status',
      'title',
      'type',
      'updatedAt',
    ]);
    assert.ok(!('description' in first));
  });

  test('matches id, title, description, and labels', async () => {
    assert.equal(parse(await executeIssueV2Tool('issue_search', { query: 'parser' })).total, 2);
    assert.equal(parse(await executeIssueV2Tool('issue_search', { query: 'stack trace' })).total, 1);
    assert.equal(parse(await executeIssueV2Tool('issue_search', { query: 'ui' })).total, 1);
  });

  test('pages, and says whether there is more', async () => {
    const page = parse(await executeIssueV2Tool('issue_search', { limit: 2, offset: 0 }));
    assert.equal((page.issues as unknown[]).length, 2);
    assert.equal(page.hasMore, true);

    const last = parse(await executeIssueV2Tool('issue_search', { limit: 2, offset: 2 }));
    assert.equal((last.issues as unknown[]).length, 1);
    assert.equal(last.hasMore, false);
  });

  test('clamps an absurd limit rather than dumping everything', async () => {
    assert.equal(parse(await executeIssueV2Tool('issue_search', { limit: 100000 })).limit, 100);
    assert.equal(parse(await executeIssueV2Tool('issue_search', { limit: 0 })).limit, 1);
  });

  test('rejects an unknown field instead of silently ignoring it', async () => {
    const out = await executeIssueV2Tool('issue_search', { fields: ['id', 'secrets'] });
    assert.match(out, /^Error: unknown fields: secrets/);
  });

  test('asking for attachments returns their on-disk paths', async () => {
    const issue = addIssue({ title: 'With a screenshot' });
    const stored = findIssueById(issue.id);
    if (stored) {
      stored.attachments = [
        { id: 'a1', name: 'shot.png', path: '/home/u/.minnow/issues/attachments/x/shot.png', addedAt: 1 },
      ];
    }
    const out = parse(
      await executeIssueV2Tool('issue_search', { query: 'screenshot', fields: ['id', 'attachments'] }),
    );
    const row = (out.issues as Record<string, unknown>[])[0];
    const attachments = row.attachments as Array<Record<string, unknown>>;
    assert.equal(attachments[0].path, '/home/u/.minnow/issues/attachments/x/shot.png');
  });
});

describe('issue_search closed issues', () => {
  beforeEach(() => {
    addIssue({ title: 'Open parser bug' });
    const closed = addIssue({ title: 'Closed parser bug' });
    updateIssue(closed.id, { status: 'done' });
    const canceled = addIssue({ title: 'Canceled parser bug' });
    updateIssue(canceled.id, { status: 'canceled' });
  });

  test('omits closed issues by default so a store of done work stays out of context', async () => {
    const out = parse(await executeIssueV2Tool('issue_search', { query: 'parser' }));
    assert.equal(out.total, 1);
    assert.deepEqual(
      (out.issues as Record<string, unknown>[]).map((row) => row.title),
      ['Open parser bug'],
    );
  });

  test('include_done returns them', async () => {
    const out = parse(
      await executeIssueV2Tool('issue_search', { query: 'parser', include_done: true }),
    );
    assert.equal(out.total, 3);
  });

  test('hide_done: false still means "give me everything"', async () => {
    const out = parse(
      await executeIssueV2Tool('issue_search', { query: 'parser', hide_done: false }),
    );
    assert.equal(out.total, 3);
  });

  test('asking for a closed status returns that status, not an empty page', async () => {
    const out = parse(await executeIssueV2Tool('issue_search', { status: 'done' }));
    assert.equal(out.total, 1);
    assert.equal((out.issues as Record<string, unknown>[])[0].title, 'Closed parser bug');
  });

  test('an open status filter is unaffected', async () => {
    const out = parse(await executeIssueV2Tool('issue_search', { status: 'backlog' }));
    assert.equal(out.total, 1);
    assert.equal((out.issues as Record<string, unknown>[])[0].title, 'Open parser bug');
  });
});

describe('issue_comment', () => {
  test('appends to the timeline', async () => {
    const issue = addIssue({ title: 'x' });
    await executeIssueV2Tool('issue_comment', { issue_id: issue.id, body: 'found it' });
    await executeIssueV2Tool('issue_comment', { issue_id: issue.id, body: 'fixed it' });
    assert.deepEqual(
      (findIssueById(issue.id)?.comments ?? []).map((c) => c.body),
      ['found it', 'fixed it'],
    );
  });

  test('never clobbers notes, which is what it exists to replace', async () => {
    const issue = addIssue({ title: 'x' });
    updateIssue(issue.id, { notes: 'user note' });
    await executeIssueV2Tool('issue_comment', { issue_id: issue.id, body: 'agent note' });
    assert.equal(findIssueById(issue.id)?.notes, 'user note');
  });

  test('requires an id and a body', async () => {
    assert.match(await executeIssueV2Tool('issue_comment', { body: 'x' }), /requires "issue_id"/);
    assert.match(
      await executeIssueV2Tool('issue_comment', { issue_id: 'X-1', body: '  ' }),
      /non-empty "body"/,
    );
  });

  test('reports an unknown issue', async () => {
    assert.match(
      await executeIssueV2Tool('issue_comment', { issue_id: 'NOPE-9', body: 'x' }),
      /unknown issue_id/,
    );
  });
});

describe('issue_assign', () => {
  test('sets the human without touching the agent slot', async () => {
    const issue = addIssue({ title: 'x' });
    await executeIssueV2Tool('issue_assign', { issue_id: issue.id, assignee: 'me' });
    const stored = findIssueById(issue.id);
    assert.equal(stored?.assignee?.id, 'me');
    assert.equal(stored?.agent, undefined);
  });

  test('queues an agent rather than starting a run', async () => {
    // Spinning a worktree is a side effect a tool call must not have; the UI
    // dispatch path owns that.
    const issue = addIssue({ title: 'x' });
    await executeIssueV2Tool('issue_assign', { issue_id: issue.id, agent: 'builder' });
    assert.equal(findIssueById(issue.id)?.agent?.phase, 'queued');
  });

  test('clears the agent slot', async () => {
    const issue = addIssue({ title: 'x' });
    await executeIssueV2Tool('issue_assign', { issue_id: issue.id, agent: 'builder' });
    await executeIssueV2Tool('issue_assign', { issue_id: issue.id, clear_agent: true });
    assert.equal(findIssueById(issue.id)?.agent, undefined);
  });

  test('needs something to do', async () => {
    const issue = addIssue({ title: 'x' });
    assert.match(
      await executeIssueV2Tool('issue_assign', { issue_id: issue.id }),
      /requires "assignee", "agent", or clear_agent/,
    );
  });
});

describe('issue_unlink', () => {
  test('removes a code ref by path', async () => {
    const issue = addIssue({ title: 'x' });
    appendIssueLinks(issue.id, { codeRefs: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }] });
    const out = parse(await executeIssueV2Tool('issue_unlink', { issue_id: issue.id, path: 'src/a.ts' }));
    assert.equal(out.removed, 1);
    assert.deepEqual(findIssueById(issue.id)?.codeRefs?.map((r) => r.path), ['src/b.ts']);
  });

  test('removes a git link by ref', async () => {
    const issue = addIssue({ title: 'x' });
    appendIssueLinks(issue.id, { gitLinks: [{ kind: 'commit', ref: 'abc123' }] });
    await executeIssueV2Tool('issue_unlink', { issue_id: issue.id, ref: 'abc123' });
    assert.equal(findIssueById(issue.id)?.gitLinks?.length, 0);
  });

  test('removes an issue relation in both directions', async () => {
    const a = addIssue({ title: 'a' });
    const b = addIssue({ title: 'b' });
    appendIssueLinks(a.id, { issueRefs: [{ issueId: b.id, kind: 'related', addedAt: 1 }] });
    assert.equal(findIssueById(b.id)?.issueRefs?.length, 1);

    await executeIssueV2Tool('issue_unlink', { issue_id: a.id, target_issue_id: b.id });
    assert.equal(findIssueById(a.id)?.issueRefs?.length, 0);
    assert.equal(findIssueById(b.id)?.issueRefs?.length, 0);
  });

  test('needs to be told what to remove', async () => {
    const issue = addIssue({ title: 'x' });
    assert.match(
      await executeIssueV2Tool('issue_unlink', { issue_id: issue.id }),
      /requires one of/,
    );
  });
});

describe('issue_move', () => {
  test('sets status and a rank in one call', async () => {
    const issue = addIssue({ title: 'x' });
    const out = parse(await executeIssueV2Tool('issue_move', { issue_id: issue.id, status: 'todo' }));
    assert.equal(out.status, 'todo');
    assert.equal(findIssueById(issue.id)?.status, 'todo');
  });

  test('to_top ranks above the existing occupants', async () => {
    const first = addIssue({ title: 'first', status: 'todo' });
    updateIssue(first.id, { rank: 'm' });
    const mover = addIssue({ title: 'mover' });

    await executeIssueV2Tool('issue_move', { issue_id: mover.id, status: 'todo', to_top: true });
    const rank = findIssueById(mover.id)?.rank ?? '';
    assert.ok(rank < 'm', `${rank} should sort above m`);
  });

  test('before/after place relative to named neighbours', async () => {
    const a = addIssue({ title: 'a', status: 'todo' });
    const b = addIssue({ title: 'b', status: 'todo' });
    updateIssue(a.id, { rank: 'a' });
    updateIssue(b.id, { rank: 'z' });
    const mover = addIssue({ title: 'mover' });

    await executeIssueV2Tool('issue_move', {
      issue_id: mover.id,
      status: 'todo',
      after_issue_id: a.id,
      before_issue_id: b.id,
    });
    const rank = findIssueById(mover.id)?.rank ?? '';
    assert.ok(rank > 'a' && rank < 'z', `${rank} should sort between a and z`);
  });

  test('rejects an unknown status instead of writing it', async () => {
    const issue = addIssue({ title: 'x' });
    assert.match(
      await executeIssueV2Tool('issue_move', { issue_id: issue.id, status: 'nonsense' }),
      /unknown status/,
    );
    assert.notEqual(findIssueById(issue.id)?.status, 'nonsense');
  });

  test('records the move on the activity timeline', async () => {
    const issue = addIssue({ title: 'x' });
    await executeIssueV2Tool('issue_move', { issue_id: issue.id, status: 'todo' });
    assert.equal(findIssueById(issue.id)?.activity?.at(-1)?.kind, 'moved');
  });
});
