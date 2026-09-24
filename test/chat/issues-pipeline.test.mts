/**
 * Issues expand pipeline pure builders.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  buildIssueExpandTask,
  canExpandIssueWithAgent,
} from '../../src/chat/issues/expand-task.ts';
import { resolveIssueSubAgentChatId } from '../../src/chat/issues/pipeline.ts';
import {
  ensureBackgroundChat,
  findBackgroundChat,
} from '../../src/state/background-chat.ts';
import {
  createEmptyChatObject,
  sessionState,
  setSessionStateForTests,
} from '../../src/state/sessions.ts';
import { pruneEphemeralEmptyChats } from '../../src/state/session-workspace-scope.ts';
import type { IssueCard } from '../../src/types.ts';

function makeIssue(overrides: Partial<IssueCard> = {}): IssueCard {
  return {
    id: 'ISS-7',
    type: 'note',
    title: 'login broken somehow',
    description: '',
    status: 'triage',
    priority: 'none',
    labels: [],
    workspacePath: '/workspace',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('issues pipeline builders', () => {
  test('canExpandIssueWithAgent only in triage', () => {
    assert.equal(canExpandIssueWithAgent(makeIssue()), true);
    assert.equal(canExpandIssueWithAgent(makeIssue({ status: 'todo' })), false);
  });

  test('buildIssueExpandTask includes id and triage constraint', () => {
    const task = buildIssueExpandTask(
      makeIssue({ description: 'Null when saving settings' }),
    );
    assert.match(task, /ISS-7/);
    assert.match(task, /Status must remain: triage/);
    assert.match(task, /issue_update/);
    assert.match(task, /issue_link/);
    assert.match(task, /Null when saving settings/);
  });

  test('resolveIssueSubAgentChatId prefers persisted subAgentRuns on linked chats', () => {
    const parent = createEmptyChatObject('model', '/workspace');
    parent.id = 'chat-parent';
    parent.subAgentRuns = [
      {
        runId: 'run-abc',
        type: 'debugger',
        status: 'completed',
        task: 'investigate',
        startedAt: 1,
        finishedAt: 2,
      },
    ];
    setSessionStateForTests({ chats: [parent], activeId: parent.id });

    const issue = makeIssue({
      status: 'in_progress',
      investigateRunId: 'run-abc',
      chatIds: ['other-chat', 'chat-parent'],
    });

    assert.equal(resolveIssueSubAgentChatId(issue, 'run-abc'), 'chat-parent');
    assert.equal(
      resolveIssueSubAgentChatId(makeIssue({ chatIds: ['chat-fallback'] }), 'run-missing'),
      'chat-fallback',
    );
  });
});

describe('background work chats (MIN-637)', () => {
  function seedOpenChat() {
    const open = createEmptyChatObject('model', '/workspace');
    open.id = 'chat-user-open';
    setSessionStateForTests({ version: 2, activeId: open.id, chats: [open] });
    return open;
  }

  test('creates a dedicated chat without taking activeId', () => {
    const open = seedOpenChat();

    const created = ensureBackgroundChat({
      key: 'issue:ISS-7',
      name: 'Investigate: login broken',
      workspacePath: '/workspace',
      modeId: 'build',
    });

    assert.ok(created);
    assert.notEqual(created.id, open.id);
    assert.equal(created.background, true);
    assert.equal(created.backgroundKey, 'issue:ISS-7');
    assert.equal(created.name, 'Investigate: login broken');
    // The regression this helper exists to prevent: focus must not move.
    assert.equal(sessionState?.activeId, open.id);
    assert.equal(open.history.length, 0);
  });

  test('reuses the chat for the same work source', () => {
    seedOpenChat();

    const first = ensureBackgroundChat({ key: 'schedule:nightly', name: 'A' });
    const second = ensureBackgroundChat({ key: 'schedule:nightly', name: 'B' });

    assert.ok(first);
    assert.equal(second?.id, first.id);
    assert.equal(second?.name, 'A');
    assert.equal(sessionState?.chats.length, 2);
    assert.equal(findBackgroundChat('schedule:nightly')?.id, first.id);
  });

  test('survives ephemeral pruning while still empty', () => {
    const open = seedOpenChat();
    const created = ensureBackgroundChat({ key: 'issue:ISS-9', name: 'Investigate' });
    assert.ok(created);

    // What "New chat" does. A background chat is empty until its agent reports,
    // so pruning it would delete the run's only home.
    pruneEphemeralEmptyChats(sessionState!, open.id);

    assert.equal(findBackgroundChat('issue:ISS-9')?.id, created.id);
  });

  test('keeps separate chats per work source', () => {
    seedOpenChat();

    const issueChat = ensureBackgroundChat({ key: 'issue:ISS-1', name: 'Issue' });
    const reviewChat = ensureBackgroundChat({ key: 'review:pr-42', name: 'Review' });

    assert.ok(issueChat);
    assert.ok(reviewChat);
    assert.notEqual(issueChat.id, reviewChat.id);
    assert.equal(findBackgroundChat('nope'), null);
  });
});
