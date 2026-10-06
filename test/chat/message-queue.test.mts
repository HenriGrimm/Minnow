import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';
import {
  enqueueComposerMessage,
  ensurePendingMessageQueue,
  flushPendingMessageQueue,
  getPendingMessageQueueCount,
  pushQueuedMessageNow,
  removeQueuedMessage,
  setPendingMessageQueueChangedListener,
  updateQueuedMessage,
} from '../../src/chat/message-queue.ts';
// Circular import regression: composer UI must not TDZ-crash message-queue init.
import '../../src/ui/composer-message-queue.ts';
import {
  flushScheduledSessionSaveForTests,
  setSessionStateForTests,
  createEmptyChatObject,
} from '../../src/state/sessions.ts';
import { setStreaming, setChatAbort } from '../../src/app-state.ts';
import { beginChatTurnSetup, endChatTurnSetup } from '../../src/chat/chat-turn-guard.ts';

const FIXED_CHAT_ID = '11111111-1111-1111-1111-111111111111';
const FIXED_QUEUE_ID = '22222222-2222-2222-2222-222222222222';
const QUEUE_TEXT = 'hello';
const QUEUE_TEXT_TWO = 'follow up';

function seedChat(): ReturnType<typeof createEmptyChatObject> {
  const chat = createEmptyChatObject('m1');
  chat.id = FIXED_CHAT_ID;
  chat.modelId = 'test-model';
  setSessionStateForTests({
    version: 3,
    activeId: chat.id,
    sidebarCollapsed: false,
    chats: [chat],
  });
  return chat;
}

describe('message-queue helpers', () => {
  beforeEach(() => {
    const window = new Window();
    globalThis.document = window.document;
    globalThis.HTMLElement = window.HTMLElement;
  });

  afterEach(() => {
    setStreaming(false);
    setChatAbort(FIXED_CHAT_ID, null);
    endChatTurnSetup(FIXED_CHAT_ID);
    flushScheduledSessionSaveForTests();
    setPendingMessageQueueChangedListener(null);
    setSessionStateForTests(null);
  });

  test('ensurePendingMessageQueue validates persisted rows', () => {
    const items = ensurePendingMessageQueue([
      { id: FIXED_QUEUE_ID, text: QUEUE_TEXT, createdAt: 1 },
      { id: 'bad', text: '  ', createdAt: 2 },
    ]);
    assert.deepEqual(items, [{ id: FIXED_QUEUE_ID, text: QUEUE_TEXT, createdAt: 1 }]);
  });

  test('enqueueComposerMessage appends follow-ups', () => {
    const chat = seedChat();
    let notified = 0;
    setPendingMessageQueueChangedListener(() => {
      notified += 1;
    });
    assert.equal(enqueueComposerMessage(chat, QUEUE_TEXT), true);
    assert.equal(enqueueComposerMessage(chat, QUEUE_TEXT_TWO), true);
    assert.equal(getPendingMessageQueueCount(chat), 2);
    assert.equal(chat.pendingMessageQueue?.[0]?.text, QUEUE_TEXT);
    assert.equal(chat.pendingMessageQueue?.[1]?.text, QUEUE_TEXT_TWO);
    assert.equal(notified, 2);
    setPendingMessageQueueChangedListener(null);
  });

  test('removeQueuedMessage deletes one item', () => {
    const chat = seedChat();
    enqueueComposerMessage(chat, QUEUE_TEXT);
    const id = chat.pendingMessageQueue?.[0]?.id;
    assert.ok(id);
    let notified = 0;
    setPendingMessageQueueChangedListener(() => {
      notified += 1;
    });
    assert.equal(removeQueuedMessage(chat, id), true);
    assert.equal(getPendingMessageQueueCount(chat), 0);
    assert.equal(chat.pendingMessageQueue, undefined);
    assert.equal(notified, 1);
  });

  test('updateQueuedMessage edits text in place', () => {
    const chat = seedChat();
    enqueueComposerMessage(chat, QUEUE_TEXT);
    const id = chat.pendingMessageQueue?.[0]?.id;
    assert.ok(id);
    assert.equal(updateQueuedMessage(chat, id, 'updated text'), true);
    assert.equal(chat.pendingMessageQueue?.[0]?.text, 'updated text');
  });

  test('pushQueuedMessageNow promotes to steer while streaming', () => {
    const chat = seedChat();
    enqueueComposerMessage(chat, QUEUE_TEXT);
    const id = chat.pendingMessageQueue?.[0]?.id;
    assert.ok(id);
    setStreaming(true, chat.id);
    const ok = pushQueuedMessageNow(chat, id);
    assert.equal(ok, 'sent');
    assert.equal(getPendingMessageQueueCount(chat), 0);
    assert.equal(chat.pendingSteerMessage, QUEUE_TEXT);
  });

  test('pushQueuedMessageNow promotes to steer during turn setup before streaming flag', () => {
    const chat = seedChat();
    enqueueComposerMessage(chat, QUEUE_TEXT);
    const id = chat.pendingMessageQueue?.[0]?.id;
    assert.ok(id);
    assert.equal(beginChatTurnSetup(chat.id), true);
    setChatAbort(chat.id, new AbortController());
    const ok = pushQueuedMessageNow(chat, id);
    assert.equal(ok, 'sent');
    assert.equal(chat.pendingSteerMessage, QUEUE_TEXT);
  });

  test('queued /compact stays deferred instead of becoming model-visible steer text', () => {
    const chat = seedChat();
    enqueueComposerMessage(chat, '/compact keep the API decisions');
    const id = chat.pendingMessageQueue?.[0]?.id;
    assert.ok(id);
    setStreaming(true, chat.id);

    const result = pushQueuedMessageNow(chat, id);

    assert.equal(result, 'deferred');
    assert.equal(chat.pendingMessageQueue?.[0]?.text, '/compact keep the API decisions');
    assert.equal(chat.pendingSteerMessage, undefined);
    assert.equal(chat.history.some((row) => row.role === 'user' && row.content === '/compact keep the API decisions'), false);
  });

  test('flush dispatches queued /compact locally after the turn', async () => {
    const chat = seedChat();
    const activeChat = createEmptyChatObject('m1');
    activeChat.id = '33333333-3333-3333-3333-333333333333';
    setSessionStateForTests({
      version: 3,
      activeId: activeChat.id,
      sidebarCollapsed: false,
      chats: [activeChat, chat],
    });
    for (let index = 0; index < 4; index += 1) {
      chat.history.push({ role: 'user', content: `request ${index}` });
      chat.history.push({ role: 'assistant', content: `answer ${index}` });
    }
    enqueueComposerMessage(chat, '/compact keep the API decisions');

    await flushPendingMessageQueue(chat);

    assert.equal(getPendingMessageQueueCount(chat), 0);
    assert.equal(chat.history.some((row) => row.role === 'user' && row.content === '/compact keep the API decisions'), false);
    const notice = chat.history.at(-1);
    assert.equal(notice?.role, 'context');
    if (notice?.role === 'context') {
      assert.equal(notice.compaction?.trigger, 'manual');
      assert.match(notice.compaction?.summary ?? '', /keep the API decisions/);
    }
  });

  test('flush restores a follow-up when another turn has already claimed the chat', async () => {
    const chat = seedChat();
    enqueueComposerMessage(chat, QUEUE_TEXT);
    assert.equal(beginChatTurnSetup(chat.id), true);

    await flushPendingMessageQueue(chat);

    assert.equal(getPendingMessageQueueCount(chat), 1);
    assert.equal(chat.pendingMessageQueue?.[0]?.text, QUEUE_TEXT);
  });
});
