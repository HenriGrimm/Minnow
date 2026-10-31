import '../tools/install-dom-before-imports.mts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createEmptyChatObject, resetSessionPersistenceForTests, setSessionStateForTests, sessionState, applySharedChatFrame } from '../../src/state/sessions.ts';
import { startManagedChatBridge } from '../../src/chat/managed-chat-bridge.ts';
import { subscribeManagedChatMetadata } from '../../src/chat/managed-chat-view.ts';
import { createManagedChatNotificationProducer } from '../../src/notifications/managed-chat.ts';
import type { PushNotificationInput } from '../../src/notifications/types.ts';

afterEach(() => { resetSessionPersistenceForTests(); setSessionStateForTests(null); });
test('actual bridge honors explicit replay baselines and a first genuinely new raw request alerts once', async () => {
  const chat = createEmptyChatObject('model'); chat.id = 'raw';
  setSessionStateForTests({ version: 6, activeId: chat.id, sidebarCollapsed: false, chats: [chat] });
  const notices: PushNotificationInput[] = [], source = { onopen: null as any, onmessage: null as any, closeCount: 0, close() { this.closeCount++; } };
  const stopProducer = createManagedChatNotificationProducer({ chats: () => sessionState!.chats, subscribe: subscribeManagedChatMetadata,
    push: input => notices.push(input), pushOutcome: input => notices.push(input) });
  let reconnects = 0;
  const stopBridge = startManagedChatBridge({ receive: async frame => { applySharedChatFrame(frame.chatId, frame.fields); }, reconnect: () => { reconnects++; } }, () => {}, { createSource: () => source });
  const emit = async (message: any) => { source.onmessage({ data: JSON.stringify(message) }); await Promise.resolve(); await Promise.resolve(); };
  source.onopen(); assert.equal(reconnects, 1);
  await emit({ kind: 'chat-changed', chatId: 'raw', fields: { agentRequestSummary: [{ requestId: 'new', kind: 'approval' }] } });
  assert.deepEqual(notices.map(row => row.dedupeKey), ['request:new']);
  source.onopen();
  await emit({ kind: 'chat-changed', baseline: true, chatId: 'raw', fields: { agentRequestSummary: [{ requestId: 'new', kind: 'approval' }, { requestId: 'existing-replay', kind: 'question' }] } });
  assert.equal(notices.length, 1);
  await emit({ kind: 'frame', baseline: true, frame: { chatId: 'raw', fields: { chatCommandVersion: 1, agentExecution: { executionId: 'old', status: 'completed' } } } });
  assert.equal(notices.length, 1);
  await emit({ kind: 'frame', frame: { chatId: 'raw', fields: { agentExecution: { executionId: 'live', status: 'running' } } } });
  await emit({ kind: 'frame', frame: { chatId: 'raw', fields: { agentExecution: { executionId: 'live', status: 'failed' } } } });
  assert.deepEqual(notices.map(row => row.dedupeKey), ['request:new', 'execution:live']);
  stopBridge(); stopProducer(); assert.equal(source.closeCount, 1);
  await emit({ kind: 'frame', frame: { chatId: 'raw', fields: { agentExecution: { executionId: 'late', status: 'failed' } } } });
  assert.equal(notices.length, 2);
});
