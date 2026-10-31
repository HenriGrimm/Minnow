import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Chat } from '../../src/types.ts';
import type { PushNotificationInput } from '../../src/notifications/types.ts';
import { createManagedChatNotificationProducer } from '../../src/notifications/managed-chat.ts';

function fixture() {
  const chat = { id: 'child', name: 'Reviewer', workspacePath: '/project', chatCommandVersion: 1,
    agentExecution: { executionId: 'execution-a', status: 'running' } } as Chat;
  const notices: PushNotificationInput[] = []; let listener: ((id: string, metadata?: { baseline?: boolean }) => void) | undefined;
  const dispose = createManagedChatNotificationProducer({ chats: () => [chat], push: notice => notices.push(notice), pushOutcome: notice => notices.push(notice),
    subscribe: fn => { listener = fn; return () => { listener = undefined; }; } });
  return { chat, notices, dispose, change: (baseline = false) => listener?.('child', { baseline }) };
}
test('one terminal execution transition emits once with child identity while initial/reconnect baselines stay silent', () => {
  const f = fixture(); f.chat.agentExecution!.status = 'completed'; f.change(); f.change();
  assert.equal(f.notices.length, 1); assert.equal(f.notices[0].activityId, 'execution:execution-a'); assert.equal(f.notices[0].dedupeKey, 'execution:execution-a');
  assert.equal(f.notices[0].chatId, 'child'); assert.equal(f.notices[0].kind, 'chat_turn_complete');
  f.chat.agentExecution = { executionId: 'execution-b', status: 'failed' }; f.change(true); f.change(); assert.equal(f.notices.length, 1);
  f.chat.agentExecution = { executionId: 'execution-c', status: 'running' }; f.change(); f.chat.agentExecution.status = 'recovery_required'; f.change();
  assert.equal(f.notices.length, 2); assert.equal(f.notices[1].activityStatus, 'failed'); assert.match(f.notices[1].preview, /recovery/);
  f.dispose(); f.chat.agentExecution = { executionId: 'after-dispose', status: 'failed' }; f.change(); assert.equal(f.notices.length, 2);
});
test('concurrent requests use separate request keys under one execution and never repeat after close or reconnect', () => {
  const f = fixture(); f.chat.agentRequestSummary = [{ requestId: 'a', kind: 'approval' }, { requestId: 'b', kind: 'question' }]; f.change(); f.change();
  assert.deepEqual(f.notices.map(row => row.activityId), ['request:a', 'request:b']);
  assert.equal(f.notices[0].parentActivityId, 'execution:execution-a'); assert.match(f.notices[0].preview, /approval/);
  f.chat.agentRequestSummary = []; f.change(); f.chat.agentRequestSummary = [{ requestId: 'a', kind: 'approval' }]; f.change();
  assert.equal(f.notices.length, 2);
  f.chat.agentRequestSummary.push({ requestId: 'old-baseline', kind: 'question' }); f.change(true); f.change(); assert.equal(f.notices.length, 2);
  f.dispose();
});
test('a raw renderer approval can alert through the same request identity without manufacturing a managed execution', () => {
  const f = fixture(); delete f.chat.chatCommandVersion; delete f.chat.agentExecution; f.change();
  f.chat.agentRequestSummary = [{ requestId: 'raw-approval', kind: 'approval' }]; f.change();
  assert.equal(f.notices.length, 1); assert.equal(f.notices[0].activityId, 'request:raw-approval');
  assert.equal(f.notices[0].parentActivityId, undefined); assert.equal(f.chat.chatCommandVersion, undefined); f.dispose();
});

test('a parent awaiting delegated work never announces overall completion for its ended dispatch turn', () => {
  const f = fixture(); f.chat.agentTaskAttention = { status: 'waiting_for_agents', pendingCount: 2 };
  f.chat.agentExecution!.status = 'completed'; f.change(); assert.equal(f.notices.length, 0);
  delete f.chat.agentTaskAttention; f.change(); assert.equal(f.notices.length, 0, 'clearing obligations does not reannounce the old reply');
  f.chat.agentExecution = { executionId: 'wake-execution', status: 'running' }; f.change();
  f.chat.agentExecution.status = 'completed'; f.change();
  assert.equal(f.notices.length, 1); assert.equal(f.notices[0].activityId, 'execution:wake-execution'); f.dispose();
});
