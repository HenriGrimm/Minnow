/**
 * MIN-793 #2 — a long transcript must not rebuild as one unbroken main-thread task.
 * The switch renders the tail; older rows arrive in idle chunks, prepended above.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';
import {
  installHappyDomGlobals,
  teardownHappyDomAsync,
} from '../os/dom-helpers.mts';

const { setSessionStateForTests, createEmptyChatObject } = await import(
  '../../src/state/sessions.ts'
);
const { resetInstancesForTests } = await import('../../src/os/instances.ts');
const { renderChatFromHistory, cancelChatHistoryBackfill } = await import(
  '../../src/ui/messages.ts'
);
const { initChatScroll } = await import('../../src/ui/chat-scroll.ts');

/** @type {import('happy-dom').Window | undefined} */
let domWindow;

/** Mount a transcript for a chat with `count` user messages. */
function setup(count, chatId) {
  domWindow = new Window();
  installHappyDomGlobals(domWindow);
  resetInstancesForTests();

  const chatArea = document.createElement('div');
  chatArea.id = 'chatArea';
  document.body.appendChild(chatArea);
  initChatScroll();

  const chat = createEmptyChatObject('');
  chat.id = chatId;
  chat.history = Array.from({ length: count }, (_, i) => ({
    role: 'user',
    content: `message ${i}`,
  }));
  setSessionStateForTests({
    version: 2,
    activeId: chat.id,
    sidebarCollapsed: false,
    chats: [chat],
  });
  return { chatArea, chat };
}

/** Let queued idle/rAF chunks drain. */
async function drain() {
  for (let i = 0; i < 40; i += 1) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

function bubbleTexts(chatArea) {
  return [...chatArea.querySelectorAll('.msg.user .msg-bubble')].map((el) => el.textContent);
}

describe('chunked transcript rebuild', { concurrency: false }, () => {
  afterEach(async () => {
    cancelChatHistoryBackfill();
    setSessionStateForTests(null);
    resetInstancesForTests();
    if (domWindow) {
      await teardownHappyDomAsync(domWindow);
      domWindow = undefined;
    }
  });

  test('the switch paints only the tail, then backfills the rest in order', async () => {
    const { chatArea, chat } = setup(80, 'chunked-chat');

    renderChatFromHistory(chat);

    const immediate = bubbleTexts(chatArea);
    assert.ok(
      immediate.length > 0 && immediate.length < 80,
      `switch must not render all 80 rows synchronously (got ${immediate.length})`,
    );
    assert.equal(immediate.at(-1), 'message 79', 'the newest message is what the user looks at');

    await drain();

    const full = bubbleTexts(chatArea);
    assert.equal(full.length, 80);
    assert.equal(full[0], 'message 0', 'older rows land above, in history order');
    assert.equal(full.at(-1), 'message 79');
  });

  test('a short history still renders in one pass', () => {
    const { chatArea, chat } = setup(5, 'short-chat');

    renderChatFromHistory(chat);

    assert.equal(bubbleTexts(chatArea).length, 5);
  });

  test('expensive history rows yield before the fixed chunk limit', (t) => {
    const { chatArea, chat } = setup(80, 'expensive-chat');
    const pending = new Map();
    let id = 0;
    window.requestIdleCallback = (cb) => { pending.set(++id, cb); return id; };
    window.cancelIdleCallback = (key) => { pending.delete(key); };
    renderChatFromHistory(chat);
    const initial = bubbleTexts(chatArea).length;
    let clock = 0;
    t.mock.method(performance, 'now', () => { clock += 10; return clock; });
    const tick = () => {
      const [key, cb] = pending.entries().next().value;
      pending.delete(key);
      cb();
    };
    tick();
    assert.equal(bubbleTexts(chatArea).length, initial + 1, 'a costly row consumes this slice');
    while (pending.size) tick();
    assert.deepEqual(bubbleTexts(chatArea), Array.from({ length: 80 }, (_, i) => `message ${i}`));
  });

  test('switching away abandons the previous chat backfill', async () => {
    const { chatArea, chat } = setup(80, 'abandoned-chat');
    renderChatFromHistory(chat);
    const partial = bubbleTexts(chatArea).length;

    // A second paint owns the transcript now; the first chat's chunks must not land in it.
    const other = createEmptyChatObject('');
    other.id = 'other-chat';
    other.history = [{ role: 'user', content: 'only message' }];
    setSessionStateForTests({
      version: 2,
      activeId: other.id,
      sidebarCollapsed: false,
      chats: [chat, other],
    });
    renderChatFromHistory(other);

    await drain();

    assert.ok(partial < 80);
    assert.deepEqual(bubbleTexts(chatArea), ['only message']);
  });
});
