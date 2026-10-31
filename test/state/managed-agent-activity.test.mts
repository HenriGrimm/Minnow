import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Chat } from '../../src/types.ts';
import type { SubAgentRun } from '../../src/agents/types.ts';
import type { NotificationRecord } from '../../src/notifications/types.ts';
import { buildAgentActivitySnapshot, countRunningAgentRows, formatAgentActivityStatusLine } from '../../src/state/agent-activity-registry.ts';
import { buildActivityFeed, getRunningAgentCount } from '../../src/state/activity-feed.ts';

function child(): Chat { return { id: 'child', name: 'Persistent reviewer', workspacePath: '/project', modelId: 'next-message-model', providerId: 'next-provider', history: [],
  lastStats: null, modelInfo: {}, chatCommandVersion: 1, agentTypeId: 'reviewer',
  agentConversation: { version: 1, childChatId: 'child', parentChatId: 'parent', rootChatId: 'parent', journalOwnerId: 'parent', origin: 'delegated', createdAt: 10,
    capabilities: { canSend: true, canChooseModel: true, canStop: true } },
  agentExecution: { executionId: 'execution-a', commandId: 'command-a', runId: 'task-a', status: 'running', createdAt: 100, updatedAt: 300,
    modelSelection: { providerId: 'minnow-router', modelId: 'review-pool', options: { reasoningEffort: 'high' } },
    resolvedModel: { providerId: 'actual-provider', modelId: 'actual-model' }, contextUsage: { used: 512, limit: 2048, isEstimate: false } },
  agentActivityCursor: { messageSeq: 8, executionId: 'execution-a' } }; }
const snapshot = (chat: Chat, extra = {}) => buildAgentActivitySnapshot({ nowMs: 1000, chats: [chat], mainTurns: [], subAgents: [], titleJobs: [], ...extra });
const feed = (chat: Chat, notifications: NotificationRecord[] = []) => buildActivityFeed({ chats: [chat], live: snapshot(chat), notifications, pendingChatIds: new Set(), workspacePath: '/project' });

test('one canonical execution replaces renderer main and subtask mirrors and displays its actual pool member', () => {
  const chat = child(); chat.currentGenerationId = 'stale';
  const rows = snapshot(chat, { mainTurns: [{ chatId: chat.id, phase: 'generating', startedAtMs: 1, modelId: 'wrong', workAgentLabel: 'wrong' }],
    subAgents: [{ childChatId: chat.id, executionId: 'execution-a', runId: 'task-a', parentChatId: 'parent', status: 'running' } as SubAgentRun] });
  assert.equal(rows.length, 1); assert.equal(rows[0].id, 'execution:execution-a'); assert.equal(rows[0].chatId, 'child');
  assert.equal(rows[0].providerId, 'actual-provider'); assert.equal(rows[0].modelId, 'actual-model');
  assert.equal(rows[0].modelDisplay, 'Pool review-pool → Actual model'); assert.equal(rows[0].contextPercent, 25);
  assert.equal(rows[0].startedAtMs, 100); assert.equal(rows[0].elapsedMs, 900);
  assert.equal(countRunningAgentRows(rows), 1); assert.equal(getRunningAgentCount(feed(chat)), 1);
  assert.equal(JSON.stringify(rows).includes('next-message-model'), false);
});

test('queued, stopping and every wait state is visible without a generation count or ticking clock', () => {
  for (const [state, expected] of [['queued', 'Queued'], ['waiting_for_host', 'Waiting for execution host'], ['waiting_for_model', 'Waiting for model'],
    ['waiting_for_agents', 'Waiting for agents'], ['waiting', 'Waiting'], ['waiting_for_input', 'Pending question'], ['waiting_for_approval', 'Needs approval'], ['stopping', 'Stopping']]) {
    const chat = child(); chat.agentExecution!.status = state;
    const rows = snapshot(chat); assert.equal(rows.length, 1, state);
    assert.equal(formatAgentActivityStatusLine(rows[0]), expected, state);
    assert.equal(rows[0].elapsedFrozen, true, state); assert.equal(rows[0].elapsedMs, 200, state);
    assert.equal(countRunningAgentRows(rows), 0, state); assert.equal(getRunningAgentCount(feed(chat)), 0, state);
  }
});

