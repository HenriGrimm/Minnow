import '../tools/install-dom-before-imports.mts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createEmptyChatObject, resetSessionPersistenceForTests, setSessionStateForTests, sessionState, applySharedChatFrame } from '../../src/state/sessions.ts';
import { startManagedChatBridge } from '../../src/chat/managed-chat-bridge.ts';
import { subscribeManagedChatMetadata } from '../../src/chat/managed-chat-view.ts';
import { createManagedChatNotificationProducer } from '../../src/notifications/managed-chat.ts';
import type { PushNotificationInput } from '../../src/notifications/types.ts';

afterEach(() => { resetSessionPersistenceForTests(); setSessionStateForTests(null); });
test('reconnect recovers an offline completion and an incoming live notice supersedes a pending activity read', async t => {
  const parent = createEmptyChatObject('model'), child = createEmptyChatObject('model');
  child.chatCommandVersion = 1; child.agentExecution = { executionId: 'first', status: 'running' };
  setSessionStateForTests({ version: 6, activeId: parent.id, sidebarCollapsed: false, chats: [parent, child] });
  let resolve!: (response: Response) => void;
  const requests: string[] = [];
  t.mock.method(globalThis, 'fetch', (url: string) => {
    requests.push(url); return new Promise<Response>(done => { resolve = done; });
  });
  const source = { onopen: null as any, onmessage: null as any, close() {} };
  const stop = startManagedChatBridge({ receive: async () => {}, reconnect() {} }, () => {}, { createSource: () => source });
  t.after(stop);
  const settled = { chatId: child.id, fields: { agentExecution: { executionId: 'first', status: 'completed' } } };
  source.onopen();
  source.onmessage({ data: JSON.stringify({ kind: 'baseline-end' }) });
  assert.deepEqual(requests, [`/api/chats/${child.id}?view=activity`]);
  resolve(Response.json(settled)); await new Promise(done => setImmediate(done));
  assert.equal(child.agentExecution?.status, 'completed');
  child.agentExecution!.status = 'running'; source.onopen();
  source.onmessage({ data: JSON.stringify({ kind: 'baseline-end' }) });
  source.onmessage({ data: JSON.stringify({ kind: 'chat-changed', chatId: child.id,
    fields: { agentExecution: { executionId: 'second', status: 'running' } } }) });
  resolve(Response.json(settled)); await new Promise(done => setImmediate(done));
  assert.deepEqual(child.agentExecution, { executionId: 'second', status: 'running' });
});
test('a first background notice creates a child under its parent and leaves its history available to load', async t => {
  const parent = createEmptyChatObject('model');
  setSessionStateForTests({ version: 6, activeId: parent.id, sidebarCollapsed: false, chats: [parent] });
  const source = { onopen: null as any, onmessage: null as any, close() {} };
  t.after(startManagedChatBridge({ receive: async () => {}, reconnect() {} }, () => {}, { createSource: () => source }));
  source.onopen();
  source.onmessage({ data: JSON.stringify({ kind: 'chat-changed', chatId: 'new-child', fields: { name: 'Inspect files', chatCommandVersion: 1,
    agentConversation: { version: 1, childChatId: 'new-child', parentChatId: parent.id, rootChatId: parent.id, journalOwnerId: parent.id,
      origin: 'delegated', createdAt: 1, capabilities: { canSend: true, canStop: true, canChooseModel: true } } } }) });
  await new Promise(done => setImmediate(done));
  const child = sessionState!.chats.find(chat => chat.id === 'new-child')!;
  assert.equal(child.name, 'Inspect files');
  assert.equal(child.agentConversation?.parentChatId, parent.id);
  assert.equal(child.historyLoaded, false);
  assert.equal(sessionState!.activeId, parent.id);
});

test('actual bridge honors explicit replay baselines and a first genuinely new raw request alerts once', async () => {
  const chat = createEmptyChatObject('model'); chat.id = 'raw';
  setSessionStateForTests({ version: 6, activeId: chat.id, sidebarCollapsed: false, chats: [chat] });
  const notices: PushNotificationInput[] = [], source = { onopen: null as any, onmessage: null as any, closeCount: 0, close() { this.closeCount++; } };
  const stopProducer = createManagedChatNotificationProducer({ chats: () => sessionState!.chats, subscribe: subscribeManagedChatMetadata,
    push: input => notices.push(input), pushOutcome: input => notices.push(input) });
  let reconnects = 0;
  const stopBridge = startManagedChatBridge({ receive: async frame => { applySharedChatFrame(frame.chatId, frame.fields); }, reconnect: () => { reconnects++; } }, () => {}, { createSource: () => source });
  const emit = async (message: any) => { source.onmessage({ data: JSON.stringify(message) }); await new Promise(done => setImmediate(done)); };
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
