/**
 * MIN-206 — /followup is intercepted in the composer before the turn runs.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';
import {
  installHappyDomGlobals,
  setupMinimalComposerDom,
  teardownHappyDomAsync,
} from '../os/dom-helpers.mts';
import { defaultSessionState } from '../../src/config/defaults.ts';
import {
  createEmptyChatObject,
  flushScheduledSessionSaveForTests,
  getFollowupChain,
  setSessionStateForTests,
} from '../../src/state/sessions.ts';
import { getPendingMessageQueue } from '../../src/chat/message-queue.ts';
import { setStreaming } from '../../src/app-state.ts';
import { sendMessageWithTools } from '../../src/chat/messaging.ts';
import { stopFollowupRunner } from '../../src/chat/followup/runner.ts';
import type { Chat } from '../../src/types.ts';

let win: Window | undefined;
const originalFetch = globalThis.fetch;

function setup(options: { streaming?: boolean } = {}): Chat {
  win = new Window();
  installHappyDomGlobals(win, {
    fetch: async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
  });
  setupMinimalComposerDom(document);

  const chat = createEmptyChatObject('m1', 'C:/ws/min-206');
  chat.id = 'root';
  chat.modeId = 'build';
  chat.history = [{ role: 'user', content: 'fix the build' }];
  chat.historyLoaded = true;

  setSessionStateForTests({
    ...defaultSessionState(),
    activeId: chat.id,
    chats: [chat],
  });

  if (options.streaming) setStreaming(true, chat.id);
  return chat;
}

function setComposerText(text: string): HTMLTextAreaElement {
  const input = document.getElementById('msgInput') as HTMLTextAreaElement;
  input.value = text;
  return input;
}

afterEach(async () => {
  stopFollowupRunner();
  setStreaming(false);
  flushScheduledSessionSaveForTests();
  if (win) {
    await teardownHappyDomAsync(win);
    win = undefined;
  }
  setSessionStateForTests(null);
  globalThis.fetch = originalFetch;
  document.body.innerHTML = '';
});

describe('/followup composer interception', () => {
  test('arms the chain, clears the composer, and sends nothing', async () => {
    const chat = setup();
    const input = setComposerText('/followup 2 review the build');
    const historyBefore = chat.history.length;

    await sendMessageWithTools();

    const chain = getFollowupChain(chat);
    assert.equal(chain?.total, 2);
    assert.equal(chain?.promptText, 'review the build');
    assert.equal(chat.history.length, historyBefore);
    assert.equal(input.value, '');
    assert.equal(getPendingMessageQueue(chat).length, 0);
  });

  test('arms even while the chat is still streaming', async () => {
    const chat = setup({ streaming: true });
    setComposerText('/followup review the build');

    await sendMessageWithTools();

    assert.equal(getFollowupChain(chat)?.total, 1);
    assert.equal(getPendingMessageQueue(chat).length, 0);
    assert.equal(chat.history.some((row) => row.content === '/followup review the build'), false);
  });

  test('leaves ordinary text on the normal path', async () => {
    const chat = setup({ streaming: true });
    setComposerText('keep going with the refactor');

    await sendMessageWithTools();

    assert.equal(getFollowupChain(chat), null);
    assert.equal(getPendingMessageQueue(chat).length, 1);
    assert.equal(getPendingMessageQueue(chat)[0]?.text, 'keep going with the refactor');
  });
});
