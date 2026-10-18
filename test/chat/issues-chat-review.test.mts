import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { Window } from 'happy-dom';
import { markIssuesReviewForChatComplete } from '../../src/chat/issues/chat-review.ts';
import { setIssuesStateForTests, findIssueById, collectIssues } from '../../src/state/issues-store.ts';
import { createEmptyChatObject, setSessionStateForTests } from '../../src/state/sessions.ts';
import { disposeChatRunActivity, setChatRunActivity } from '../../src/state/chat-run-activity.ts';
import type { IssueCard } from '../../src/types.ts';

const issue = (extra: Partial<IssueCard> = {}): IssueCard => ({ id: 'MIN-1', title: 'Fix it', description: '', type: 'bug', priority: 'medium', labels: [], workspacePath: '/workspace', createdAt: 1, updatedAt: 1, status: 'in_progress', chatIds: ['build-chat'], ...extra });
function seed(card: IssueCard) { setIssuesStateForTests({ version: 2, nextId: 2, issues: [card], workspaces: {} }); }
beforeEach(() => {
  globalThis.window = new Window() as unknown as typeof window;
  disposeChatRunActivity();
  const chat = createEmptyChatObject('model', '/workspace');
  chat.id = 'build-chat'; chat.modeId = 'build';
  setSessionStateForTests({ chats: [chat], activeId: chat.id });
  seed(issue());
});
afterEach(() => { disposeChatRunActivity(); setIssuesStateForTests(null); });

test('successful implementation work moves to Review and records the handoff', () => {
  assert.deepEqual(markIssuesReviewForChatComplete('build-chat', 'completed'), ['MIN-1']);
  const card = findIssueById('MIN-1')!;
  assert.equal(card.status, 'review');
  assert.equal(card.activity?.at(-1)?.data?.from, 'in_progress');
  assert.equal(card.activity?.at(-1)?.data?.chatId, 'build-chat');
  assert.deepEqual(markIssuesReviewForChatComplete('build-chat', 'completed'), []);
});

test('failed, stopped, and interrupted runs never advance the issue', () => {
  for (const status of ['failed', 'stopped', 'interrupted'] as const) {
    assert.deepEqual(markIssuesReviewForChatComplete('build-chat', status), []);
    assert.equal(findIssueById('MIN-1')!.status, 'in_progress');
  }
});

test('discussion and planning chats do not advance implementation status', () => {
  for (const mode of ['general', 'plan'] as const) {
    const chat = createEmptyChatObject('model', '/workspace');
    chat.id = 'build-chat'; chat.modeId = mode;
    setSessionStateForTests({ chats: [chat], activeId: chat.id });
    assert.deepEqual(markIssuesReviewForChatComplete(chat.id, 'completed'), []);
  }
});

test('closed and manually moved issues keep their status', () => {
  for (const status of ['done', 'canceled', 'todo', 'review'] as const) {
    seed(issue({ status }));
    assert.deepEqual(markIssuesReviewForChatComplete('build-chat', 'completed'), []);
    assert.equal(findIssueById('MIN-1')!.status, status);
  }
});

test('another running linked chat and pending agent input block the handoff', () => {
  seed(issue({ chatIds: ['build-chat', 'other'] }));
  setChatRunActivity('other', 'running');
  assert.deepEqual(markIssuesReviewForChatComplete('build-chat', 'completed'), []);
  seed(issue({ agent: { agentId: 'builder', phase: 'awaiting_input', startedAt: 1, updatedAt: 1 } }));
  assert.deepEqual(markIssuesReviewForChatComplete('build-chat', 'completed'), []);
});

test('Agent work includes linked chats without an assigned board agent', () => {
  assert.equal(collectIssues({ hasAgent: true }).some((entry) => entry.id === 'MIN-1'), true);
  seed(issue({ chatIds: [] }));
  assert.equal(collectIssues({ hasAgent: true }).length, 0);
});
