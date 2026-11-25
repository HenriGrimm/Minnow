import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';
import {
  installHappyDomGlobals,
  teardownHappyDomAsync,
} from '../os/dom-helpers.mts';
import { resetInstancesForTests } from '../../src/os/instances.ts';

const appState = await import('../../src/app-state.ts');
const { setSessionStateForTests, createEmptyChatObject, EXPERT_LAB_CHAT_ID } =
  await import('../../src/state/sessions.ts');
const {
  getStreamingChatId,
  isActiveChatStreaming,
  isChatStreaming,
  isBackgroundStreamBlockingSend,
  isStreamDomVisible,
} = await import('../../src/chat/streaming-state.ts');

/** @type {import('happy-dom').Window | undefined} */
let win;

beforeEach(() => {
  win = new Window();
  installHappyDomGlobals(win);
  resetInstancesForTests();
});

afterEach(async () => {
  appState.setStreaming(false);
  appState.setExpertLabPageOpen(false);
  resetInstancesForTests();
  setSessionStateForTests(null);
  if (win) {
    await teardownHappyDomAsync(win);
    win = undefined;
  }
});

function seedTwoChats(activeId) {
  const a = createEmptyChatObject('');
  a.id = 'chat-a';
  a.name = 'Chat A';
  const b = createEmptyChatObject('');
  b.id = 'chat-b';
  b.name = 'Chat B';
  setSessionStateForTests({
    version: 2,
    activeId,
    sidebarCollapsed: false,
    chats: [a, b],
  });
  return { a, b };
}

describe('streaming-state helpers', () => {
  test('getStreamingChatId is null when idle', () => {
    seedTwoChats('chat-a');
    assert.equal(getStreamingChatId(), null);
    assert.equal(isChatStreaming('chat-a'), false);
    assert.equal(isActiveChatStreaming(), false);
  });

  test('isChatStreaming tracks streamingChatId', () => {
    seedTwoChats('chat-b');
    appState.setStreaming(true, 'chat-a');
    assert.equal(getStreamingChatId(), 'chat-a');
    assert.equal(isChatStreaming('chat-a'), true);
    assert.equal(isChatStreaming('chat-b'), false);
    assert.equal(isActiveChatStreaming(), false);
  });

  test('isActiveChatStreaming when active matches stream', () => {
    seedTwoChats('chat-a');
    appState.setStreaming(true, 'chat-a');
    assert.equal(isActiveChatStreaming(), true);
    assert.equal(isStreamDomVisible('chat-a'), true);
    assert.equal(isStreamDomVisible('chat-b'), false);
  });

  test('isBackgroundStreamBlockingSend allows concurrent sends', () => {
    seedTwoChats('chat-b');
    appState.setStreaming(true, 'chat-a');
    assert.equal(isBackgroundStreamBlockingSend(), false);
    assert.equal(isActiveChatStreaming(), false);
  });

  test('expert thread streams in chat shell when Experts hub is closed', () => {
    const lab = createEmptyChatObject('');
    lab.id = EXPERT_LAB_CHAT_ID;
    lab.kind = 'expert-lab';
    setSessionStateForTests({
      version: 2,
      activeId: EXPERT_LAB_CHAT_ID,
      sidebarCollapsed: false,
      chats: [lab],
    });
    appState.setExpertLabPageOpen(true);
    appState.setStreaming(true, EXPERT_LAB_CHAT_ID);
    assert.equal(isStreamDomVisible(EXPERT_LAB_CHAT_ID), false);
    appState.setExpertLabPageOpen(false);
    assert.equal(isStreamDomVisible(EXPERT_LAB_CHAT_ID), true);
  });
});
