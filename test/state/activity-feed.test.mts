import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildActivityFeed, getRunningAgentCount, type ActivityFeedInput } from '../../src/state/activity-feed.ts';
import type { AgentActivityRow } from '../../src/state/agent-activity-registry.ts';
import type { NotificationRecord } from '../../src/notifications/types.ts';
import type { Chat } from '../../src/types.ts';

const chat = { id: 'chat-a', name: 'Fix reconnect', workspacePath: '/work/minnow', runs: [{ runId: 'run-a', status: 'running' }] } as Chat;
const live: AgentActivityRow = { id: 'main:chat-a', kind: 'main_turn', chatId: chat.id, chatTitle: chat.name!, label: 'Build', status: 'tools', modelDisplay: 'Local model', currentTool: 'run_tests', contextPercent: 34, contextIsEstimate: false, startedAtMs: 100, elapsedMs: 100, elapsedFrozen: false };
const notice = (patch: Partial<NotificationRecord> = {}): NotificationRecord => ({ id: 'n1', kind: 'chat_turn_complete', title: chat.name!, preview: 'Finished', appId: 'code', chatId: chat.id, activityId: 'turn:run-a', workspacePath: chat.workspacePath, createdAt: 300, read: false, ...patch });
const build = (patch: Partial<ActivityFeedInput> = {}) => buildActivityFeed({ chats: [chat], live: [], notifications: [], pendingChatIds: new Set(), workspacePath: chat.workspacePath!, ...patch });

test('one parent work item counts once with two nested agents', () => {
  const child = { ...live, kind: 'sub_agent', id: 'sub:one', runId: 'one' } as AgentActivityRow;
  const feed = build({ live: [live, child, { ...child, id: 'sub:two', runId: 'two' }] });
  assert.equal(feed.runningCount, 1);
  assert.equal(feed.running[0].id, 'turn:run-a');
  assert.equal(feed.running[0].children.length, 2);
  assert.equal(getRunningAgentCount(feed), 3);
});

test('pending questions and approvals are one item regardless of seen notifications', () => {
  const feed = build({ live: [live], pendingChatIds: new Set([chat.id]), notifications: [notice({ kind: 'chat_question', read: true }), notice({ id: 'issue-question', kind: 'issue_agent_question', read: true })] });
  assert.equal(feed.attention.length, 1);
  assert.equal(feed.runningCount, 0);
  assert.equal(feed.recent.length, 0);
});

test('answering moves work back to Running and removes stale question alerts', () => {
  const feed = build({ live: [live], notifications: [notice({ kind: 'chat_question' })] });
  assert.equal(feed.attention.length, 0);
  assert.equal(feed.runningCount, 1);
  assert.equal(build({ notifications: [notice({ kind: 'chat_question' })] }).recent.length, 0);
});

test('approval without a main-turn row remains actionable without a notification', () => {
  const feed = build({ pendingChatIds: new Set([chat.id]) });
  assert.equal(feed.attention.length, 1);
  assert.equal(feed.attention[0].id, 'turn:run-a');
});

test('timer and capacity waits stay Running', () => {
  const feed = build({ live: [{ ...live, status: 'waiting', waitReason: 'model capacity' }] });
  assert.equal(feed.attention.length, 0);
  assert.match(feed.running[0].detail, /model capacity/);
});

test('running-to-completed handoff preserves identity and one row', () => {
  const ending = notice();
  assert.equal(build({ live: [live], notifications: [ending] }).running.length, 1);
  const feed = build({ notifications: [ending] });
  assert.equal(feed.runningCount, 0);
  assert.equal(feed.recent[0].id, 'turn:run-a');
  assert.equal(feed.unreadCount, 1);
});

test('seen failures still need action; explicit dismissal keeps their outcome in Recent', () => {
  const failed = notice({ kind: 'chat_turn_error', read: true });
  assert.equal(build({ notifications: [failed] }).attention.length, 1);
  const dismissed = build({ notifications: [{ ...failed, resolved: true }] });
  assert.equal(dismissed.attention.length, 0);
  assert.equal(dismissed.recent[0].status, 'failed');
});

test('a successful later reply clears older chat errors without deleting history', () => {
  const failed = notice({ kind: 'chat_turn_error', activityId: 'turn:old', createdAt: 100 });
  const feed = build({ notifications: [notice(), failed] });
  assert.equal(feed.attention.length, 0);
  assert.equal(feed.recent.length, 2);
  assert.equal(feed.recent.find((item) => item.id === 'turn:old')?.resolved, true);
  assert.equal(failed.resolved, undefined, 'projection must not mutate stored notifications');
});

