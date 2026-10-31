import '../tools/install-dom-before-imports.mts';
import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import { applySharedChatAttention, applySharedChatFrame, createEmptyChatObject, getSessionDirtyTrackingForTests,
  captureDirtyTrackingShadowForTests, markChatDirty, resetSessionPersistenceForTests, saveSessionsNow,
  setDirtyTrackingVerifierForcedForTests, setSessionStateForTests } from '../../src/state/sessions.ts';
import { streamingChatIds } from '../../src/app-state.ts';
import { acknowledgeManagedChatActivity } from '../../src/chat/managed-chat-client.ts';
import { acknowledgeChatViewed, acknowledgeObservedManagedActivity } from '../../src/notifications/acknowledge.ts';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; streamingChatIds.clear(); resetSessionPersistenceForTests(); setSessionStateForTests(null); });
test('raw attention applies during local streaming without touching its dirty transcript, draft, execution or stale answer bodies', () => {
  const chat = createEmptyChatObject('model'); chat.id = 'raw'; chat.history = [{ role: 'user', content: 'Original' }];
  chat.composerDraft = { text: 'Keep my draft' } as any;
  chat.agentExecution = { executionId: 'existing-view', status: 'running' };
  chat.agentRequests = [{ requestId: 'old-answer' }, { requestId: 'keep-request' }] as any;
  setSessionStateForTests({ version: 6, activeId: chat.id, sidebarCollapsed: false, chats: [chat] });
  markChatDirty(chat); streamingChatIds.add(chat.id);
  const history = chat.history, draft = chat.composerDraft;
  assert.equal(applySharedChatFrame(chat.id, { name: 'Forged full snapshot' }), undefined);
  applySharedChatAttention(chat.id, { agentRequestSummary: [{ requestId: 'keep-request', kind: 'approval' }],
    history: [], name: 'Ignored', agentExecution: null });
  assert.deepEqual(chat.agentRequestSummary, [{ requestId: 'keep-request', kind: 'approval' }]);
  assert.deepEqual(chat.agentRequests?.map(request => request.requestId), ['keep-request']);
  assert.equal(chat.history, history); assert.equal(chat.composerDraft, draft); assert.equal(chat.agentExecution?.executionId, 'existing-view');
  assert.ok(getSessionDirtyTrackingForTests().dirtyChatIds.includes(chat.id));
  applySharedChatAttention(chat.id, { agentRequestSummary: [] }); assert.deepEqual(chat.agentRequests, []);
  assert.ok(getSessionDirtyTrackingForTests().dirtyChatIds.includes(chat.id));
});

test('managed acknowledgement posts only the observed canonical cursor and preserves server rejection', async () => {
  const cursor = { messageSeq: 3, executionId: 'execution' };
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), '/api/chats/child/ack'); assert.equal(options?.method, 'POST');
    assert.deepEqual(JSON.parse(String(options?.body)), cursor);
    return Response.json({ chatId: 'child', activity: { unread: false, agentActivityCursor: cursor } });
  };
  assert.equal((await acknowledgeManagedChatActivity('child', cursor)).unread, false);
  globalThis.fetch = async () => Response.json({ error: { message: 'No longer in this project' } }, { status: 403 });
  await assert.rejects(acknowledgeManagedChatActivity('child', cursor), /No longer in this project/);
});

test('opening a managed chat deduplicates its observed acknowledgement and preserves dirty history', async () => {
  const chat = createEmptyChatObject('model'); chat.id = 'managed'; chat.chatCommandVersion = 1;
  chat.history = [{ role: 'user', content: 'Keep local state' }]; chat.unread = true; chat.turnError = true;
  chat.agentActivityCursor = { messageSeq: 3, executionId: 'settled' };
  chat.agentExecution = { executionId: 'settled', status: 'failed', updatedAt: 1000 };
  setSessionStateForTests({ version: 6, activeId: chat.id, sidebarCollapsed: false, chats: [chat] }); markChatDirty(chat);
  let complete!: (value: Response) => void, calls = 0;
  globalThis.fetch = async () => { calls++; return new Promise<Response>(resolve => { complete = resolve; }); };
  acknowledgeChatViewed(chat.id); acknowledgeChatViewed(chat.id);
  assert.equal(calls, 1); assert.equal(chat.unread, true);
  const pending = acknowledgeObservedManagedActivity(chat.id, chat.agentActivityCursor);
  complete(Response.json({ chatId: chat.id, activity: { agentActivityCursor: chat.agentActivityCursor, unread: false, turnError: false } }));
  await pending;
  assert.equal(chat.unread, false); assert.equal(chat.turnError, false);
  assert.equal(chat.history[0].content, 'Keep local state');
  assert.ok(getSessionDirtyTrackingForTests().dirtyChatIds.includes(chat.id));
  await acknowledgeObservedManagedActivity(chat.id, chat.agentActivityCursor);
  acknowledgeChatViewed(chat.id);
  assert.equal(calls, 1, 'the acknowledgement summary cannot cause a feedback loop');
});

test('a late managed acknowledgement cannot clear newer errors or replace the current execution', async () => {
  const chat = createEmptyChatObject('model'); chat.id = 'late'; chat.chatCommandVersion = 1;
  chat.agentActivityCursor = { messageSeq: -1, executionId: null };
  chat.agentExecution = { executionId: 'active', status: 'running', updatedAt: 1000 };
  setSessionStateForTests({ version: 6, activeId: chat.id, sidebarCollapsed: false, chats: [chat] });
  let complete!: (value: Response) => void;
  globalThis.fetch = async () => new Promise<Response>(resolve => { complete = resolve; });
  const cursor = { ...chat.agentActivityCursor };
  const pending = acknowledgeObservedManagedActivity(chat.id, cursor);
  chat.agentActivityCursor = { messageSeq: -1, executionId: 'active' };
  chat.agentExecution = { executionId: 'active', status: 'failed', updatedAt: 2000 }; chat.unread = true; chat.turnError = true;
  complete(Response.json({ chatId: chat.id, activity: { agentActivityCursor: cursor, unread: false, turnError: false, agentExecution: null } }));
  await pending;
  assert.equal(chat.unread, true); assert.equal(chat.turnError, true); assert.equal(chat.agentExecution.status, 'failed');
});

test('server attention and acknowledgement cannot trigger a later unmarked-mutation full save', () => {
  const chat = createEmptyChatObject('model'); chat.id = 'shadow'; chat.chatCommandVersion = 1;
  setSessionStateForTests({ version: 6, activeId: chat.id, sidebarCollapsed: false, chats: [chat] });
  setDirtyTrackingVerifierForcedForTests(true); captureDirtyTrackingShadowForTests();
  const warn = console.warn, warnings: string[] = []; console.warn = (...args) => { warnings.push(args.map(String).join(' ')); };
  try {
    applySharedChatAttention(chat.id, { agentRequestSummary: [{ requestId: 'question', kind: 'question' }], unread: false, turnError: false,
      agentRequests: [{ version: 1, requestId: 'question', chatId: chat.id, executionId: 'execution', toolCallId: 'call', kind: 'question',
        state: 'pending', createdAt: 1000, title: 'Choose', presentation: { question: 'Which?' } }] });
    saveSessionsNow();
    assert.equal(warnings.some(line => line.includes('without touchChat')), false);
    captureDirtyTrackingShadowForTests();
    chat.name = 'A real unmarked local edit'; saveSessionsNow();
    assert.equal(warnings.some(line => line.includes('without touchChat')), true, 'ordinary local mutation verification remains active');
  } finally { console.warn = warn; }
});