test('request summaries point to the exact child request and keep approval distinct from generation', () => {
  const chat = child(); chat.agentRequestSummary = [{ requestId: 'approval-a', kind: 'approval' }, { requestId: 'question-b', kind: 'question' }];
  const current = feed(chat); assert.equal(current.attention.length, 1); assert.equal(current.attention[0].status, 'question');
  assert.equal(current.attention[0].detail, 'Needs approval'); assert.equal(current.attention[0].requestId, 'approval-a');
  assert.deepEqual(current.attention[0].live!.requestIds, ['approval-a', 'question-b']); assert.equal(getRunningAgentCount(current), 0);
});

test('a queued new command and an unread finished execution have separate stable identities without borrowing its model', () => {
  const chat = child(); chat.agentExecution!.status = 'completed'; chat.agentExecution!.settledAt = 400; chat.unread = true;
  chat.agentPendingCommand = { commandId: 'queued-b', runId: 'task-b', state: 'queued', held: true };
  const rows = snapshot(chat); assert.deepEqual(rows.map(row => row.id), ['execution:execution-a', 'command:queued-b']);
  assert.equal(rows[1].modelDisplay, 'Model saved with message'); assert.equal(rows[1].modelId, undefined); assert.equal(rows[1].canStop, false);
  assert.equal(formatAgentActivityStatusLine(rows[1]), 'Queued · on hold');
  const current = feed(chat); assert.equal(current.recent.length, 1); assert.equal(current.running.length, 1); assert.equal(getRunningAgentCount(current), 0);
});

test('durable outcome and transition notification merge once, then exact acknowledgment clears its failure attention', () => {
  const chat = child(); chat.agentExecution!.status = 'failed'; chat.unread = chat.turnError = true;
  const notice: NotificationRecord = { id: 'notice', activityId: 'execution:execution-a', kind: 'chat_turn_error', activityStatus: 'failed',
    chatId: chat.id, workspacePath: chat.workspacePath, title: chat.name, preview: 'Reply failed', appId: 'code', createdAt: 300, read: false };
  let current = feed(chat, [notice]); assert.equal(current.attention.length, 1); assert.equal(current.attention[0].notifications.length, 1);
  chat.unread = chat.turnError = false; current = feed(chat, [notice]);
  assert.equal(current.attention.length, 0); assert.equal(current.recent.length, 1); assert.equal(current.recent[0].unread, false);
  assert.equal(notice.read, false, 'projection leaves the stored notification intact');
});

test('inspect-only and explicitly revoked Stop authority never offer an activity Stop action', () => {
  const chat = child(); chat.agentConversation!.origin = 'native'; assert.equal(snapshot(chat)[0].canStop, false);
  chat.agentConversation!.origin = 'delegated'; chat.agentConversation!.capabilities!.canStop = false;
  assert.equal(snapshot(chat)[0].canStop, false);
});

test('a parent dispatch turn waiting on children stays visible without claiming generation or a live turn Stop', () => {
  const chat = child(); chat.agentExecution!.status = 'completed'; chat.agentTaskAttention = { status: 'waiting_for_agents', pendingCount: 2 };
  const rows = snapshot(chat); assert.equal(rows.length, 1); assert.equal(rows[0].status, 'waiting');
  assert.equal(formatAgentActivityStatusLine(rows[0]), 'Waiting for agents'); assert.equal(rows[0].canStop, false);
  assert.equal(rows[0].elapsedFrozen, true); assert.equal(countRunningAgentRows(rows), 0);
});

test('raw durable approvals preserve legacy ownership but carry their exact request navigation identity', () => {
  const chat = child(); delete chat.chatCommandVersion; delete chat.agentConversation; delete chat.agentExecution;
  chat.agentRequestSummary = [{ requestId: 'raw-approval', kind: 'approval' }];
  const rows = snapshot(chat, { mainTurns: [{ chatId: chat.id, phase: 'tools', startedAtMs: 100, modelId: 'actual-model', workAgentLabel: 'Build' }] });
  assert.equal(rows.length, 1); assert.equal(rows[0].kind, 'main_turn'); assert.equal(rows[0].status, 'pending_approval');
  assert.deepEqual(rows[0].requestIds, ['raw-approval']); assert.equal(countRunningAgentRows(rows), 0);
  const current = buildActivityFeed({ chats: [chat], live: rows, notifications: [], pendingChatIds: new Set([chat.id]), workspacePath: '/project' });
  assert.equal(current.attention[0].requestId, 'raw-approval'); assert.equal(current.attention[0].requestKind, 'approval');
  assert.equal(chat.chatCommandVersion, undefined);
});