test('recovery keeps newer failures, other chats, tasks, reviews and questions', () => {
  const alerts = [
    notice({ id: 'new', activityId: 'new', kind: 'chat_turn_error', createdAt: 400 }),
    notice({ id: 'other', activityId: 'other', kind: 'chat_turn_error', chatId: 'other', createdAt: 100 }),
    notice({ id: 'task', activityId: 'task', kind: 'task_failed', createdAt: 100 }),
    notice({ id: 'review', activityId: 'review', kind: 'issue_agent_pr', createdAt: 100 }),
    notice({ id: 'question', activityId: 'question', kind: 'chat_question', createdAt: 100 }),
  ];
  const feed = build({ notifications: [notice(), ...alerts], pendingChatIds: new Set([chat.id]) });
  assert.equal(feed.attention.length, 5);
});

test('stopped replies and starts do not count as chat recovery', () => {
  const failed = notice({ kind: 'chat_turn_error', activityId: 'old', createdAt: 100 });
  for (const outcome of [notice({ activityStatus: 'stopped' }), notice({ kind: 'issue_agent_started' })]) {
    assert.equal(build({ notifications: [failed, outcome] }).attention.length, 1);
  }
});

test('completed parent absorbs terminal child events regardless of arrival order', () => {
  const child = notice({ id: 'child', kind: 'sub_agent_failed', activityId: 'sub:one', parentActivityId: 'turn:run-a', createdAt: 200 });
  const feed = build({ notifications: [notice(), child] });
  assert.equal(feed.attention.length, 0);
  assert.equal(feed.recent.length, 1);
  assert.equal(feed.recent[0].status, 'completed');
  assert.equal(feed.recent[0].notifications.length, 2);
});

test('a late child from another run never attaches to the new live turn', () => {
  const feed = build({ live: [live], notifications: [notice({ kind: 'sub_agent_failed', activityId: 'sub:old', parentActivityId: 'turn:old' })] });
  assert.equal(feed.attention.length, 1);
  assert.equal(feed.running[0].notifications.length, 0);
});

test('workspace scoping includes every section and normalizes paths', () => {
  const other = { ...chat, id: 'other', workspacePath: '/other' };
  const feed = build({ chats: [chat, other], live: [live, { ...live, id: 'main:other', chatId: 'other' }], notifications: [notice({ id: 'outside', workspacePath: '/other', activityId: 'outside' })], pendingChatIds: new Set(['other']), workspacePath: '/work/minnow/' });
  assert.equal(feed.runningCount, 1);
  assert.equal(feed.attention.length, 0);
  assert.equal(feed.recent.length, 0);
});

test('title jobs are collapsed background work and stopped outcomes stay in history', () => {
  const feed = build({ live: [{ ...live, id: 'title:chat-a', kind: 'title_job' }], notifications: [notice({ activityStatus: 'stopped', read: true })] });
  assert.equal(feed.background.length, 1);
  assert.equal(feed.running.length, 0);
  assert.equal(feed.runningCount, 1);
  assert.equal(feed.recent[0].status, 'stopped');
  assert.equal(getRunningAgentCount(feed), 0);
});

test('agent indicator excludes parked and queued agents and counts orphan workers once', () => {
  const child = { ...live, kind: 'sub_agent', id: 'sub:one', runId: 'one' } as AgentActivityRow;
  assert.equal(getRunningAgentCount(build({ live: [child] })), 1);
  assert.equal(getRunningAgentCount(build({ live: [{ ...live, status: 'waiting' }, { ...child, status: 'queued' }] })), 0);
});

test('scheduler start and outcome share a row while successive runs stay separate', () => {
  const started = notice({ id: 'start', activityId: 'scheduler:run-1', activityStatus: 'running', createdAt: 100, read: true });
  const ended = notice({ id: 'end', activityId: started.activityId, activityStatus: 'failed', createdAt: 200 });
  assert.equal(build({ notifications: [started] }).runningCount, 1);
  const feed = build({ notifications: [started, ended, notice({ activityId: 'scheduler:run-2' })] });
  assert.equal(feed.runningCount, 0);
  assert.equal(feed.attention.length, 1);
  assert.equal(feed.recent.length, 1);
});
