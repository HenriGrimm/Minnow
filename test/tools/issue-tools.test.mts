/**
 * issue_* tools + bug_* aliases (no screen gate).
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import { setSessionStateForTests } from '../../src/state/sessions.ts';
import { setIssuesStateForTests, findIssueById } from '../../src/state/issues-store.ts';
import {
  executeIssueTool,
  validateIssueAddArgs,
  validateIssueDeleteArgs,
  validateIssueLinkArgs,
  validateIssueUpdateArgs,
} from '../../src/tools/issue-tools.ts';
import {
  executeBugBoardTool,
  setGlobalBugsPageOpenForTests,
  validateBugAddArgs,
} from '../../src/tools/bug-board-tools.ts';
import type { Chat } from '../../src/types.ts';

const CHAT_ID = '33333333-3333-3333-3333-333333333333';

function makeChat(): Chat {
  return {
    id: CHAT_ID,
    name: 'Debug',
    workspacePath: '/workspace',
    modelId: 'test',
    modeId: 'build',
    history: [],
    lastStats: null,
    modelInfo: {},
    updatedAt: 1,
  };
}

describe('issue-tools', () => {
  beforeEach(() => {
    setIssuesStateForTests({ version: 2, nextId: 1, issues: [], workspaces: {} });
    setSessionStateForTests({
      version: 2,
      activeId: CHAT_ID,
      sidebarCollapsed: false,
      chats: [makeChat()],
    });
    setGlobalBugsPageOpenForTests(false);
  });

  test('validateIssueAddArgs rejects empty title', () => {
    const r = validateIssueAddArgs({ title: '  ' });
    assert.equal(r.ok, false);
  });

  test('issue_get_state projects and pages instead of dumping the store', async () => {
    for (let i = 1; i <= 30; i += 1) {
      await executeIssueTool('issue_add', {
        title: `Issue ${i}`,
        description: 'x'.repeat(2_000),
        issue_id: `ISS-${i}`,
      });
    }

    const first = JSON.parse(
      await executeIssueTool('issue_get_state', { workspace_scope: 'all' }),
    ) as {
      total: number;
      limit: number;
      hasMore: boolean;
      issues: Record<string, unknown>[];
    };
    assert.equal(first.total, 30);
    assert.equal(first.limit, 25);
    assert.equal(first.hasMore, true);
    assert.equal(first.issues.length, 25);
    // The description is the bulk of a card and is not in the default projection.
    assert.equal('description' in first.issues[0], false);
    assert.equal(typeof first.issues[0].title, 'string');

    const second = JSON.parse(
      await executeIssueTool('issue_get_state', { workspace_scope: 'all', offset: 25 }),
    ) as { hasMore: boolean; issues: Record<string, unknown>[] };
    assert.equal(second.issues.length, 5);
    assert.equal(second.hasMore, false);

    const withBody = JSON.parse(
      await executeIssueTool('issue_get_state', {
        workspace_scope: 'all',
        fields: ['id', 'description'],
        limit: 1,
      }),
    ) as { issues: Record<string, unknown>[] };
    assert.equal(typeof withBody.issues[0].description, 'string');
  });

  test('issue_get_state rejects an unknown field instead of ignoring it', async () => {
    const out = await executeIssueTool('issue_get_state', { fields: ['nope'] });
    assert.match(out, /unknown fields: nope/);
  });

  test('issue_get_state clamps an absurd limit', async () => {
    for (let i = 1; i <= 3; i += 1) {
      await executeIssueTool('issue_add', { title: `Issue ${i}`, issue_id: `ISS-${i}` });
    }
    const parsed = JSON.parse(
      await executeIssueTool('issue_get_state', { workspace_scope: 'all', limit: 100_000 }),
    ) as { limit: number };
    assert.equal(parsed.limit, 100);
  });

  test('issue_add and issue_get_state round trip', async () => {
    const addResult = await executeIssueTool('issue_add', {
      title: 'Ship Issues app',
      description: 'Phase 1',
      type: 'task',
      priority: 'high',
      issue_id: 'ISS-42',
    });
    assert.match(addResult, /"id": "ISS-42"/);
    assert.match(addResult, /"status": "backlog"/);
    assert.match(addResult, /"source": "agent"/);

    const state = await executeIssueTool('issue_get_state', {
      workspace_scope: 'all',
    });
    assert.match(state, /ISS-42/);

    const validated = validateIssueUpdateArgs({
      issue_id: 'ISS-42',
      status: 'planned',
      plan_path: 'documentation/plans/issues/ISS-42.md',
    });
    assert.equal(validated.ok, true);
    const updateResult = await executeIssueTool('issue_update', {
      issue_id: 'ISS-42',
      status: 'planned',
      plan_path: 'documentation/plans/issues/ISS-42.md',
    });
    assert.match(updateResult, /"status": "planned"/);
  });

  test('issue_link appends code refs and chat id', async () => {
    await executeIssueTool('issue_add', {
      title: 'Link me',
      issue_id: 'ISS-9',
    });
    const bad = validateIssueLinkArgs({ issue_id: 'ISS-9' });
    assert.equal(bad.ok, false);

    const ok = validateIssueLinkArgs({
      issue_id: 'ISS-9',
      code_refs: [{ path: 'src/a.ts', start_line: 2, end_line: 5, snippet: 'x' }],
      chat_id: CHAT_ID,
    });
    assert.equal(ok.ok, true);

    const linked = await executeIssueTool('issue_link', {
      issue_id: 'ISS-9',
      code_refs: [{ path: 'src/a.ts', start_line: 2, end_line: 5, snippet: 'x' }],
      chat_id: CHAT_ID,
    });
    assert.match(linked, /"path": "src\/a\.ts"/);
    assert.match(linked, new RegExp(CHAT_ID));

    // Append-only: duplicate path/range does not grow the list.
    const again = await executeIssueTool('issue_link', {
      issue_id: 'ISS-9',
      code_refs: [{ path: 'src/a.ts', start_line: 2, end_line: 5 }],
    });
    const parsed = JSON.parse(again) as { codeRefs?: unknown[] };
    assert.equal(parsed.codeRefs?.length, 1);
  });

  test('issue_link validates and appends issue_refs bidirectionally', async () => {
    await executeIssueTool('issue_add', { title: 'Prior grid bug', issue_id: 'ISS-1' });
    await executeIssueTool('issue_add', { title: 'Grid header overlaps', issue_id: 'ISS-2' });

    const badKind = validateIssueLinkArgs({
      issue_id: 'ISS-2',
      issue_refs: [{ issue_id: 'ISS-1', kind: 'depends-on' }],
    });
    assert.equal(badKind.ok, false);

    const emptyRefs = validateIssueLinkArgs({
      issue_id: 'ISS-2',
      issue_refs: [],
    });
    assert.equal(emptyRefs.ok, false);

    const stringRef = validateIssueLinkArgs({
      issue_id: 'ISS-2',
      issue_refs: ['ISS-1'],
    });
    assert.equal(stringRef.ok, true);

    const linked = await executeIssueTool('issue_link', {
      issue_id: 'ISS-2',
      issue_refs: [{ issue_id: 'ISS-1', kind: 'blocks' }],
    });
    assert.match(linked, /"kind": "blocks"/);
    assert.match(linked, /"issueId": "ISS-1"/);

    const iss1 = findIssueById('ISS-1');
    assert.ok(iss1?.issueRefs?.some((ref) => ref.issueId === 'ISS-2' && ref.kind === 'blocked-by'));

    const duplicate = await executeIssueTool('issue_link', {
      issue_id: 'ISS-2',
      issue_refs: [{ issue_id: 'ISS-1', kind: 'blocks' }],
    });
    const parsedDuplicate = JSON.parse(duplicate) as { issueRefs?: unknown[] };
    assert.equal(parsedDuplicate.issueRefs?.length, 1);

    const selfLink = await executeIssueTool('issue_link', {
      issue_id: 'ISS-2',
      issue_refs: [{ issue_id: 'ISS-2', kind: 'related' }],
    });
    assert.match(selfLink, /no valid issue_refs/);

    const unknown = await executeIssueTool('issue_link', {
      issue_id: 'ISS-2',
      issue_refs: [{ issue_id: 'ISS-999', kind: 'related' }],
    });
    assert.match(unknown, /no valid issue_refs/);
  });

  test('issue_delete removes one or many issues', async () => {
    await executeIssueTool('issue_add', { title: 'Keep', issue_id: 'ISS-1' });
    await executeIssueTool('issue_add', { title: 'Drop A', issue_id: 'ISS-2' });
    await executeIssueTool('issue_add', { title: 'Drop B', issue_id: 'ISS-3' });

    const bad = validateIssueDeleteArgs({});
    assert.equal(bad.ok, false);

    const missing = await executeIssueTool('issue_delete', { issue_id: 'ISS-999' });
    assert.match(missing, /unknown issue_id/);

    const single = await executeIssueTool('issue_delete', { issue_id: 'ISS-2' });
    assert.match(single, /"deleted": true/);
    assert.match(single, /"issue_id": "ISS-2"/);

    const bulk = await executeIssueTool('issue_delete', {
      issue_ids: ['ISS-3', 'ISS-missing'],
    });
    assert.match(bulk, /"deleted": 1/);

    const state = await executeIssueTool('issue_get_state', { workspace_scope: 'all' });
    const parsedState = JSON.parse(state) as { issues?: Array<{ id?: string }> };
    const remainingIds = parsedState.issues?.map((row) => row.id) ?? [];
    assert.deepEqual(remainingIds, ['ISS-1']);
  });

  test('bug_* aliases work without All bugs screen', async () => {
    assert.equal(validateBugAddArgs({ title: 'Crash', severity: 'critical' }).ok, true);
    const addResult = await executeBugBoardTool('bug_add', {
      title: 'Crash on save',
      description: 'Null ref',
      severity: 'critical',
      bug_id: 'bug-crash',
    });
    assert.match(addResult, /"id": "bug-crash"/);
    assert.match(addResult, /"column": "reported"/);

    const state = await executeBugBoardTool('bug_get_state', {});
    assert.match(state, /"column": "reported"/);

    const updateResult = await executeBugBoardTool('bug_update', {
      bug_id: 'bug-crash',
      column: 'planned',
      plan_path: 'documentation/plans/bugs/bug-crash.md',
    });
    assert.match(updateResult, /"column": "planned"/);
  });
});
