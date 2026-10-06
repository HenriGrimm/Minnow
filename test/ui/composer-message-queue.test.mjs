import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Window } from 'happy-dom';

const { resolveComposerQueueMount, syncComposerMessageQueue } = await import(
  '../../src/ui/composer-message-queue.ts'
);
const { setSessionStateForTests, createEmptyChatObject } = await import(
  '../../src/state/sessions.ts'
);
const { enqueueComposerMessage, removeQueuedMessage } = await import('../../src/chat/message-queue.ts');
const appState = await import('../../src/app-state.ts');

const FIXED_CHAT_ID = '11111111-1111-1111-1111-111111111111';
const QUEUE_TEXT = 'hello';

function setupCodeComposerDom() {
  const window = new Window();
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;

  const chatArea = document.createElement('div');
  chatArea.id = 'chatArea';
  document.body.appendChild(chatArea);

  const composer = document.createElement('div');
  composer.className = 'input-bar-composer';

  const inputRow = document.createElement('div');
  inputRow.className = 'input-row';

  const input = document.createElement('textarea');
  input.id = 'msgInput';
  inputRow.appendChild(input);
  composer.appendChild(inputRow);
  document.body.appendChild(composer);

  const hiddenChat = document.createElement('div');
  hiddenChat.className = 'chat-app-composer-inner';
  hiddenChat.style.display = 'none';
  document.body.appendChild(hiddenChat);

  return { composer, inputRow, input, hiddenChat, chatArea };
}

describe('composer message queue mount', () => {
  test('resolveComposerQueueMount targets the active code composer input row', () => {
    const { input, inputRow } = setupCodeComposerDom();
    const mount = resolveComposerQueueMount(input);
    assert.ok(mount);
    assert.equal(mount.host.className, 'input-bar-composer');
    assert.equal(mount.before, inputRow);
  });

  test('syncComposerMessageQueue mounts above the active composer, not hidden chat shell', () => {
    const { input, inputRow, hiddenChat } = setupCodeComposerDom();
    const chat = createEmptyChatObject('m1');
    chat.id = FIXED_CHAT_ID;
    setSessionStateForTests({
      version: 3,
      activeId: chat.id,
      sidebarCollapsed: false,
      chats: [chat],
    });
    appState.setStreaming(true, chat.id);
    enqueueComposerMessage(chat, QUEUE_TEXT);

    syncComposerMessageQueue();

    const queue = document.getElementById('composerMessageQueue');
    assert.ok(queue);
    assert.equal(queue.classList.contains('hidden'), false);
    assert.equal(queue.parentElement?.className, 'input-bar-composer');
    assert.equal(queue.nextElementSibling, inputRow);
    assert.equal(hiddenChat.contains(queue), false);
    assert.match(queue.textContent ?? '', /1 Queued/);
    assert.match(queue.textContent ?? '', /hello/);

    assert.equal(document.querySelector('#queuedTranscript'), null);
    assert.equal(document.querySelectorAll('.msg--queued').length, 0);
    assert.equal(chat.history.length, 0);
    assert.equal(queue.querySelectorAll('button[aria-label]').length, 3);

    setSessionStateForTests(null);
    appState.setStreaming(false);
  });

  test('pending messages stay out of the transcript and clear from the composer when removed', () => {
    const { chatArea } = setupCodeComposerDom();
    const chat = createEmptyChatObject('m1');
    chat.id = FIXED_CHAT_ID;
    setSessionStateForTests({
      version: 3,
      activeId: chat.id,
      sidebarCollapsed: false,
      chats: [chat],
    });
    appState.setStreaming(true, chat.id);
    enqueueComposerMessage(chat, QUEUE_TEXT);
    syncComposerMessageQueue();
    assert.equal(chatArea.children.length, 0);
    assert.equal(chat.history.length, 0);
    assert.equal(document.querySelectorAll('.composer-message-queue__item').length, 1);

    removeQueuedMessage(chat, chat.pendingMessageQueue[0].id);
    syncComposerMessageQueue();
    assert.equal(chatArea.children.length, 0);
    const queue = document.getElementById('composerMessageQueue');
    assert.equal(queue.classList.contains('hidden'), true);
    assert.equal(queue.children.length, 0);

    setSessionStateForTests(null);
    appState.setStreaming(false);
  });
});
