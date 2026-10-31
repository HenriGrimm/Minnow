import '../tools/install-dom-before-imports.mts';

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';
import {
  clearPendingSteer,
  consumePendingSteer,
  enqueueSteerMessage,
  formatSteerHistoryContent,
} from '../../src/chat/steer-message.ts';
import { renderChatFromHistory } from '../../src/ui/messages.ts';
import { createChatRoundBoundary } from '../../src/chat/run-turn-chat.ts';
import {
  flushScheduledSessionSaveForTests,
  setSessionStateForTests,
  createEmptyChatObject,
} from '../../src/state/sessions.ts';

const FIXED_CHAT_ID = '11111111-1111-1111-1111-111111111111';
const STEER_TEXT = 'Use pnpm not npm';

function seedChat(): ReturnType<typeof createEmptyChatObject> {
  const chat = createEmptyChatObject('m1');
  chat.id = FIXED_CHAT_ID;
  setSessionStateForTests({
    version: 3,
    activeId: chat.id,
    sidebarCollapsed: false,
    chats: [chat],
  });
  return chat;
}

describe('steer-message helpers', () => {
  beforeEach(() => {
    const window = new Window();
    globalThis.document = window.document;
    globalThis.HTMLElement = window.HTMLElement;
  });

  afterEach(() => {
    flushScheduledSessionSaveForTests();
    setSessionStateForTests(null);
  });

  test('formatSteerHistoryContent trims whitespace', () => {
    assert.equal(formatSteerHistoryContent(`  ${STEER_TEXT}  `), STEER_TEXT);
  });

  test('consumePendingSteer no-op when pending empty', () => {
    const chat = seedChat();
    const result = consumePendingSteer(chat, { renderDom: false });
    assert.equal(result.consumed, false);
    assert.equal(chat.history.length, 0);
  });

  test('consumePendingSteer pushes user row with steer flag and clears pending', () => {
    const chat = seedChat();
    chat.pendingSteerMessage = STEER_TEXT;
    const result = consumePendingSteer(chat, { renderDom: false });
    assert.equal(result.consumed, true);
    assert.equal(result.content, STEER_TEXT);
    assert.equal(chat.history.length, 1);
    assert.equal(chat.history[0]?.role, 'user');
    assert.equal((chat.history[0] as { steer?: boolean }).steer, true);
    assert.equal(chat.pendingSteerMessage, undefined);
  });

  test('enqueueSteerMessage preserves successive corrections in send order', () => {
    const chat = seedChat();
    assert.equal(enqueueSteerMessage(chat, 'first'), true);
    assert.equal(enqueueSteerMessage(chat, STEER_TEXT), true);
    assert.equal(chat.pendingSteerMessage, `first\n\n${STEER_TEXT}`);
    const result = consumePendingSteer(chat, { renderDom: false });
    assert.equal(result.content, `first\n\n${STEER_TEXT}`);
    assert.equal(chat.pendingSteerMessage, undefined);
  });

  test('clearPendingSteer removes queued text', () => {
    const chat = seedChat();
    chat.pendingSteerMessage = STEER_TEXT;
    clearPendingSteer(chat);
    assert.equal(chat.pendingSteerMessage, undefined);
  });

  test('steer flag survives a history rebuild (reload chip)', () => {
    const chat = seedChat();
    chat.pendingSteerMessage = STEER_TEXT;
    consumePendingSteer(chat, { renderDom: false });
    assert.equal((chat.history[0] as { steer?: boolean }).steer, true);

    const area = document.createElement('div');
    area.id = 'chatArea';
    document.body.appendChild(area);
    renderChatFromHistory(chat);
    const wrap = area.querySelector('.msg.user, .msg');
    assert.ok(wrap, 'user row must render');
    assert.ok(
      wrap?.classList.contains('msg--steered') || wrap?.querySelector('.msg-steer-chip'),
      'steer chip must survive renderChatFromHistory',
    );
  });

  test('createChatRoundBoundary returns splice rows and syncs the queue', () => {
    const chat = seedChat();
    chat.pendingSteerMessage = STEER_TEXT;
    // consumePendingSteer paints a live bubble when the stream DOM is
    // "visible"; give it a transcript mount so appendBubble cannot miss #chatArea.
    const area = document.createElement('div');
    area.id = 'chatArea';
    document.body.appendChild(area);
    const hook = createChatRoundBoundary(chat);
    const rows = hook();
    assert.ok(rows);
    assert.equal(rows[0]?.role, 'user');
    assert.equal(rows[0]?.content, STEER_TEXT);
    assert.equal(chat.pendingSteerMessage, undefined);
    assert.equal((chat.history[0] as { steer?: boolean }).steer, true);
    assert.equal(hook(), null);
  });
});
